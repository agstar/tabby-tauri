use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::session::{SessionKind, SessionRegistry, SessionSnapshot, SessionState};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh_sftp::client::fs::File as SftpFileHandle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

type SharedRusshTransport = Arc<AsyncMutex<RusshShellTransport>>;
type SharedRusshSftpTransport = Arc<AsyncMutex<RusshSftpTransport>>;
type SharedRusshSftpFile = Arc<AsyncMutex<SftpFileHandle>>;
type RemoteForwardTargets = Arc<AsyncMutex<HashMap<(String, u32), RemoteForwardTarget>>>;
const DEFAULT_SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
const DEFAULT_SSH_OPEN_SHELL_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_FILE_CHUNK_LIMIT: usize = 4 * 1024 * 1024;
const SSH_OUTPUT_BATCH_FLUSH_DELAY: Duration = Duration::from_millis(8);
const SSH_OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;
const SSH_OUTPUT_BATCH_MAX_MESSAGES: usize = 64;

#[derive(Clone, Debug)]
struct RemoteForwardTarget {
    host: String,
    port: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SshTransportTimeouts {
    pub connect: Duration,
    pub open_shell: Duration,
}

impl Default for SshTransportTimeouts {
    fn default() -> Self {
        Self {
            connect: DEFAULT_SSH_CONNECT_TIMEOUT,
            open_shell: DEFAULT_SSH_OPEN_SHELL_TIMEOUT,
        }
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
pub struct PrivateKeyCandidate {
    pub private_key_path: String,
    #[serde(default)]
    pub passphrase: Option<String>,
}

impl fmt::Debug for PrivateKeyCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrivateKeyCandidate")
            .field("private_key_path", &self.private_key_path)
            .field("passphrase", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SshAuthMethod {
    Password {
        password: String,
    },
    PrivateKey {
        private_key_path: String,
        passphrase: Option<String>,
    },
    PrivateKeys {
        private_keys: Vec<PrivateKeyCandidate>,
    },
    KeyboardInteractive {
        prompt_provider: String,
    },
}

impl fmt::Debug for SshAuthMethod {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password { .. } => formatter
                .debug_struct("Password")
                .field("password", &"<redacted>")
                .finish(),
            Self::PrivateKey {
                private_key_path, ..
            } => formatter
                .debug_struct("PrivateKey")
                .field("private_key_path", private_key_path)
                .field("passphrase", &"<redacted>")
                .finish(),
            Self::PrivateKeys { private_keys } => formatter
                .debug_struct("PrivateKeys")
                .field("private_keys", private_keys)
                .finish(),
            Self::KeyboardInteractive { prompt_provider } => formatter
                .debug_struct("KeyboardInteractive")
                .field("prompt_provider", prompt_provider)
                .finish(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshKeyboardInteractivePrompt {
    pub prompt: String,
    pub echo: bool,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshKeyboardInteractivePromptEvent {
    pub request_id: String,
    pub name: String,
    pub instruction: String,
    pub prompts: Vec<SshKeyboardInteractivePrompt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SshKeyboardInteractiveResponseRequest {
    pub request_id: String,
    #[serde(default)]
    pub responses: Option<Vec<String>>,
    #[serde(default)]
    pub cancelled: bool,
}

type PendingKeyboardInteractivePrompt = oneshot::Sender<Result<Vec<String>, String>>;

#[derive(Clone, Deserialize, Eq, PartialEq)]
pub struct SshConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuthMethod,
    pub host_key_fingerprint: Option<String>,
    #[serde(default)]
    pub term: Option<String>,
    #[serde(default)]
    pub unsupported_features: Vec<String>,
}

impl fmt::Debug for SshConnectRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshConnectRequest")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth", &self.auth)
            .field("host_key_fingerprint", &self.host_key_fingerprint)
            .field("term", &self.term)
            .field("unsupported_features", &self.unsupported_features)
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshConnectResponse {
    pub session: SessionSnapshot,
    pub transport_status: &'static str,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshData {
    pub session_id: String,
    pub seq: u64,
    pub bytes: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard_text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct SshShellSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct SshKeepaliveProbeRequest {
    pub probes: u16,
    pub interval_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SshHostKeyScanRequest {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshHostKeyScanResponse {
    pub host: String,
    pub port: u16,
    pub sha256: String,
    pub sha512: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct SshKnownHostTrustRequest {
    pub host: String,
    pub port: u16,
    pub sha256: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct SshKnownHostForgetRequest {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct SshKnownHostEntry {
    pub host: String,
    pub port: u16,
    pub sha256: String,
    pub first_seen: u64,
    pub last_seen: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct SshKnownHostMismatchReport {
    pub host: String,
    pub port: u16,
    pub stored_sha256: String,
    pub scanned_sha256: String,
    pub action: &'static str,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshKeepaliveReport {
    pub session: SessionSnapshot,
    pub probes_attempted: u16,
    pub probes_succeeded: u16,
    pub status: &'static str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SshLocalPortForwardRequest {
    pub session_id: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshLocalPortForwardResponse {
    pub forward_id: String,
    pub session_id: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub status: &'static str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SshDynamicPortForwardRequest {
    pub session_id: String,
    pub bind_host: String,
    pub bind_port: u16,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshDynamicPortForwardResponse {
    pub forward_id: String,
    pub session_id: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub status: &'static str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SshRemotePortForwardRequest {
    pub session_id: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct SshRemotePortForwardResponse {
    pub forward_id: String,
    pub session_id: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub status: &'static str,
}

impl SshLocalPortForwardRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.session_id.trim().is_empty() {
            return Err("ssh_start_local_port_forward session_id must not be empty".to_owned());
        }
        if self.bind_host.trim().is_empty() {
            return Err("ssh_start_local_port_forward bind_host must not be empty".to_owned());
        }
        if !is_loopback_bind_host(&self.bind_host) {
            return Err(
                "ssh_start_local_port_forward bind_host must be localhost, 127.0.0.1, or ::1"
                    .to_owned(),
            );
        }
        if self.target_host.trim().is_empty() {
            return Err("ssh_start_local_port_forward target_host must not be empty".to_owned());
        }
        if self.target_port == 0 {
            return Err(
                "ssh_start_local_port_forward target_port must be greater than zero".to_owned(),
            );
        }
        Ok(())
    }
}

impl SshDynamicPortForwardRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.session_id.trim().is_empty() {
            return Err("ssh_start_dynamic_port_forward session_id must not be empty".to_owned());
        }
        if self.bind_host.trim().is_empty() {
            return Err("ssh_start_dynamic_port_forward bind_host must not be empty".to_owned());
        }
        if !is_loopback_bind_host(&self.bind_host) {
            return Err(
                "ssh_start_dynamic_port_forward bind_host must be localhost, 127.0.0.1, or ::1"
                    .to_owned(),
            );
        }
        Ok(())
    }
}

impl SshRemotePortForwardRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.session_id.trim().is_empty() {
            return Err("ssh_start_remote_port_forward session_id must not be empty".to_owned());
        }
        if self.bind_host.trim().is_empty() {
            return Err("ssh_start_remote_port_forward bind_host must not be empty".to_owned());
        }
        if !is_loopback_bind_host(&self.bind_host) {
            return Err(
                "ssh_start_remote_port_forward bind_host must be localhost, 127.0.0.1, or ::1"
                    .to_owned(),
            );
        }
        if self.target_host.trim().is_empty() {
            return Err("ssh_start_remote_port_forward target_host must not be empty".to_owned());
        }
        if self.target_port == 0 {
            return Err(
                "ssh_start_remote_port_forward target_port must be greater than zero".to_owned(),
            );
        }
        Ok(())
    }
}

pub struct SshManager {
    sessions: Arc<Mutex<SessionRegistry>>,
    transports: Arc<Mutex<HashMap<String, SharedRusshTransport>>>,
    sftp_transports: Arc<Mutex<HashMap<String, SharedRusshSftpTransport>>>,
    sftp_files: Arc<Mutex<HashMap<String, SharedRusshSftpFile>>>,
    sftp_file_counter: Arc<AtomicU64>,
    keyboard_interactive_prompts: Arc<Mutex<HashMap<String, PendingKeyboardInteractivePrompt>>>,
    keyboard_interactive_prompt_counter: Arc<AtomicU64>,
    port_forwards: Arc<Mutex<HashMap<String, SshPortForwardHandle>>>,
    port_forward_counter: Arc<AtomicU64>,
    timeouts: SshTransportTimeouts,
}

struct SshPortForwardHandle {
    session_id: String,
    task: Option<JoinHandle<()>>,
    remote_bind: Option<(String, u16)>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpFileEntry {
    pub name: String,
    pub full_path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub mode: u32,
    pub size: u64,
    pub modified: u64,
    pub file_type: String,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpDirectoryPlanEntry {
    pub path: String,
    pub relative_path: String,
    pub is_directory: bool,
    pub mode: u32,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpDirectoryPlan {
    pub root_path: String,
    pub entries: Vec<SftpDirectoryPlanEntry>,
    pub total_size: u64,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpOpenFileResponse {
    pub handle_id: String,
}

impl SshConnectRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("ssh_connect host must not be empty".to_owned());
        }
        if self.port == 0 {
            return Err("ssh_connect port must be greater than zero".to_owned());
        }
        if self.username.trim().is_empty() {
            return Err("ssh_connect username must not be empty".to_owned());
        }
        if !self.unsupported_features.is_empty() {
            return Err(format!(
                "unsupported SSH MVP features requested: {}",
                self.unsupported_features.join(", ")
            ));
        }
        let Some(host_key_fingerprint) = &self.host_key_fingerprint else {
            return Err(
                "ssh_connect host_key_fingerprint is required; scan and trust the host key before authenticating"
                    .to_owned(),
            );
        };
        validate_host_key_fingerprint(host_key_fingerprint)?;
        match &self.auth {
            SshAuthMethod::PrivateKey {
                private_key_path, ..
            } if private_key_path.trim().is_empty() => {
                return Err("ssh_connect private_key_path must not be empty".to_owned());
            }
            SshAuthMethod::PrivateKeys { private_keys } => {
                if private_keys.is_empty() {
                    return Err("ssh_connect private_keys must not be empty".to_owned());
                }
                if private_keys
                    .iter()
                    .any(|candidate| candidate.private_key_path.trim().is_empty())
                {
                    return Err("ssh_connect private_key_path must not be empty".to_owned());
                }
            }
            SshAuthMethod::KeyboardInteractive { prompt_provider }
                if prompt_provider != "renderer" =>
            {
                return Err(
                    "ssh_connect keyboard-interactive prompt_provider must be renderer".to_owned(),
                );
            }
            _ => {}
        }
        Ok(())
    }
}

impl SshHostKeyScanRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("ssh_scan_host_key host must not be empty".to_owned());
        }
        if self.port == 0 {
            return Err("ssh_scan_host_key port must be greater than zero".to_owned());
        }
        Ok(())
    }
}

impl SshKnownHostTrustRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_known_host_identity(&self.host, self.port)?;
        validate_host_key_fingerprint(&self.sha256)?;
        if !normalize_fingerprint(&self.sha256).starts_with("SHA256:") {
            return Err("ssh_known_host_trust sha256 must use SHA256:<digest>".to_owned());
        }
        Ok(())
    }
}

impl SshKnownHostForgetRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_known_host_identity(&self.host, self.port)
    }
}

impl SshManager {
    pub fn new(sessions: Arc<Mutex<SessionRegistry>>) -> Self {
        Self::with_timeouts(sessions, SshTransportTimeouts::default())
    }

    pub fn with_timeouts(
        sessions: Arc<Mutex<SessionRegistry>>,
        timeouts: SshTransportTimeouts,
    ) -> Self {
        Self {
            sessions,
            transports: Arc::new(Mutex::new(HashMap::new())),
            sftp_transports: Arc::new(Mutex::new(HashMap::new())),
            sftp_files: Arc::new(Mutex::new(HashMap::new())),
            sftp_file_counter: Arc::new(AtomicU64::new(1)),
            keyboard_interactive_prompts: Arc::new(Mutex::new(HashMap::new())),
            keyboard_interactive_prompt_counter: Arc::new(AtomicU64::new(1)),
            port_forwards: Arc::new(Mutex::new(HashMap::new())),
            port_forward_counter: Arc::new(AtomicU64::new(1)),
            timeouts,
        }
    }

    pub fn prepare_connect(
        &self,
        request: SshConnectRequest,
    ) -> Result<SshConnectResponse, String> {
        self.connect(request)
    }

    pub fn connect(&self, request: SshConnectRequest) -> Result<SshConnectResponse, String> {
        request.validate()?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?;
        let session = sessions.create(SessionKind::Ssh);
        let session = sessions
            .set_state(&session.session_id, SessionState::Starting)
            .map_err(|error| format!("{error:?}"))?;
        Ok(SshConnectResponse {
            session,
            transport_status: "pending-russh-transport",
        })
    }

    pub async fn scan_host_key(
        &self,
        request: SshHostKeyScanRequest,
    ) -> Result<SshHostKeyScanResponse, String> {
        scan_host_key(request).await
    }

    pub async fn connect_transport(
        &self,
        request: SshConnectRequest,
    ) -> Result<SshConnectResponse, String> {
        request.validate()?;
        let transport = tokio::time::timeout(
            self.timeouts.connect,
            RusshShellTransport::connect(&request),
        )
        .await
        .map_err(|_| {
            format!(
                "SSH connect timed out after {}",
                format_duration(self.timeouts.connect)
            )
        })??;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?;
        let session = sessions.create(SessionKind::Ssh);
        let session = sessions
            .set_state(&session.session_id, SessionState::Starting)
            .map_err(|error| format!("{error:?}"))?;
        drop(sessions);

        self.transports
            .lock()
            .map_err(|_| "ssh transport registry lock poisoned".to_owned())?
            .insert(
                session.session_id.clone(),
                Arc::new(AsyncMutex::new(transport)),
            );

        Ok(SshConnectResponse {
            session,
            transport_status: "russh-connected",
        })
    }

    pub async fn connect_transport_interactive(
        &self,
        request: SshConnectRequest,
        channel: tauri::ipc::Channel<SshKeyboardInteractivePromptEvent>,
    ) -> Result<SshConnectResponse, String> {
        request.validate()?;
        let broker = KeyboardInteractiveBroker {
            prompts: self.keyboard_interactive_prompts.clone(),
            counter: self.keyboard_interactive_prompt_counter.clone(),
            channel,
        };
        let transport = tokio::time::timeout(
            self.timeouts.connect,
            RusshShellTransport::connect_with_keyboard_interactive(&request, Some(&broker)),
        )
        .await
        .map_err(|_| {
            format!(
                "SSH connect timed out after {}",
                format_duration(self.timeouts.connect)
            )
        })??;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?;
        let session = sessions.create(SessionKind::Ssh);
        let session = sessions
            .set_state(&session.session_id, SessionState::Starting)
            .map_err(|error| format!("{error:?}"))?;
        drop(sessions);

        self.transports
            .lock()
            .map_err(|_| "ssh transport registry lock poisoned".to_owned())?
            .insert(
                session.session_id.clone(),
                Arc::new(AsyncMutex::new(transport)),
            );

        Ok(SshConnectResponse {
            session,
            transport_status: "russh-connected",
        })
    }

    pub fn respond_keyboard_interactive(
        &self,
        request: SshKeyboardInteractiveResponseRequest,
    ) -> Result<(), String> {
        let sender = self
            .keyboard_interactive_prompts
            .lock()
            .map_err(|_| "ssh keyboard-interactive registry lock poisoned".to_owned())?
            .remove(&request.request_id)
            .ok_or_else(|| {
                format!(
                    "unknown SSH keyboard-interactive prompt request: {}",
                    request.request_id
                )
            })?;
        let response = if request.cancelled {
            Err("SSH keyboard-interactive authentication cancelled".to_owned())
        } else {
            Ok(request.responses.unwrap_or_default())
        };
        sender
            .send(response)
            .map_err(|_| "SSH keyboard-interactive prompt receiver was closed".to_owned())
    }

    pub async fn connect_sftp_transport(
        &self,
        request: SshConnectRequest,
    ) -> Result<SshConnectResponse, String> {
        request.validate()?;
        let transport =
            tokio::time::timeout(self.timeouts.connect, RusshSftpTransport::connect(&request))
                .await
                .map_err(|_| {
                    format!(
                        "SSH SFTP connect timed out after {}",
                        format_duration(self.timeouts.connect)
                    )
                })??;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?;
        let session = sessions.create(SessionKind::Ssh);
        let session = sessions
            .set_state(&session.session_id, SessionState::Running)
            .map_err(|error| format!("{error:?}"))?;
        drop(sessions);

        self.sftp_transports
            .lock()
            .map_err(|_| "ssh sftp transport registry lock poisoned".to_owned())?
            .insert(
                session.session_id.clone(),
                Arc::new(AsyncMutex::new(transport)),
            );

        Ok(SshConnectResponse {
            session,
            transport_status: "russh-sftp-connected",
        })
    }

    pub async fn sftp_readdir(
        &self,
        session_id: &str,
        path: String,
    ) -> Result<Vec<SftpFileEntry>, String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        let entries = transport
            .sftp
            .read_dir(path.clone())
            .await
            .map_err(format_sftp_error)?;
        let mut entries = entries
            .map(|entry| {
                let name = entry.file_name();
                let full_path = remote_join(&path, &name);
                sftp_entry_from_metadata(name, full_path, entry.metadata())
            })
            .collect::<Vec<_>>();
        sort_sftp_entries(&mut entries);
        Ok(entries)
    }

    pub async fn sftp_directory_plan(
        &self,
        session_id: &str,
        path: String,
    ) -> Result<SftpDirectoryPlan, String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        let mut stack = vec![(path.clone(), String::new())];
        let mut entries = Vec::new();
        let mut total_size = 0_u64;

        while let Some((directory_path, relative_directory)) = stack.pop() {
            let directory_entries = transport
                .sftp
                .read_dir(directory_path.clone())
                .await
                .map_err(format_sftp_error)?;
            let mut directory_entries = directory_entries
                .map(|entry| {
                    let name = entry.file_name();
                    let full_path = remote_join(&directory_path, &name);
                    sftp_entry_from_metadata(name, full_path, entry.metadata())
                })
                .collect::<Vec<_>>();
            sort_sftp_entries(&mut directory_entries);

            let mut child_directories = Vec::new();
            for entry in directory_entries {
                let relative_path = remote_relative_join(&relative_directory, &entry.name);
                if entry.is_directory && !entry.is_symlink {
                    child_directories.push((entry.full_path.clone(), relative_path.clone()));
                } else {
                    total_size = total_size.saturating_add(entry.size);
                }
                entries.push(SftpDirectoryPlanEntry {
                    path: entry.full_path,
                    relative_path,
                    is_directory: entry.is_directory,
                    mode: entry.mode,
                    size: entry.size,
                });
            }

            for child in child_directories.into_iter().rev() {
                stack.push(child);
            }
        }

        Ok(SftpDirectoryPlan {
            root_path: path,
            entries,
            total_size,
        })
    }

    pub async fn sftp_readlink(&self, session_id: &str, path: String) -> Result<String, String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        transport
            .sftp
            .read_link(path)
            .await
            .map_err(format_sftp_error)
    }

