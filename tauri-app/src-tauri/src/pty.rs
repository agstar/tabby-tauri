use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
#[cfg(windows)]
use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::session::{SessionKind, SessionRegistry, SessionSnapshot, SessionState};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct PtySizeSpec {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct PtySpawnRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub size: PtySizeSpec,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct PtySpawnResponse {
    pub session: SessionSnapshot,
    pub pid: Option<u32>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct PtyChildProcess {
    pub pid: u32,
    pub ppid: u32,
    pub command: String,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct PtyData {
    pub session_id: String,
    pub seq: u64,
    pub bytes: Vec<u8>,
}

const PTY_OUTPUT_READ_BUFFER_BYTES: usize = 8192;
const PTY_OUTPUT_BATCH_FLUSH_DELAY: Duration = Duration::from_millis(8);
const PTY_OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;

impl PtySpawnRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.command.trim().is_empty() {
            return Err("pty_spawn command must not be empty".to_owned());
        }
        self.size.validate()?;
        Ok(())
    }
}

impl PtySizeSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.cols == 0 {
            return Err("pty cols must be greater than zero".to_owned());
        }
        if self.rows == 0 {
            return Err("pty rows must be greater than zero".to_owned());
        }
        Ok(())
    }
}

fn env_lookup_key(key: &str) -> String {
    if cfg!(windows) {
        key.to_ascii_lowercase()
    } else {
        key.to_owned()
    }
}

fn is_path_env_key(key: &str) -> bool {
    if cfg!(windows) {
        key.eq_ignore_ascii_case("Path")
    } else {
        key == "PATH"
    }
}

fn set_env_value(
    env: &mut Vec<(String, String)>,
    indexes: &mut HashMap<String, usize>,
    key: String,
    value: String,
) {
    if key.is_empty() {
        return;
    }

    let lookup = env_lookup_key(&key);
    if let Some(index) = indexes.get(&lookup).copied() {
        env[index].1 = value;
        return;
    }

    indexes.insert(lookup, env.len());
    env.push((key, value));
}

pub fn normalize_spawn_env(request_env: &[(String, String)]) -> Vec<(String, String)> {
    normalize_spawn_env_from(std::env::vars(), request_env)
}

pub fn prepare_spawn_env(request_env: &[(String, String)]) -> Vec<(String, String)> {
    let mut env = normalize_spawn_env(request_env);
    #[cfg(windows)]
    {
        let _ = install_default_ssh_keepalive_wrapper_in_env(&mut env);
    }
    env
}

pub fn normalize_spawn_env_from<I>(
    base_env: I,
    request_env: &[(String, String)],
) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut env = Vec::new();
    let mut indexes = HashMap::new();

    for (key, value) in base_env {
        set_env_value(&mut env, &mut indexes, key, value);
    }

    for (key, value) in request_env {
        if is_path_env_key(key) && value.is_empty() {
            continue;
        }
        set_env_value(&mut env, &mut indexes, key.clone(), value.clone());
    }

    env
}

#[cfg(windows)]
const SSH_KEEPALIVE_WRAPPER_DISABLE_ENV: &str = "TABBY_TAURI_DISABLE_SSH_KEEPALIVE_WRAPPER";
#[cfg(windows)]
const SSH_KEEPALIVE_WRAPPER_REAL_ENV: &str = "TABBY_TAURI_REAL_SSH";

#[cfg(windows)]
fn env_value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.as_str())
}

#[cfg(windows)]
fn rebuild_env_indexes(env: &[(String, String)]) -> HashMap<String, usize> {
    env.iter()
        .enumerate()
        .map(|(index, (key, _))| (env_lookup_key(key), index))
        .collect()
}