    pub async fn sftp_realpath(&self, session_id: &str, path: String) -> Result<String, String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        transport
            .sftp
            .canonicalize(path)
            .await
            .map_err(format_sftp_error)
    }

    pub async fn sftp_stat(&self, session_id: &str, path: String) -> Result<SftpFileEntry, String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        let metadata = transport
            .sftp
            .metadata(path.clone())
            .await
            .map_err(format_sftp_error)?;
        Ok(sftp_entry_from_metadata(
            remote_basename(&path),
            path,
            metadata,
        ))
    }

    pub async fn sftp_open(
        &self,
        session_id: &str,
        path: String,
        mode: u32,
    ) -> Result<SftpOpenFileResponse, String> {
        let flags = sftp_open_flags(mode);
        let transport = self.sftp_transport(session_id)?;
        let file = {
            let transport = transport.lock().await;
            transport
                .sftp
                .open_with_flags(path, flags)
                .await
                .map_err(format_sftp_error)?
        };
        let handle_id = format!(
            "{session_id}:{}",
            self.sftp_file_counter.fetch_add(1, Ordering::Relaxed)
        );
        self.sftp_files
            .lock()
            .map_err(|_| "ssh sftp file registry lock poisoned".to_owned())?
            .insert(handle_id.clone(), Arc::new(AsyncMutex::new(file)));
        Ok(SftpOpenFileResponse { handle_id })
    }

    pub async fn sftp_read_file_chunk(
        &self,
        handle_id: &str,
        length: u32,
    ) -> Result<Vec<u8>, String> {
        let file = self.sftp_file(handle_id)?;
        let length = (length as usize).clamp(1, SFTP_FILE_CHUNK_LIMIT);
        let mut buffer = vec![0_u8; length];
        let read = file
            .lock()
            .await
            .read(&mut buffer)
            .await
            .map_err(|error| format!("failed to read remote SFTP file: {error}"))?;
        buffer.truncate(read);
        Ok(buffer)
    }

    pub async fn sftp_write_file_chunk(
        &self,
        handle_id: &str,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        let file = self.sftp_file(handle_id)?;
        let result = file
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(|error| format!("failed to write remote SFTP file: {error}"));
        result
    }

    pub async fn sftp_close_file(&self, handle_id: &str) -> Result<(), String> {
        let file = self
            .sftp_files
            .lock()
            .map_err(|_| "ssh sftp file registry lock poisoned".to_owned())?
            .remove(handle_id);
        if let Some(file) = file {
            file.lock()
                .await
                .shutdown()
                .await
                .map_err(|error| format!("failed to close remote SFTP file: {error}"))?;
        }
        Ok(())
    }

    pub async fn sftp_mkdir(&self, session_id: &str, path: String) -> Result<(), String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        transport
            .sftp
            .create_dir(path)
            .await
            .map_err(format_sftp_error)
    }

    pub async fn sftp_rename(
        &self,
        session_id: &str,
        old_path: String,
        new_path: String,
    ) -> Result<(), String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        transport
            .sftp
            .rename(old_path, new_path)
            .await
            .map_err(format_sftp_error)
    }

    pub async fn sftp_unlink(&self, session_id: &str, path: String) -> Result<(), String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        transport
            .sftp
            .remove_file(path)
            .await
            .map_err(format_sftp_error)
    }

    pub async fn sftp_rmdir(&self, session_id: &str, path: String) -> Result<(), String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        transport
            .sftp
            .remove_dir(path)
            .await
            .map_err(format_sftp_error)
    }

    pub async fn sftp_chmod(
        &self,
        session_id: &str,
        path: String,
        mode: u32,
    ) -> Result<(), String> {
        let transport = self.sftp_transport(session_id)?;
        let transport = transport.lock().await;
        let mut metadata = FileAttributes::empty();
        metadata.permissions = Some(mode);
        transport
            .sftp
            .set_metadata(path, metadata)
            .await
            .map_err(format_sftp_error)
    }

    pub async fn close_sftp_transport(
        &self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<SessionSnapshot, String> {
        let reason = reason.into();
        let file_prefix = format!("{session_id}:");
        let files = {
            let mut files = self
                .sftp_files
                .lock()
                .map_err(|_| "ssh sftp file registry lock poisoned".to_owned())?;
            let handle_ids = files
                .keys()
                .filter(|handle_id| handle_id.starts_with(&file_prefix))
                .cloned()
                .collect::<Vec<_>>();
            handle_ids
                .into_iter()
                .filter_map(|handle_id| files.remove(&handle_id))
                .collect::<Vec<_>>()
        };
        for file in files {
            let _ = file.lock().await.shutdown().await;
        }

        let transport = self
            .sftp_transports
            .lock()
            .map_err(|_| "ssh sftp transport registry lock poisoned".to_owned())?
            .remove(session_id);
        if let Some(transport) = transport {
            transport.lock().await.close().await?;
        }
        self.close(session_id, reason)
    }

    pub fn open_shell(
        &self,
        session_id: &str,
        size: SshShellSize,
    ) -> Result<SessionSnapshot, String> {
        size.validate()?;
        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .set_state(session_id, SessionState::Running)
            .map_err(|error| format!("{error:?}"))
    }

    pub async fn open_shell_transport(
        &self,
        session_id: &str,
        size: SshShellSize,
    ) -> Result<SessionSnapshot, String> {
        size.validate()?;
        let transport = self.transport(session_id)?;
        let open_result = {
            let mut transport = transport.lock().await;
            tokio::time::timeout(self.timeouts.open_shell, transport.open_shell(size.clone())).await
        };

        match open_result {
            Ok(Ok(())) => self.open_shell(session_id, size),
            Ok(Err(error)) => {
                let reason = format!("SSH open shell failed: {error}");
                let _ = self.close_failed_transport(session_id, reason).await;
                Err(error)
            }
            Err(_) => {
                let reason = format!(
                    "SSH open shell timed out after {}",
                    format_duration(self.timeouts.open_shell)
                );
                let _ = self
                    .close_failed_transport(session_id, reason.clone())
                    .await;
                Err(reason)
            }
        }
    }

    pub fn write(&self, session_id: &str, bytes: &[u8]) -> Result<SessionSnapshot, String> {
        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .record_input(session_id, bytes.len() as u64)
            .map_err(|error| format!("{error:?}"))
    }

    pub async fn write_transport(
        &self,
        session_id: &str,
        bytes: Vec<u8>,
    ) -> Result<SessionSnapshot, String> {
        let transport = self.transport(session_id)?;
        transport.lock().await.write(&bytes).await?;
        self.write(session_id, &bytes)
    }

    pub fn resize(&self, session_id: &str, size: SshShellSize) -> Result<SessionSnapshot, String> {
        size.validate()?;
        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .set_state(session_id, SessionState::Running)
            .map_err(|error| format!("{error:?}"))
    }

    pub async fn resize_transport(
        &self,
        session_id: &str,
        size: SshShellSize,
    ) -> Result<SessionSnapshot, String> {
        let transport = self.transport(session_id)?;
        transport.lock().await.resize(size.clone()).await?;
        self.resize(session_id, size)
    }

    pub fn ack(&self, session_id: &str, length: u64) -> Result<SessionSnapshot, String> {
        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .ack_output(session_id, length)
            .map_err(|error| format!("{error:?}"))
    }

    pub fn keepalive(&self, session_id: &str) -> Result<SessionSnapshot, String> {
        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .set_state(session_id, SessionState::Running)
            .map_err(|error| format!("{error:?}"))
    }

    pub async fn keepalive_transport(&self, session_id: &str) -> Result<SessionSnapshot, String> {
        let transport = self.transport(session_id)?;
        let result = transport.lock().await.keepalive().await;

        match result {
            Ok(()) => self.keepalive(session_id),
            Err(error) => {
                let mut sessions = self.lock_sessions()?;
                Self::ensure_ssh_session(&sessions, session_id)?;
                sessions
                    .mark_reconnectable(session_id, error)
                    .map_err(|error| format!("{error:?}"))
            }
        }
    }

    pub async fn keepalive_evaluator(
        &self,
        session_id: &str,
        request: SshKeepaliveProbeRequest,
    ) -> Result<SshKeepaliveReport, String> {
        request.validate()?;
        let mut last_session = self.start_stream(session_id)?;
        let mut probes_succeeded = 0_u16;

        for probe in 0..request.probes {
            if probe > 0 {
                tokio::time::sleep(Duration::from_millis(request.interval_ms)).await;
            }
            last_session = self.keepalive(session_id)?;
            probes_succeeded = probes_succeeded.saturating_add(1);
        }

        Ok(SshKeepaliveReport {
            status: keepalive_status(&last_session),
            session: last_session,
            probes_attempted: request.probes,
            probes_succeeded,
        })
    }

    pub async fn keepalive_evaluator_transport(
        &self,
        session_id: &str,
        request: SshKeepaliveProbeRequest,
    ) -> Result<SshKeepaliveReport, String> {
        request.validate()?;
        let mut last_session = self.start_stream(session_id)?;
        let mut probes_succeeded = 0_u16;

        for probe in 0..request.probes {
            if probe > 0 {
                tokio::time::sleep(Duration::from_millis(request.interval_ms)).await;
            }
            last_session = self.keepalive_transport(session_id).await?;
            if last_session.state == SessionState::Reconnectable {
                break;
            }
            probes_succeeded = probes_succeeded.saturating_add(1);
        }

        Ok(SshKeepaliveReport {
            status: keepalive_status(&last_session),
            session: last_session,
            probes_attempted: request.probes,
            probes_succeeded,
        })
    }

    pub fn close(
        &self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<SessionSnapshot, String> {
        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .close(session_id, reason)
            .map_err(|error| format!("{error:?}"))
    }

    pub async fn close_transport(
        &self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<SessionSnapshot, String> {
        let reason = reason.into();
        self.stop_forwards_for_session(session_id).await?;
        let transport = self
            .transports
            .lock()
            .map_err(|_| "ssh transport registry lock poisoned".to_owned())?
            .remove(session_id);
        if let Some(transport) = transport {
            transport.lock().await.close().await?;
        }
        self.close(session_id, reason)
    }

    pub async fn start_local_port_forward(
        &self,
        request: SshLocalPortForwardRequest,
    ) -> Result<SshLocalPortForwardResponse, String> {
        request.validate()?;
        {
            let sessions = self.lock_sessions()?;
            Self::ensure_ssh_session(&sessions, &request.session_id)?;
        }
        let transport = self.transport(&request.session_id)?;
        let listener = TcpListener::bind((request.bind_host.as_str(), request.bind_port))
            .await
            .map_err(|error| {
                format!(
                    "failed to bind local SSH port forward {}:{}: {error}",
                    request.bind_host, request.bind_port
                )
            })?;
        let bind_addr = listener.local_addr().map_err(|error| {
            format!("failed to inspect local SSH port forward listener: {error}")
        })?;
        let forward_id = format!(
            "ssh-forward-{}",
            self.port_forward_counter.fetch_add(1, Ordering::Relaxed)
        );
        let response = SshLocalPortForwardResponse {
            forward_id: forward_id.clone(),
            session_id: request.session_id.clone(),
            bind_host: bind_addr.ip().to_string(),
            bind_port: bind_addr.port(),
            target_host: request.target_host.clone(),
            target_port: request.target_port,
            status: "listening",
        };
        let task = spawn_local_port_forward_listener(listener, transport, request);
        self.port_forwards
            .lock()
            .map_err(|_| "ssh port forward registry lock poisoned".to_owned())?
            .insert(
                forward_id,
                SshPortForwardHandle {
                    session_id: response.session_id.clone(),
                    task: Some(task),
                    remote_bind: None,
                },
            );
        Ok(response)
    }

    pub async fn start_dynamic_port_forward(
        &self,
        request: SshDynamicPortForwardRequest,
    ) -> Result<SshDynamicPortForwardResponse, String> {
        request.validate()?;
        {
            let sessions = self.lock_sessions()?;
            Self::ensure_ssh_session(&sessions, &request.session_id)?;
        }
        let transport = self.transport(&request.session_id)?;
        let listener = TcpListener::bind((request.bind_host.as_str(), request.bind_port))
            .await
            .map_err(|error| {
                format!(
                    "failed to bind dynamic SSH SOCKS forward {}:{}: {error}",
                    request.bind_host, request.bind_port
                )
            })?;
        let bind_addr = listener
            .local_addr()
            .map_err(|error| format!("failed to inspect dynamic SSH SOCKS listener: {error}"))?;
        let forward_id = format!(
            "ssh-forward-{}",
            self.port_forward_counter.fetch_add(1, Ordering::Relaxed)
        );
        let response = SshDynamicPortForwardResponse {
            forward_id: forward_id.clone(),
            session_id: request.session_id.clone(),
            bind_host: bind_addr.ip().to_string(),
            bind_port: bind_addr.port(),
            status: "listening",
        };
        let task = spawn_dynamic_socks_forward_listener(listener, transport);
        self.port_forwards
            .lock()
            .map_err(|_| "ssh port forward registry lock poisoned".to_owned())?
            .insert(
                forward_id,
                SshPortForwardHandle {
                    session_id: response.session_id.clone(),
                    task: Some(task),
                    remote_bind: None,
                },
            );
        Ok(response)
    }

    pub async fn start_remote_port_forward(
        &self,
        request: SshRemotePortForwardRequest,
    ) -> Result<SshRemotePortForwardResponse, String> {
        request.validate()?;
        {
            let sessions = self.lock_sessions()?;
            Self::ensure_ssh_session(&sessions, &request.session_id)?;
        }
        let transport = self.transport(&request.session_id)?;
        let bind_port = {
            let transport = transport.lock().await;
            transport.start_remote_port_forward(&request).await?
        };
        let forward_id = format!(
            "ssh-forward-{}",
            self.port_forward_counter.fetch_add(1, Ordering::Relaxed)
        );
        let response = SshRemotePortForwardResponse {
            forward_id: forward_id.clone(),
            session_id: request.session_id.clone(),
            bind_host: request.bind_host.clone(),
            bind_port,
            target_host: request.target_host.clone(),
            target_port: request.target_port,
            status: "listening",
        };
        self.port_forwards
            .lock()
            .map_err(|_| "ssh port forward registry lock poisoned".to_owned())?
            .insert(
                forward_id,
                SshPortForwardHandle {
                    session_id: response.session_id.clone(),
                    task: None,
                    remote_bind: Some((response.bind_host.clone(), response.bind_port)),
                },
            );
        Ok(response)
    }

    pub async fn stop_port_forward(&self, forward_id: &str) -> Result<(), String> {
        let handle = self
            .port_forwards
            .lock()
            .map_err(|_| "ssh port forward registry lock poisoned".to_owned())?
            .remove(forward_id);
        if let Some(handle) = handle {
            if let Some(task) = handle.task {
                task.abort();
            }
            if let Some((bind_host, bind_port)) = handle.remote_bind {
                if let Ok(transport) = self.transport(&handle.session_id) {
                    let transport = transport.lock().await;
                    transport
                        .stop_remote_port_forward(&bind_host, bind_port)
                        .await?;
                }
            }
        }
        Ok(())
    }

    async fn stop_forwards_for_session(&self, session_id: &str) -> Result<(), String> {
        let handles = {
            let mut forwards = self
                .port_forwards
                .lock()
                .map_err(|_| "ssh port forward registry lock poisoned".to_owned())?;
            let forward_ids = forwards
                .iter()
                .filter(|(_, handle)| handle.session_id == session_id)
                .map(|(forward_id, _)| forward_id.clone())
                .collect::<Vec<_>>();
            forward_ids
                .into_iter()
                .filter_map(|forward_id| forwards.remove(&forward_id))
                .collect::<Vec<_>>()
        };
        for handle in handles {
            if let Some(task) = handle.task {
                task.abort();
            }
            if let Some((bind_host, bind_port)) = handle.remote_bind {
                if let Ok(transport) = self.transport(&handle.session_id) {
                    let transport = transport.lock().await;
                    transport
                        .stop_remote_port_forward(&bind_host, bind_port)
                        .await?;
                }
            }
        }
        Ok(())
    }

    pub fn state(&self, session_id: &str) -> Result<Option<SessionSnapshot>, String> {
        let sessions = self.lock_sessions()?;
        Ok(sessions.get(session_id).cloned())
    }

    pub fn start_stream(&self, session_id: &str) -> Result<SessionSnapshot, String> {
        let sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("unknown SSH session: {session_id}"))
    }

    pub async fn start_stream_transport(
        &self,
        session_id: String,
        channel: tauri::ipc::Channel<SshData>,
    ) -> Result<SessionSnapshot, String> {
        let snapshot = self.start_stream(&session_id)?;
        let transport = self.transport(&session_id)?;
        let mut russh_channel = transport.lock().await.take_channel_read()?;

        let sessions = self.sessions.clone();
        let transports = self.transports.clone();
        tokio::spawn(async move {
            let mut seq = 0_u64;
            let mut interrupt_reason = None;
            let mut clean_exit = false;
            let mut exit_status = None;
            loop {
                if !wait_until_ssh_reader_resumes(&sessions, &session_id).await {
                    break;
                }
                let Some(message) = russh_channel.wait().await else {
                    if !clean_exit {
                        interrupt_reason = Some("ssh-reader-ended".to_owned());
                    }
                    break;
                };
                let mut bytes = match message {
                    russh::ChannelMsg::Data { data } => data.to_vec(),
                    russh::ChannelMsg::ExtendedData { data, .. } => data.to_vec(),
                    russh::ChannelMsg::ExitStatus {
                        exit_status: status,
                    } => {
                        clean_exit = true;
                        exit_status = Some(status);
                        continue;
                    }
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close => {
                        clean_exit = true;
                        break;
                    }
                    _ => continue,
                };
                let mut ended_after_batch = false;
                let mut drained_messages = 0_usize;
                while bytes.len() < SSH_OUTPUT_BATCH_MAX_BYTES
                    && drained_messages < SSH_OUTPUT_BATCH_MAX_MESSAGES
                {
                    match tokio::time::timeout(SSH_OUTPUT_BATCH_FLUSH_DELAY, russh_channel.wait())
                        .await
                    {
                        Ok(Some(russh::ChannelMsg::Data { data })) => {
                            drained_messages += 1;
                            bytes.extend_from_slice(&data);
                        }
                        Ok(Some(russh::ChannelMsg::ExtendedData { data, .. })) => {
                            drained_messages += 1;
                            bytes.extend_from_slice(&data);
                        }
                        Ok(Some(russh::ChannelMsg::ExitStatus {
                            exit_status: status,
                        })) => {
                            clean_exit = true;
                            exit_status = Some(status);
                            drained_messages += 1;
                        }
                        Ok(Some(russh::ChannelMsg::Eof | russh::ChannelMsg::Close)) => {
                            clean_exit = true;
                            ended_after_batch = true;
                            break;
                        }
                        Ok(Some(_)) => {
                            drained_messages += 1;
                        }
                        Ok(None) => {
                            ended_after_batch = true;
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let length = bytes.len() as u64;
                let osc_metadata = extract_osc_metadata(&bytes);
                if let Ok(mut registry) = sessions.lock() {
                    let _ = registry.record_output(&session_id, length);
                }
                if channel
                    .send(SshData {
                        session_id: session_id.clone(),
                        seq,
                        bytes,
                        current_dir: osc_metadata.current_dir,
                        clipboard_text: osc_metadata.clipboard_text,
                    })
                    .is_err()
                {
                    interrupt_reason = Some("ssh-output-channel-closed".to_owned());
                    break;
                }
                seq = seq.saturating_add(1);
                if ended_after_batch {
                    if !clean_exit {
                        interrupt_reason = Some("ssh-reader-ended".to_owned());
                    }
                    break;
                }
            }
            if clean_exit {
                let reason = exit_status
                    .map(|status| format!("ssh-remote-shell-exited:{status}"))
                    .unwrap_or_else(|| "ssh-remote-shell-exited".to_owned());
                mark_ssh_stream_closed(&sessions, &transports, &session_id, reason).await;
            } else if let Some(reason) = interrupt_reason {
                mark_ssh_stream_interrupted(&sessions, &transports, &session_id, reason).await;
            }
        });

        Ok(snapshot)
    }

    pub async fn next_data_transport(
        &self,
        session_id: &str,
        seq: u64,
    ) -> Result<Option<SshData>, String> {
        let transport = self.transport(session_id)?;
        let mut transport = transport.lock().await;
        let result = transport.next_data(session_id, seq).await;

        if let Some(data) = &result {
            let mut sessions = self.lock_sessions()?;
            Self::ensure_ssh_session(&sessions, session_id)?;
            sessions
                .record_output(session_id, data.bytes.len() as u64)
                .map_err(|error| format!("{error:?}"))?;
        }

        Ok(result)
    }

    pub fn forced_disconnect_test(
        &self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<SessionSnapshot, String> {
        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .mark_reconnectable(session_id, reason)
            .map_err(|error| format!("{error:?}"))
    }

    fn lock_sessions(&self) -> Result<std::sync::MutexGuard<'_, SessionRegistry>, String> {
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())
    }

    fn ensure_ssh_session(sessions: &SessionRegistry, session_id: &str) -> Result<(), String> {
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown SSH session: {session_id}"))?;
        if session.kind != SessionKind::Ssh {
            return Err(format!("session is not an SSH session: {session_id}"));
        }
        Ok(())
    }

    fn transport(&self, session_id: &str) -> Result<SharedRusshTransport, String> {
        self.transports
            .lock()
            .map_err(|_| "ssh transport registry lock poisoned".to_owned())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("unknown russh transport: {session_id}"))
    }

    fn sftp_transport(&self, session_id: &str) -> Result<SharedRusshSftpTransport, String> {
        let sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        drop(sessions);
        self.sftp_transports
            .lock()
            .map_err(|_| "ssh sftp transport registry lock poisoned".to_owned())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("unknown russh sftp transport: {session_id}"))
    }

    fn sftp_file(&self, handle_id: &str) -> Result<SharedRusshSftpFile, String> {
        self.sftp_files
            .lock()
            .map_err(|_| "ssh sftp file registry lock poisoned".to_owned())?
            .get(handle_id)
            .cloned()
            .ok_or_else(|| format!("unknown russh sftp file handle: {handle_id}"))
    }

    async fn close_failed_transport(
        &self,
        session_id: &str,
        reason: String,
    ) -> Result<SessionSnapshot, String> {
        let transport = self
            .transports
            .lock()
            .map_err(|_| "ssh transport registry lock poisoned".to_owned())?
            .remove(session_id);
        if let Some(transport) = transport {
            let _ = transport.lock().await.close().await;
        }

        let mut sessions = self.lock_sessions()?;
        Self::ensure_ssh_session(&sessions, session_id)?;
        sessions
            .mark_reconnectable(session_id, reason)
            .map_err(|error| format!("{error:?}"))
    }
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn format_duration(duration: Duration) -> String {
    if duration.as_millis() < 1000 {
        format!("{}ms", duration.as_millis())
    } else {
        format!("{}s", duration.as_secs())
    }
}

fn format_sftp_error(error: impl std::fmt::Display) -> String {
    format!("SFTP operation failed: {error}")
}

fn sftp_open_flags(mode: u32) -> OpenFlags {
    let flags = OpenFlags::from_bits_truncate(mode);
    if flags.is_empty() {
        OpenFlags::READ
    } else {
        flags
    }
}

fn sftp_entry_from_metadata(
    name: String,
    full_path: String,
    metadata: FileAttributes,
) -> SftpFileEntry {
    let file_type = metadata.file_type();
    let file_type_name = sftp_file_type_name(&name, &file_type);
    SftpFileEntry {
        name,
        full_path,
        is_directory: file_type == FileType::Dir,
        is_symlink: file_type == FileType::Symlink,
        mode: metadata.permissions.unwrap_or(0),
        size: metadata.size.unwrap_or(0),
        modified: metadata.mtime.unwrap_or(0) as u64,
        file_type: file_type_name,
    }
}

#[derive(Default)]
struct OscMetadata {
    current_dir: Option<String>,
    clipboard_text: Option<String>,
}

fn extract_osc_metadata(data: &[u8]) -> OscMetadata {
    let mut metadata = OscMetadata::default();
    let mut start = 0_usize;
    while start < data.len() {
        let Some(prefix_offset) = find_subsequence(&data[start..], b"\x1b]") else {
            break;
        };
        let prefix_index = start + prefix_offset;
        let suffix_search_start = prefix_index + 2;
        let bel_suffix = data[suffix_search_start..]
            .iter()
            .position(|byte| *byte == 0x07)
            .map(|index| (suffix_search_start + index, 1_usize));
        let st_suffix = find_subsequence(&data[suffix_search_start..], b"\x1b\\")
            .map(|index| (suffix_search_start + index, 2_usize));
        let suffix = match (bel_suffix, st_suffix) {
            (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
            (Some(suffix), None) | (None, Some(suffix)) => Some(suffix),
            (None, None) => None,
        };
        let Some((suffix_index, suffix_len)) = suffix else {
            break;
        };
        apply_osc_payload(&data[suffix_search_start..suffix_index], &mut metadata);
        start = suffix_index + suffix_len;
    }
    metadata
}

fn apply_osc_payload(payload: &[u8], metadata: &mut OscMetadata) {
    let payload = String::from_utf8_lossy(payload);
    let mut parts = payload.split(';');
    let code = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    match code {
        1337 => {
            let parameters = parts.collect::<Vec<_>>().join(";");
            if let Some(current_dir) = parameters.strip_prefix("CurrentDir=") {
                metadata.current_dir = Some(current_dir.to_owned());
            }
        }
        52 => {
            let target = parts.next().unwrap_or_default();
            let content = parts.next().unwrap_or_default();
            if (target.is_empty() || target == "c") && !content.is_empty() {
                if let Ok(decoded) = BASE64.decode(content) {
                    if let Ok(text) = String::from_utf8(decoded) {
                        metadata.clipboard_text = Some(text);
                    }
                }
            }
        }
        _ => {}
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn sort_sftp_entries(entries: &mut [SftpFileEntry]) {
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
            .then_with(|| left.name.cmp(&right.name))
    });
}

fn sftp_file_type_name(name: &str, file_type: &FileType) -> String {
    if *file_type == FileType::Dir {
        return "directory".to_owned();
    }
    if *file_type == FileType::Symlink {
        return "symlink".to_owned();
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    let Some(extension) = extension else {
        return "unknown".to_owned();
    };
    match extension.as_str() {
        "js" | "ts" | "py" | "java" | "cpp" | "h" | "cs" | "html" | "css" | "rb" | "php"
        | "swift" | "go" | "kt" | "sh" | "json" | "cc" | "c" | "xml" => "code".to_owned(),
        "jpg" | "jpeg" | "png" | "gif" | "bmp" => "image".to_owned(),
        "pdf" => "pdf".to_owned(),
        "zip" | "rar" | "tar" | "gz" => "archive".to_owned(),
        "doc" | "docx" => "word".to_owned(),
        "mp4" | "avi" | "mkv" | "mov" => "video".to_owned(),
        "ppt" | "pptx" => "powerpoint".to_owned(),
        "txt" | "log" => "text".to_owned(),
        "mp3" | "wav" | "flac" => "audio".to_owned(),
        "xls" | "xlsx" => "excel".to_owned(),
        _ => "unknown".to_owned(),
    }
}

fn remote_relative_join(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_owned()
    } else {
        format!("{base}/{name}")
    }
}

fn remote_join(base: &str, name: &str) -> String {
    if base.is_empty() || base == "/" {
        format!("/{name}")
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn remote_basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_owned()
}

fn known_host_key(host: &str, port: u16) -> String {
    format!("{}:{port}", host.trim().to_ascii_lowercase())
}

fn validate_known_host_identity(host: &str, port: u16) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("ssh_known_hosts host must not be empty".to_owned());
    }
    if port == 0 {
        return Err("ssh_known_hosts port must be greater than zero".to_owned());
    }
    Ok(())
}

fn read_known_hosts(path: &Path) -> Result<Vec<SshKnownHostEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_known_hosts(path: &Path, entries: &[SshKnownHostEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_string_pretty(entries).map_err(|error| error.to_string())?;
    std::fs::write(path, payload).map_err(|error| error.to_string())
}

pub fn ssh_known_hosts_list_at(path: &Path) -> Result<Vec<SshKnownHostEntry>, String> {
    read_known_hosts(path)
}

pub fn ssh_known_host_get_at(
    path: &Path,
    request: SshKnownHostForgetRequest,
) -> Result<Option<SshKnownHostEntry>, String> {
    request.validate()?;
    let key = known_host_key(&request.host, request.port);
    Ok(read_known_hosts(path)?
        .into_iter()
        .find(|entry| known_host_key(&entry.host, entry.port) == key))
}

pub fn ssh_known_host_trust_at(
    path: &Path,
    request: SshKnownHostTrustRequest,
) -> Result<SshKnownHostEntry, String> {
    request.validate()?;
    let mut entries = read_known_hosts(path)?;
    let key = known_host_key(&request.host, request.port);
    let now = now_unix_seconds();
    let entry = if let Some(existing) = entries
        .iter_mut()
        .find(|entry| known_host_key(&entry.host, entry.port) == key)
    {
        existing.sha256 = normalize_fingerprint(&request.sha256);
        existing.last_seen = now;
        existing.alias = normalize_optional_text(request.alias.clone());
        existing.comment = normalize_optional_text(request.comment.clone());
        existing.clone()
    } else {
        let entry = SshKnownHostEntry {
            host: request.host.trim().to_ascii_lowercase(),
            port: request.port,
            sha256: normalize_fingerprint(&request.sha256),
            first_seen: now,
            last_seen: now,
            alias: normalize_optional_text(request.alias.clone()),
            comment: normalize_optional_text(request.comment.clone()),
        };
        entries.push(entry.clone());
        entry
    };
    write_known_hosts(path, &entries)?;
    Ok(entry)
}

pub fn ssh_known_host_forget_at(
    path: &Path,
    request: SshKnownHostForgetRequest,
) -> Result<bool, String> {
    request.validate()?;
    let key = known_host_key(&request.host, request.port);
    let mut entries = read_known_hosts(path)?;
    let before = entries.len();
    entries.retain(|entry| known_host_key(&entry.host, entry.port) != key);
    let removed = entries.len() != before;
    write_known_hosts(path, &entries)?;
    Ok(removed)
}

pub fn ssh_known_host_mismatch_report(
    stored: &SshKnownHostEntry,
    scanned_sha256: &str,
) -> Result<SshKnownHostMismatchReport, String> {
    validate_host_key_fingerprint(scanned_sha256)?;
    Ok(SshKnownHostMismatchReport {
        host: stored.host.clone(),
        port: stored.port,
        stored_sha256: stored.sha256.clone(),
        scanned_sha256: normalize_fingerprint(scanned_sha256),
        action: "blocked-before-authentication",
    })
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

impl SshShellSize {
    pub fn validate(&self) -> Result<(), String> {
        if self.cols == 0 {
            return Err("ssh shell cols must be greater than zero".to_owned());
        }
        if self.rows == 0 {
            return Err("ssh shell rows must be greater than zero".to_owned());
        }
        Ok(())
    }
}

impl SshKeepaliveProbeRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.probes == 0 {
            return Err("ssh keepalive evaluator probes must be greater than zero".to_owned());
        }
        Ok(())
    }
}

struct HostKeyPolicyClient {
    expected_fingerprint: Option<String>,
    remote_forwards: RemoteForwardTargets,
}

impl HostKeyPolicyClient {
    fn new(expected_fingerprint: Option<String>, remote_forwards: RemoteForwardTargets) -> Self {
        Self {
            expected_fingerprint: expected_fingerprint.map(|value| normalize_fingerprint(&value)),
            remote_forwards,
        }
    }
}

impl russh::client::Handler for HostKeyPolicyClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(host_key_fingerprint_matches(
            self.expected_fingerprint.as_deref(),
            server_public_key,
        ))
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let remote_forwards = self.remote_forwards.clone();
        let connected_address = connected_address.to_owned();
        tokio::spawn(async move {
            let target = {
                remote_forwards
                    .lock()
                    .await
                    .get(&(connected_address, connected_port))
                    .cloned()
            };
            let Some(target) = target else {
                return;
            };
            let Ok(mut socket) = TcpStream::connect((target.host.as_str(), target.port)).await
            else {
                return;
            };
            let mut channel_stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut channel_stream, &mut socket).await;
        });
        Ok(())
    }
}

struct HostKeyScannerClient {
    fingerprints: Arc<Mutex<Option<(String, String)>>>,
}

impl HostKeyScannerClient {
    fn new(fingerprints: Arc<Mutex<Option<(String, String)>>>) -> Self {
        Self { fingerprints }
    }
}

impl russh::client::Handler for HostKeyScannerClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        if let Ok(mut fingerprints) = self.fingerprints.lock() {
            *fingerprints = Some((
                server_public_key.fingerprint(HashAlg::Sha256).to_string(),
                server_public_key.fingerprint(HashAlg::Sha512).to_string(),
            ));
        }
        Ok(true)
    }
}

pub struct RusshShellTransport {
    handle: russh::client::Handle<HostKeyPolicyClient>,
    channel_id: Option<russh::ChannelId>,
    channel_read: Option<russh::ChannelReadHalf>,
    channel_write: Option<russh::ChannelWriteHalf<russh::client::Msg>>,
    remote_forwards: RemoteForwardTargets,
    term: String,
}

pub struct RusshSftpTransport {
    handle: russh::client::Handle<HostKeyPolicyClient>,
    sftp: SftpSession,
}

async fn scan_host_key(request: SshHostKeyScanRequest) -> Result<SshHostKeyScanResponse, String> {
    request.validate()?;
    let fingerprints = Arc::new(Mutex::new(None));
    let config = russh::client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        ..Default::default()
    };
    let handle = russh::client::connect(
        Arc::new(config),
        (request.host.as_str(), request.port),
        HostKeyScannerClient::new(fingerprints.clone()),
    )
    .await
    .map_err(format_russh_error)?;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;

    let (sha256, sha512) = fingerprints
        .lock()
        .map_err(|_| "ssh host key scanner lock poisoned".to_owned())?
        .clone()
        .ok_or_else(|| "ssh host key scan did not observe a server key".to_owned())?;

    Ok(SshHostKeyScanResponse {
        host: request.host,
        port: request.port,
        sha256,
        sha512,
    })
}