#[cfg(windows)]
fn is_truthy_env(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(windows)]
fn default_ssh_keepalive_wrapper_dir(env: &[(String, String)]) -> PathBuf {
    env_value(env, "LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("tabby-tauri"))
        .join("bin")
}

#[cfg(windows)]
fn strip_path_quotes(value: &str) -> &str {
    value.trim().trim_matches('"')
}

#[cfg(windows)]
fn find_real_ssh_exe(env: &[(String, String)]) -> Option<PathBuf> {
    if let Some(path) = env_value(env, "Path") {
        for entry in path
            .split(';')
            .map(strip_path_quotes)
            .filter(|entry| !entry.is_empty())
        {
            let candidate = PathBuf::from(entry).join("ssh.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    env_value(env, "SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("OpenSSH").join("ssh.exe"))
        .filter(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn path_contains_dir(path: &str, dir: &Path) -> bool {
    let dir = dir.to_string_lossy();
    path.split(';')
        .map(strip_path_quotes)
        .any(|entry| entry.eq_ignore_ascii_case(dir.as_ref()))
}

#[cfg(windows)]
fn prepend_dir_to_path_env(env: &mut Vec<(String, String)>, dir: &Path) {
    let current_path = env_value(env, "Path").unwrap_or_default();
    if path_contains_dir(current_path, dir) {
        return;
    }

    let mut indexes = rebuild_env_indexes(env);
    let key = env
        .iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case("Path"))
        .map(|(candidate, _)| candidate.clone())
        .unwrap_or_else(|| "Path".to_owned());
    let value = if current_path.is_empty() {
        dir.to_string_lossy().into_owned()
    } else {
        format!("{};{current_path}", dir.to_string_lossy())
    };
    set_env_value(env, &mut indexes, key, value);
}

#[cfg(windows)]
fn set_spawn_env(env: &mut Vec<(String, String)>, key: &str, value: String) {
    let mut indexes = rebuild_env_indexes(env);
    set_env_value(env, &mut indexes, key.to_owned(), value);
}

#[cfg(windows)]
pub fn install_default_ssh_keepalive_wrapper_in_env(
    env: &mut Vec<(String, String)>,
) -> Result<(), String> {
    if env_value(env, SSH_KEEPALIVE_WRAPPER_DISABLE_ENV)
        .map(is_truthy_env)
        .unwrap_or(false)
    {
        return Ok(());
    }

    let Some(real_ssh) = find_real_ssh_exe(env) else {
        return Ok(());
    };

    install_ssh_keepalive_wrapper_in_env(env, &default_ssh_keepalive_wrapper_dir(env), &real_ssh)
}

#[cfg(not(windows))]
pub fn install_default_ssh_keepalive_wrapper_in_env(
    _env: &mut Vec<(String, String)>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn install_ssh_keepalive_wrapper_in_env(
    env: &mut Vec<(String, String)>,
    wrapper_dir: &Path,
    real_ssh: &Path,
) -> Result<(), String> {
    std::fs::create_dir_all(wrapper_dir)
        .map_err(|error| format!("failed to create SSH keepalive wrapper directory: {error}"))?;
    std::fs::write(wrapper_dir.join("ssh.cmd"), ssh_keepalive_wrapper_script())
        .map_err(|error| format!("failed to write SSH keepalive wrapper script: {error}"))?;

    prepend_dir_to_path_env(env, wrapper_dir);
    set_spawn_env(
        env,
        SSH_KEEPALIVE_WRAPPER_REAL_ENV,
        real_ssh.to_string_lossy().into_owned(),
    );
    Ok(())
}

#[cfg(not(windows))]
pub fn install_ssh_keepalive_wrapper_in_env(
    _env: &mut Vec<(String, String)>,
    _wrapper_dir: &std::path::Path,
    _real_ssh: &std::path::Path,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn ssh_keepalive_wrapper_script() -> &'static str {
    "@echo off\r\n\
setlocal\r\n\
set \"TABBY_TAURI_SSH_EXE=%TABBY_TAURI_REAL_SSH%\"\r\n\
if not defined TABBY_TAURI_SSH_EXE (\r\n\
  echo Tabby Tauri SSH keepalive wrapper could not find real ssh.exe. 1>&2\r\n\
  exit /b 9009\r\n\
)\r\n\
\"%TABBY_TAURI_SSH_EXE%\" -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes %*\r\n\
exit /b %ERRORLEVEL%\r\n"
}

pub struct PtyManager {
    sessions: Arc<Mutex<SessionRegistry>>,
    handles: Mutex<HashMap<String, PtyHandle>>,
}

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    pid: Option<u32>,
    cwd: Option<String>,
}

impl PtyManager {
    pub fn new(sessions: Arc<Mutex<SessionRegistry>>) -> Self {
        Self {
            sessions,
            handles: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn(&self, request: PtySpawnRequest) -> Result<PtySpawnResponse, String> {
        request.validate()?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: request.size.rows,
                cols: request.size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("openpty failed: {error}"))?;

        let mut command = CommandBuilder::new(&request.command);
        for arg in &request.args {
            command.arg(arg);
        }
        if let Some(cwd) = &request.cwd {
            command.cwd(cwd);
        }
        for (key, value) in prepare_spawn_env(&request.env) {
            command.env(&key, &value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn_command failed: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("take_writer failed: {error}"))?;

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?;
        let session = sessions.create(SessionKind::Local);
        let session = sessions
            .set_state(&session.session_id, SessionState::Running)
            .map_err(|error| format!("{error:?}"))?;
        drop(sessions);

        let pid = child.process_id();
        let cwd = request.cwd.clone();
        self.handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())?
            .insert(
                session.session_id.clone(),
                PtyHandle {
                    master: pair.master,
                    child,
                    writer,
                    pid,
                    cwd: cwd.clone(),
                },
            );

        Ok(PtySpawnResponse { session, pid, cwd })
    }

    pub fn restore(&self, session_id: &str) -> Result<Option<PtySpawnResponse>, String> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())?;
        let Some(handle) = handles.get(session_id) else {
            return Ok(None);
        };
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?;
        let Some(session) = sessions.get(session_id).cloned() else {
            return Ok(None);
        };
        Ok(Some(PtySpawnResponse {
            session,
            pid: handle.pid,
            cwd: handle.cwd.clone(),
        }))
    }

    pub fn write(&self, session_id: &str, bytes: &[u8]) -> Result<SessionSnapshot, String> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())?;
        let handle = handles
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
        handle
            .writer
            .write_all(bytes)
            .map_err(|error| format!("pty write failed: {error}"))?;
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .record_input(session_id, bytes.len() as u64)
            .map_err(|error| format!("{error:?}"))
    }

    pub fn read_once(&self, session_id: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
        let mut reader = {
            let handles = self
                .handles
                .lock()
                .map_err(|_| "pty handle map lock poisoned".to_owned())?;
            let handle = handles
                .get(session_id)
                .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
            handle
                .master
                .try_clone_reader()
                .map_err(|error| format!("try_clone_reader failed: {error}"))?
        };

        let mut buffer = vec![0_u8; max_bytes.max(1)];
        let length = reader
            .read(&mut buffer)
            .map_err(|error| format!("pty read failed: {error}"))?;
        buffer.truncate(length);
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .record_output(session_id, length as u64)
            .map_err(|error| format!("{error:?}"))?;
        Ok(buffer)
    }

    pub fn stream(
        &self,
        session_id: String,
        channel: tauri::ipc::Channel<PtyData>,
    ) -> Result<(), String> {
        let mut reader = {
            let handles = self
                .handles
                .lock()
                .map_err(|_| "pty handle map lock poisoned".to_owned())?;
            let handle = handles
                .get(&session_id)
                .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
            handle
                .master
                .try_clone_reader()
                .map_err(|error| format!("try_clone_reader failed: {error}"))?
        };

        let (chunk_sender, chunk_receiver) = std::sync::mpsc::channel::<Vec<u8>>();
        let reader_sessions = self.sessions.clone();
        let reader_session_id = session_id.clone();
        thread::spawn(move || {
            let mut buffer = vec![0_u8; PTY_OUTPUT_READ_BUFFER_BYTES];
            loop {
                if is_reader_paused(&reader_sessions, &reader_session_id) {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }

                let length = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => length,
                    Err(_) => break,
                };
                if chunk_sender.send(buffer[..length].to_vec()).is_err() {
                    break;
                }
            }
        });

        let sessions = self.sessions.clone();
        thread::spawn(move || {
            let mut seq = 0_u64;
            while let Ok(first_chunk) = chunk_receiver.recv() {
                let mut bytes = first_chunk;
                let mut reader_ended = false;
                while bytes.len() < PTY_OUTPUT_BATCH_MAX_BYTES {
                    match chunk_receiver.recv_timeout(PTY_OUTPUT_BATCH_FLUSH_DELAY) {
                        Ok(chunk) => bytes.extend_from_slice(&chunk),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            reader_ended = true;
                            break;
                        }
                    }
                }
                let length = bytes.len() as u64;
                if let Ok(mut registry) = sessions.lock() {
                    let _ = registry.record_output(&session_id, length);
                }
                if channel
                    .send(PtyData {
                        session_id: session_id.clone(),
                        seq,
                        bytes,
                    })
                    .is_err()
                {
                    break;
                }
                seq = seq.saturating_add(1);
                if reader_ended {
                    break;
                }
            }
            if let Ok(mut registry) = sessions.lock() {
                if !matches!(
                    registry.get(&session_id).map(|session| &session.state),
                    Some(&SessionState::Closed)
                ) {
                    let _ = registry.close(&session_id, "pty-reader-ended");
                }
            }
        });
        Ok(())
    }

    pub fn resize(&self, session_id: &str, size: PtySizeSpec) -> Result<(), String> {
        size.validate()?;
        let handles = self
            .handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())?;
        let handle = handles
            .get(session_id)
            .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
        handle
            .master
            .resize(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("pty resize failed: {error}"))
    }

    pub fn kill(&self, session_id: &str) -> Result<SessionSnapshot, String> {
        let mut handle = self
            .handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())?
            .remove(session_id)
            .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
        handle
            .child
            .kill()
            .map_err(|error| format!("pty kill failed: {error}"))?;
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .close(session_id, "killed")
            .map_err(|error| format!("{error:?}"))
    }

    pub fn exists(&self, session_id: &str) -> Result<bool, String> {
        self.handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())
            .map(|handles| handles.contains_key(session_id))
    }

    pub fn get_pid(&self, session_id: &str) -> Result<Option<u32>, String> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())?;
        let handle = handles
            .get(session_id)
            .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
        Ok(handle.pid)
    }

    pub fn ack(&self, session_id: &str, length: u64) -> Result<SessionSnapshot, String> {
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .ack_output(session_id, length)
            .map_err(|error| format!("{error:?}"))
    }

    pub fn cwd(&self, session_id: &str) -> Result<Option<String>, String> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| "pty handle map lock poisoned".to_owned())?;
        let handle = handles
            .get(session_id)
            .ok_or_else(|| format!("unknown PTY session: {session_id}"))?;
        Ok(handle.cwd.clone())
    }

    pub fn true_pid(&self, session_id: &str) -> Result<Option<u32>, String> {
        let Some(root_pid) = self.get_pid(session_id)? else {
            return Ok(None);
        };
        Ok(self
            .children(session_id)?
            .first()
            .map(|child| child.pid)
            .or(Some(root_pid)))
    }

    pub fn children(&self, session_id: &str) -> Result<Vec<PtyChildProcess>, String> {
        let Some(root_pid) = self.get_pid(session_id)? else {
            return Ok(Vec::new());
        };
        collect_child_processes(root_pid)
    }
}