async fn authenticate_russh_handle(
    handle: &mut russh::client::Handle<HostKeyPolicyClient>,
    request: &SshConnectRequest,
    keyboard_interactive: Option<&KeyboardInteractiveBroker>,
) -> Result<(), String> {
    let auth_result = match &request.auth {
        SshAuthMethod::Password { password } => {
            authenticate_password_or_keyboard_interactive(handle, &request.username, password)
                .await?
        }
        SshAuthMethod::PrivateKey {
            private_key_path,
            passphrase,
        } => {
            authenticate_private_key_candidates(
                handle,
                &request.username,
                &[PrivateKeyCandidate {
                    private_key_path: private_key_path.clone(),
                    passphrase: passphrase.clone(),
                }],
            )
            .await?
        }
        SshAuthMethod::PrivateKeys { private_keys } => {
            authenticate_private_key_candidates(handle, &request.username, private_keys).await?
        }
        SshAuthMethod::KeyboardInteractive { .. } => {
            let broker = keyboard_interactive.ok_or_else(|| {
                "SSH keyboard-interactive auth requires a renderer prompt provider".to_owned()
            })?;
            authenticate_keyboard_interactive_prompted(handle, &request.username, broker).await?
        }
    };

    if auth_result {
        Ok(())
    } else {
        Err("SSH authentication failed".to_owned())
    }
}

struct KeyboardInteractiveBroker {
    prompts: Arc<Mutex<HashMap<String, PendingKeyboardInteractivePrompt>>>,
    counter: Arc<AtomicU64>,
    channel: tauri::ipc::Channel<SshKeyboardInteractivePromptEvent>,
}

impl KeyboardInteractiveBroker {
    async fn prompt(
        &self,
        name: String,
        instruction: String,
        prompts: Vec<SshKeyboardInteractivePrompt>,
    ) -> Result<Vec<String>, String> {
        let request_id = format!("ssh-ki-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = oneshot::channel();
        self.prompts
            .lock()
            .map_err(|_| "ssh keyboard-interactive registry lock poisoned".to_owned())?
            .insert(request_id.clone(), sender);
        let _pending_prompt_guard = PendingKeyboardInteractivePromptGuard {
            prompts: self.prompts.clone(),
            request_id: request_id.clone(),
        };

        if self
            .channel
            .send(SshKeyboardInteractivePromptEvent {
                request_id: request_id.clone(),
                name,
                instruction,
                prompts,
            })
            .is_err()
        {
            return Err("SSH keyboard-interactive prompt channel closed".to_owned());
        }

        match tokio::time::timeout(Duration::from_secs(120), receiver).await {
            Ok(Ok(Ok(responses))) => Ok(responses),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err("SSH keyboard-interactive prompt was cancelled".to_owned()),
            Err(_) => Err("SSH keyboard-interactive prompt timed out".to_owned()),
        }
    }
}

struct PendingKeyboardInteractivePromptGuard {
    prompts: Arc<Mutex<HashMap<String, PendingKeyboardInteractivePrompt>>>,
    request_id: String,
}

impl Drop for PendingKeyboardInteractivePromptGuard {
    fn drop(&mut self) {
        if let Ok(mut prompts) = self.prompts.lock() {
            prompts.remove(&self.request_id);
        }
    }
}

async fn authenticate_private_key_candidates(
    handle: &mut russh::client::Handle<HostKeyPolicyClient>,
    username: &str,
    private_keys: &[PrivateKeyCandidate],
) -> Result<bool, String> {
    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .map_err(format_russh_error)?
        .flatten();
    let mut failures = Vec::new();
    for (index, candidate) in private_keys.iter().enumerate() {
        let key_pair = match russh::keys::load_secret_key(
            &candidate.private_key_path,
            candidate.passphrase.as_deref(),
        ) {
            Ok(key_pair) => key_pair,
            Err(error) => {
                failures.push(format!("key {} could not be loaded: {error}", index + 1));
                continue;
            }
        };
        match handle
            .authenticate_publickey(
                username.to_owned(),
                russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
            )
            .await
        {
            Ok(result) if result.success() => return Ok(true),
            Ok(_) => failures.push(format!("key {} was rejected by the server", index + 1)),
            Err(error) => failures.push(format!(
                "key {} failed: {}",
                index + 1,
                format_russh_error(error)
            )),
        }
    }

    if failures.is_empty() {
        Ok(false)
    } else {
        Err(format!(
            "SSH private-key authentication failed for {} configured key(s): {}",
            private_keys.len(),
            failures.join("; ")
        ))
    }
}

impl RusshShellTransport {
    pub async fn connect(request: &SshConnectRequest) -> Result<Self, String> {
        let config = russh::client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let remote_forwards = Arc::new(AsyncMutex::new(HashMap::new()));
        let mut handle = russh::client::connect(
            Arc::new(config),
            (request.host.as_str(), request.port),
            HostKeyPolicyClient::new(
                request.host_key_fingerprint.clone(),
                remote_forwards.clone(),
            ),
        )
        .await
        .map_err(format_russh_error)?;

        authenticate_russh_handle(&mut handle, request, None).await?;

        Ok(Self {
            handle,
            channel_id: None,
            channel_read: None,
            channel_write: None,
            remote_forwards,
            term: resolve_ssh_term(request.term.as_deref()),
        })
    }