fn is_reader_paused(sessions: &Arc<Mutex<SessionRegistry>>, session_id: &str) -> bool {
    sessions
        .lock()
        .ok()
        .and_then(|registry| {
            registry
                .get(session_id)
                .map(|session| session.reader_paused)
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn collect_child_processes(root_pid: u32) -> Result<Vec<PtyChildProcess>, String> {
    #[derive(Clone)]
    struct ProcessEntry {
        pid: u32,
        ppid: u32,
        command: String,
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!("failed to snapshot process tree: {}", unsafe {
            GetLastError()
        }));
    }

    let mut entries = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let first = unsafe { Process32FirstW(snapshot, &mut entry as *mut PROCESSENTRY32W) };
    if first == 0 {
        let error = unsafe { GetLastError() };
        unsafe {
            CloseHandle(snapshot);
        }
        return Err(format!("failed to enumerate process snapshot: {error}"));
    }

    loop {
        entries.push(ProcessEntry {
            pid: entry.th32ProcessID,
            ppid: entry.th32ParentProcessID,
            command: windows_process_name(&entry.szExeFile),
        });

        let has_next = unsafe { Process32NextW(snapshot, &mut entry as *mut PROCESSENTRY32W) };
        if has_next == 0 {
            break;
        }
    }
    unsafe {
        CloseHandle(snapshot);
    }

    let mut by_parent: HashMap<u32, Vec<ProcessEntry>> = HashMap::new();
    for entry in entries {
        by_parent.entry(entry.ppid).or_default().push(entry);
    }

    let mut result = Vec::new();
    let mut queue = VecDeque::from([root_pid]);
    let mut visited = HashSet::from([root_pid]);
    while let Some(pid) = queue.pop_front() {
        if let Some(children) = by_parent.get(&pid) {
            for child in children {
                if visited.insert(child.pid) {
                    queue.push_back(child.pid);
                    result.push(PtyChildProcess {
                        pid: child.pid,
                        ppid: child.ppid,
                        command: child.command.clone(),
                    });
                }
            }
        }
    }

    Ok(result)
}

#[cfg(not(windows))]
fn collect_child_processes(_root_pid: u32) -> Result<Vec<PtyChildProcess>, String> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn windows_process_name(value: &[u16]) -> String {
    let end = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}