    async fn connect_with_keyboard_interactive(
        request: &SshConnectRequest,
        keyboard_interactive: Option<&KeyboardInteractiveBroker>,
    ) -> Result<Self, String> {
        let config = russh::client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let remote_forwards = Arc::new(AsyncMutex::new(HashMap::new()));
        let mut handle = russh::client::connect(
            Arc::new(config),
            (request.host.as_str(), request.port),
            HostKeyPolicyClient::new(
                request.host_key_fingerprint.clone(),
                remote_forwards.clone(),
            ),
        )
        .await
        .map_err(format_russh_error)?;

        authenticate_russh_handle(&mut handle, request, keyboard_interactive).await?;

        Ok(Self {
            handle,
            channel_id: None,
            channel_read: None,
            channel_write: None,
            remote_forwards,
            term: resolve_ssh_term(request.term.as_deref()),
        })
    }

    pub async fn open_shell(&mut self, size: SshShellSize) -> Result<(), String> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(format_russh_error)?;
        channel
            .request_pty(
                true,
                &self.term,
                size.cols as u32,
                size.rows as u32,
                0,
                0,
                &[],
            )
            .await
            .map_err(format_russh_error)?;
        channel
            .request_shell(true)
            .await
            .map_err(format_russh_error)?;
        self.channel_id = Some(channel.id());
        let (read_half, write_half) = channel.split();
        self.channel_read = Some(read_half);
        self.channel_write = Some(write_half);
        Ok(())
    }

    pub async fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let channel_id = self
            .channel_id
            .ok_or_else(|| "SSH shell channel is not open".to_owned())?;
        self.handle
            .data(channel_id, bytes.to_vec())
            .await
            .map_err(|bytes| format!("failed to queue SSH data: {} bytes", bytes.len()))
    }

    pub async fn resize(&self, size: SshShellSize) -> Result<(), String> {
        let channel_write = self
            .channel_write
            .as_ref()
            .ok_or_else(|| "SSH shell channel is not open".to_owned())?;
        channel_write
            .window_change(size.cols as u32, size.rows as u32, 0, 0)
            .await
            .map_err(format_russh_error)
    }

    pub async fn keepalive(&self) -> Result<(), String> {
        self.handle.send_ping().await.map_err(format_russh_error)
    }

    pub async fn open_direct_tcpip(
        &self,
        target_host: String,
        target_port: u16,
        originator_host: String,
        originator_port: u16,
    ) -> Result<russh::Channel<russh::client::Msg>, String> {
        self.handle
            .channel_open_direct_tcpip(
                target_host,
                u32::from(target_port),
                originator_host,
                u32::from(originator_port),
            )
            .await
            .map_err(format_russh_error)
    }

    pub async fn start_remote_port_forward(
        &self,
        request: &SshRemotePortForwardRequest,
    ) -> Result<u16, String> {
        if request.bind_port != 0 {
            self.remote_forwards.lock().await.insert(
                (request.bind_host.clone(), u32::from(request.bind_port)),
                RemoteForwardTarget {
                    host: request.target_host.clone(),
                    port: request.target_port,
                },
            );
        }
        let assigned_port = match self
            .handle
            .tcpip_forward(request.bind_host.clone(), u32::from(request.bind_port))
            .await
        {
            Ok(assigned_port) => assigned_port,
            Err(error) => {
                if request.bind_port != 0 {
                    self.remote_forwards
                        .lock()
                        .await
                        .remove(&(request.bind_host.clone(), u32::from(request.bind_port)));
                }
                return Err(format_russh_error(error));
            }
        };
        let bind_port = if request.bind_port == 0 {
            u16::try_from(assigned_port).map_err(|_| {
                format!("SSH remote port forward assigned invalid port: {assigned_port}")
            })?
        } else {
            request.bind_port
        };
        if request.bind_port == 0 {
            self.remote_forwards.lock().await.insert(
                (request.bind_host.clone(), u32::from(bind_port)),
                RemoteForwardTarget {
                    host: request.target_host.clone(),
                    port: request.target_port,
                },
            );
        }
        Ok(bind_port)
    }

    pub async fn stop_remote_port_forward(
        &self,
        bind_host: &str,
        bind_port: u16,
    ) -> Result<(), String> {
        self.remote_forwards
            .lock()
            .await
            .remove(&(bind_host.to_owned(), u32::from(bind_port)));
        self.handle
            .cancel_tcpip_forward(bind_host.to_owned(), u32::from(bind_port))
            .await
            .map_err(format_russh_error)
    }

    pub async fn close(&mut self) -> Result<(), String> {
        if let Some(channel_write) = self.channel_write.take() {
            channel_write.close().await.map_err(format_russh_error)?;
        }
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .map_err(format_russh_error)
    }

    pub async fn next_data(&mut self, session_id: &str, seq: u64) -> Option<SshData> {
        let channel = self.channel_read.as_mut()?;
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => {
                    let bytes = data.to_vec();
                    let osc_metadata = extract_osc_metadata(&bytes);
                    return Some(SshData {
                        session_id: session_id.to_owned(),
                        seq,
                        bytes,
                        current_dir: osc_metadata.current_dir,
                        clipboard_text: osc_metadata.clipboard_text,
                    });
                }
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    let bytes = data.to_vec();
                    let osc_metadata = extract_osc_metadata(&bytes);
                    return Some(SshData {
                        session_id: session_id.to_owned(),
                        seq,
                        bytes,
                        current_dir: osc_metadata.current_dir,
                        clipboard_text: osc_metadata.clipboard_text,
                    });
                }
                _ => {}
            }
        }
        None
    }

    fn take_channel_read(&mut self) -> Result<russh::ChannelReadHalf, String> {
        self.channel_read
            .take()
            .ok_or_else(|| "SSH shell channel is not open".to_owned())
    }
}

impl RusshSftpTransport {
    pub async fn connect(request: &SshConnectRequest) -> Result<Self, String> {
        let config = russh::client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let mut handle = russh::client::connect(
            Arc::new(config),
            (request.host.as_str(), request.port),
            HostKeyPolicyClient::new(
                request.host_key_fingerprint.clone(),
                Arc::new(AsyncMutex::new(HashMap::new())),
            ),
        )
        .await
        .map_err(format_russh_error)?;

        authenticate_russh_handle(&mut handle, request, None).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(format_russh_error)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(format_russh_error)?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(format_sftp_error)?;

        Ok(Self { handle, sftp })
    }

    pub async fn close(&mut self) -> Result<(), String> {
        let _ = self.sftp.close().await;
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .map_err(format_russh_error)
    }
}

async fn authenticate_password_or_keyboard_interactive(
    handle: &mut russh::client::Handle<HostKeyPolicyClient>,
    username: &str,
    password: &str,
) -> Result<bool, String> {
    let password_result = handle
        .authenticate_password(username.to_owned(), password.to_owned())
        .await
        .map_err(format_russh_error)?;
    if password_result.success() {
        return Ok(true);
    }

    authenticate_keyboard_interactive_password(handle, username, password).await
}

async fn authenticate_keyboard_interactive_password(
    handle: &mut russh::client::Handle<HostKeyPolicyClient>,
    username: &str,
    password: &str,
) -> Result<bool, String> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username.to_owned(), None::<String>)
        .await
        .map_err(format_russh_error)?;
    let mut rounds = 0_u8;

    loop {
        match response {
            russh::client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            russh::client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                rounds = rounds.saturating_add(1);
                if rounds > 8 {
                    return Err(
                        "SSH keyboard-interactive authentication exceeded prompt limit".to_owned(),
                    );
                }
                response = handle
                    .authenticate_keyboard_interactive_respond(
                        prompts.iter().map(|_| password.to_owned()).collect(),
                    )
                    .await
                    .map_err(format_russh_error)?;
            }
        }
    }
}

async fn authenticate_keyboard_interactive_prompted(
    handle: &mut russh::client::Handle<HostKeyPolicyClient>,
    username: &str,
    broker: &KeyboardInteractiveBroker,
) -> Result<bool, String> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username.to_owned(), None::<String>)
        .await
        .map_err(format_russh_error)?;
    let mut rounds = 0_u8;

    loop {
        match response {
            russh::client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
                ..
            } => {
                rounds = rounds.saturating_add(1);
                if rounds > 8 {
                    return Err(
                        "SSH keyboard-interactive authentication exceeded prompt limit".to_owned(),
                    );
                }
                let prompt_count = prompts.len();
                let responses = broker
                    .prompt(
                        name,
                        instructions,
                        prompts
                            .iter()
                            .map(|prompt| SshKeyboardInteractivePrompt {
                                prompt: prompt.prompt.clone(),
                                echo: prompt.echo,
                            })
                            .collect(),
                    )
                    .await?;
                if responses.len() != prompt_count {
                    return Err(format!(
                        "SSH keyboard-interactive response count mismatch: expected {prompt_count}, got {}",
                        responses.len()
                    ));
                }
                response = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(format_russh_error)?;
            }
        }
    }
}

fn format_russh_error(error: russh::Error) -> String {
    format!("russh transport error: {error}")
}

fn is_loopback_bind_host(bind_host: &str) -> bool {
    matches!(bind_host.trim(), "localhost" | "127.0.0.1" | "::1")
}

fn spawn_local_port_forward_listener(
    listener: TcpListener,
    transport: SharedRusshTransport,
    request: SshLocalPortForwardRequest,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((socket, originator_addr)) = listener.accept().await else {
                break;
            };
            let transport = transport.clone();
            let target_host = request.target_host.clone();
            let target_port = request.target_port;
            tokio::spawn(async move {
                let channel = {
                    let transport = transport.lock().await;
                    transport
                        .open_direct_tcpip(
                            target_host,
                            target_port,
                            originator_addr.ip().to_string(),
                            originator_addr.port(),
                        )
                        .await
                };
                let Ok(channel) = channel else {
                    return;
                };
                let _ = pipe_local_forward(socket, channel).await;
            });
        }
    })
}

fn spawn_dynamic_socks_forward_listener(
    listener: TcpListener,
    transport: SharedRusshTransport,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((socket, originator_addr)) = listener.accept().await else {
                break;
            };
            let transport = transport.clone();
            tokio::spawn(async move {
                let _ = pipe_dynamic_socks_forward(socket, transport, originator_addr).await;
            });
        }
    })
}

async fn pipe_local_forward(
    mut socket: TcpStream,
    channel: russh::Channel<russh::client::Msg>,
) -> Result<(), String> {
    let mut channel_stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut channel_stream)
        .await
        .map(|_| ())
        .map_err(|error| format!("SSH local port forward copy failed: {error}"))
}

struct Socks5ConnectTarget {
    host: String,
    port: u16,
}

async fn pipe_dynamic_socks_forward(
    mut socket: TcpStream,
    transport: SharedRusshTransport,
    originator_addr: std::net::SocketAddr,
) -> Result<(), String> {
    let target = read_socks5_connect_target(&mut socket).await?;
    let channel = {
        let transport = transport.lock().await;
        transport
            .open_direct_tcpip(
                target.host.clone(),
                target.port,
                originator_addr.ip().to_string(),
                originator_addr.port(),
            )
            .await
    };
    let channel = match channel {
        Ok(channel) => channel,
        Err(error) => {
            let _ = write_socks5_reply(&mut socket, 0x01).await;
            return Err(error);
        }
    };
    write_socks5_reply(&mut socket, 0x00).await?;
    pipe_local_forward(socket, channel).await
}

async fn read_socks5_connect_target(socket: &mut TcpStream) -> Result<Socks5ConnectTarget, String> {
    let mut greeting = [0_u8; 2];
    socket
        .read_exact(&mut greeting)
        .await
        .map_err(|error| format!("failed to read SOCKS5 greeting: {error}"))?;
    if greeting[0] != 0x05 {
        return Err("SOCKS proxy only supports SOCKS5".to_owned());
    }
    if greeting[1] == 0 {
        let _ = socket.write_all(&[0x05, 0xff]).await;
        return Err("SOCKS5 client did not offer any authentication method".to_owned());
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    socket
        .read_exact(&mut methods)
        .await
        .map_err(|error| format!("failed to read SOCKS5 authentication methods: {error}"))?;
    if !methods.contains(&0x00) {
        let _ = socket.write_all(&[0x05, 0xff]).await;
        return Err("SOCKS5 client did not offer no-authentication mode".to_owned());
    }
    socket
        .write_all(&[0x05, 0x00])
        .await
        .map_err(|error| format!("failed to write SOCKS5 method selection: {error}"))?;

    let mut request = [0_u8; 4];
    socket
        .read_exact(&mut request)
        .await
        .map_err(|error| format!("failed to read SOCKS5 connect request: {error}"))?;
    if request[0] != 0x05 {
        let _ = write_socks5_reply(socket, 0x01).await;
        return Err("SOCKS proxy only supports SOCKS5 requests".to_owned());
    }
    if request[1] != 0x01 {
        let _ = write_socks5_reply(socket, 0x07).await;
        return Err("SOCKS5 proxy only supports CONNECT commands".to_owned());
    }
    if request[2] != 0x00 {
        let _ = write_socks5_reply(socket, 0x01).await;
        return Err("SOCKS5 request reserved byte must be zero".to_owned());
    }

    let host = match request[3] {
        0x01 => {
            let mut octets = [0_u8; 4];
            socket
                .read_exact(&mut octets)
                .await
                .map_err(|error| format!("failed to read SOCKS5 IPv4 address: {error}"))?;
            Ipv4Addr::from(octets).to_string()
        }
        0x03 => {
            let mut len = [0_u8; 1];
            socket
                .read_exact(&mut len)
                .await
                .map_err(|error| format!("failed to read SOCKS5 domain length: {error}"))?;
            if len[0] == 0 {
                let _ = write_socks5_reply(socket, 0x04).await;
                return Err("SOCKS5 domain target must not be empty".to_owned());
            }
            let mut name = vec![0_u8; len[0] as usize];
            socket
                .read_exact(&mut name)
                .await
                .map_err(|error| format!("failed to read SOCKS5 domain target: {error}"))?;
            String::from_utf8(name)
                .map_err(|_| "SOCKS5 domain target must be valid UTF-8".to_owned())?
        }
        0x04 => {
            let mut octets = [0_u8; 16];
            socket
                .read_exact(&mut octets)
                .await
                .map_err(|error| format!("failed to read SOCKS5 IPv6 address: {error}"))?;
            Ipv6Addr::from(octets).to_string()
        }
        _ => {
            let _ = write_socks5_reply(socket, 0x08).await;
            return Err("SOCKS5 address type is not supported".to_owned());
        }
    };

    let mut port = [0_u8; 2];
    socket
        .read_exact(&mut port)
        .await
        .map_err(|error| format!("failed to read SOCKS5 target port: {error}"))?;
    let port = u16::from_be_bytes(port);
    if port == 0 {
        let _ = write_socks5_reply(socket, 0x04).await;
        return Err("SOCKS5 target port must be greater than zero".to_owned());
    }
    Ok(Socks5ConnectTarget { host, port })
}

async fn write_socks5_reply(socket: &mut TcpStream, status: u8) -> Result<(), String> {
    socket
        .write_all(&[0x05, status, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        .await
        .map_err(|error| format!("failed to write SOCKS5 reply: {error}"))
}

fn keepalive_status(session: &SessionSnapshot) -> &'static str {
    match session.state {
        SessionState::Reconnectable => "reconnectable",
        SessionState::Errored => "errored",
        SessionState::Closed => "closed",
        _ => "healthy",
    }
}

async fn wait_until_ssh_reader_resumes(
    sessions: &Arc<Mutex<SessionRegistry>>,
    session_id: &str,
) -> bool {
    loop {
        match ssh_reader_pause_state(sessions, session_id) {
            Some(false) => return true,
            Some(true) => tokio::time::sleep(Duration::from_millis(10)).await,
            None => return false,
        }
    }
}

fn ssh_reader_pause_state(
    sessions: &Arc<Mutex<SessionRegistry>>,
    session_id: &str,
) -> Option<bool> {
    sessions
        .lock()
        .ok()
        .and_then(|registry| registry.get(session_id).cloned())
        .and_then(|session| match session.state {
            SessionState::Closed | SessionState::Errored | SessionState::Reconnectable => None,
            SessionState::Starting | SessionState::Running | SessionState::Idle => {
                Some(session.reader_paused)
            }
        })
}

async fn mark_ssh_stream_closed(
    sessions: &Arc<Mutex<SessionRegistry>>,
    transports: &Arc<Mutex<HashMap<String, SharedRusshTransport>>>,
    session_id: &str,
    reason: String,
) -> Option<SessionSnapshot> {
    let transport = transports
        .lock()
        .ok()
        .and_then(|mut transports| transports.remove(session_id));
    if let Some(transport) = transport {
        let _ = transport.lock().await.close().await;
    }

    let mut registry = sessions.lock().ok()?;
    let state = registry
        .get(session_id)
        .map(|session| session.state.clone())?;
    match state {
        SessionState::Closed | SessionState::Errored | SessionState::Reconnectable => {
            registry.get(session_id).cloned()
        }
        SessionState::Starting | SessionState::Running | SessionState::Idle => {
            registry.close(session_id, reason).ok()
        }
    }
}

async fn mark_ssh_stream_interrupted(
    sessions: &Arc<Mutex<SessionRegistry>>,
    transports: &Arc<Mutex<HashMap<String, SharedRusshTransport>>>,
    session_id: &str,
    reason: String,
) -> Option<SessionSnapshot> {
    let transport = transports
        .lock()
        .ok()
        .and_then(|mut transports| transports.remove(session_id));
    if let Some(transport) = transport {
        let _ = transport.lock().await.close().await;
    }

    let mut registry = sessions.lock().ok()?;
    let state = registry
        .get(session_id)
        .map(|session| session.state.clone())?;
    match state {
        SessionState::Closed | SessionState::Errored | SessionState::Reconnectable => {
            registry.get(session_id).cloned()
        }
        SessionState::Starting | SessionState::Running | SessionState::Idle => {
            registry.mark_reconnectable(session_id, reason).ok()
        }
    }
}

fn resolve_ssh_term(term: Option<&str>) -> String {
    term.map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("xterm-256color")
        .to_owned()
}

fn validate_host_key_fingerprint(fingerprint: &str) -> Result<(), String> {
    let (algorithm, digest) = fingerprint.trim().split_once(':').ok_or_else(|| {
        "ssh_connect host_key_fingerprint must use SHA256:<digest> or SHA512:<digest>".to_owned()
    })?;

    let is_supported_algorithm =
        algorithm.eq_ignore_ascii_case("SHA256") || algorithm.eq_ignore_ascii_case("SHA512");
    if !is_supported_algorithm || digest.trim().is_empty() {
        return Err(
            "ssh_connect host_key_fingerprint must use SHA256:<digest> or SHA512:<digest>"
                .to_owned(),
        );
    }
    Ok(())
}

fn normalize_fingerprint(fingerprint: &str) -> String {
    let trimmed = fingerprint.trim();
    if let Some((algorithm, digest)) = trimmed.split_once(':') {
        format!("{}:{}", algorithm.to_ascii_uppercase(), digest.trim())
    } else {
        trimmed.to_owned()
    }
}

fn host_key_fingerprint_matches(expected: Option<&str>, server_public_key: &PublicKey) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let expected = normalize_fingerprint(expected);
    let sha256 = server_public_key.fingerprint(HashAlg::Sha256).to_string();
    let sha512 = server_public_key.fingerprint(HashAlg::Sha512).to_string();
    expected == sha256 || expected == sha512
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENSSH_ED25519_EXAMPLE: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti user@example.com";

    #[test]
    fn validates_host_key_fingerprint_shape() {
        assert!(validate_host_key_fingerprint(
            "SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ"
        )
        .is_ok());
        assert!(validate_host_key_fingerprint(
            "sha512:Uzll8lyDEi27GXkuC2Y3F8V6/uqa+G+ktmALrYQ+y2zVqJmzWi/7vcCgnV+mWf8fgnx8PvVFa4lNKJItA/wzUg"
        )
        .is_ok());
        assert!(validate_host_key_fingerprint("SHA256:").is_err());
        assert!(validate_host_key_fingerprint("md5:abc").is_err());
        assert!(validate_host_key_fingerprint("not-a-fingerprint").is_err());
    }

    #[test]
    fn host_key_policy_matches_sha256_or_sha512_fingerprint() {
        let key = PublicKey::from_openssh(OPENSSH_ED25519_EXAMPLE).unwrap();
        let sha512 = key.fingerprint(HashAlg::Sha512).to_string();

        assert!(host_key_fingerprint_matches(
            Some("SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ"),
            &key
        ));
        assert!(host_key_fingerprint_matches(Some(&sha512), &key));
        assert!(!host_key_fingerprint_matches(None, &key));
        assert!(!host_key_fingerprint_matches(Some("SHA256:wrong"), &key));
    }

    #[test]
    fn resolves_ssh_term_from_profile_or_default() {
        assert_eq!(resolve_ssh_term(Some("xterm-ghostty")), "xterm-ghostty");
        assert_eq!(
            resolve_ssh_term(Some("  screen-256color  ")),
            "screen-256color"
        );
        assert_eq!(resolve_ssh_term(Some("   ")), "xterm-256color");
        assert_eq!(resolve_ssh_term(None), "xterm-256color");
    }

    #[test]
    fn ssh_connect_accepts_empty_password() {
        let request = SshConnectRequest {
            host: "example.com".to_owned(),
            port: 22,
            username: "alice".to_owned(),
            auth: SshAuthMethod::Password {
                password: String::new(),
            },
            host_key_fingerprint: Some(
                "SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ".to_owned(),
            ),
            term: None,
            unsupported_features: vec![],
        };

        assert!(request.validate().is_ok());
    }

    #[test]
    fn ssh_auth_debug_redacts_secret_material() {
        let password = format!(
            "{:?}",
            SshAuthMethod::Password {
                password: "secret".to_owned(),
            }
        );
        let private_key = format!(
            "{:?}",
            SshAuthMethod::PrivateKey {
                private_key_path: "C:/Users/alice/.ssh/id_ed25519".to_owned(),
                passphrase: Some("secret".to_owned()),
            }
        );

        assert!(!password.contains("secret"));
        assert!(!private_key.contains("secret"));
        assert!(password.contains("<redacted>"));
        assert!(private_key.contains("<redacted>"));
    }

    #[tokio::test]
    async fn stream_clean_exit_marks_running_session_closed() {
        let sessions = Arc::new(Mutex::new(SessionRegistry::default()));
        let session_id = {
            let mut registry = sessions.lock().unwrap();
            let session = registry.create(SessionKind::Ssh);
            let session_id = session.session_id;
            registry
                .set_state(&session_id, SessionState::Running)
                .unwrap();
            session_id
        };
        let transports = Arc::new(Mutex::new(HashMap::new()));

        let snapshot = mark_ssh_stream_closed(
            &sessions,
            &transports,
            &session_id,
            "ssh-remote-shell-exited:0".to_owned(),
        )
        .await
        .expect("running SSH session should be marked closed");

        assert_eq!(snapshot.state, SessionState::Closed);
        assert_eq!(
            snapshot.close_reason.as_deref(),
            Some("ssh-remote-shell-exited:0")
        );
        assert!(transports.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stream_interruption_marks_running_session_reconnectable() {
        let sessions = Arc::new(Mutex::new(SessionRegistry::default()));
        let session_id = {
            let mut registry = sessions.lock().unwrap();
            let session = registry.create(SessionKind::Ssh);
            let session_id = session.session_id;
            registry
                .set_state(&session_id, SessionState::Running)
                .unwrap();
            registry.record_output(&session_id, 1024 * 1024).unwrap();
            session_id
        };
        let transports = Arc::new(Mutex::new(HashMap::new()));

        let snapshot = mark_ssh_stream_interrupted(
            &sessions,
            &transports,
            &session_id,
            "ssh-output-channel-closed".to_owned(),
        )
        .await
        .expect("running SSH session should be marked reconnectable");

        assert_eq!(snapshot.state, SessionState::Reconnectable);
        assert_eq!(
            snapshot.error_reason.as_deref(),
            Some("ssh-output-channel-closed")
        );
        assert!(transports.lock().unwrap().is_empty());
    }
}
