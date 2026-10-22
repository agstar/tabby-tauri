use std::borrow::Cow;
use std::env;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key::{Algorithm, HashAlg, PrivateKey};
use russh::server::{self, Auth, Handler as ServerHandler, Server, Session};
use russh::{ChannelId, Pty};
use serde::Serialize;
use tabby_tauri::session::SessionRegistry;
use tabby_tauri::ssh::{
    SshAuthMethod, SshConnectRequest, SshDynamicPortForwardRequest, SshHostKeyScanRequest,
    SshKeepaliveProbeRequest, SshLocalPortForwardRequest, SshManager, SshRemotePortForwardRequest,
    SshShellSize, SshTransportTimeouts,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const COMMAND_MATRIX_LAST_PASS_MARKER: &str = "__TABBY_CMD_12_PASS__";

fn random_host_key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

fn smoke_request_from_env() -> Option<SshConnectRequest> {
    let host = env::var("TABBY_TAURI_SSH_HOST").ok()?;
    let username = env::var("TABBY_TAURI_SSH_USERNAME").ok()?;
    let port = env::var("TABBY_TAURI_SSH_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(22);
    let auth = if let Ok(password) = env::var("TABBY_TAURI_SSH_PASSWORD") {
        SshAuthMethod::Password { password }
    } else {
        SshAuthMethod::PrivateKey {
            private_key_path: env::var("TABBY_TAURI_SSH_KEY_PATH").ok()?,
            passphrase: env::var("TABBY_TAURI_SSH_KEY_PASSPHRASE").ok(),
        }
    };

    Some(SshConnectRequest {
        host,
        port,
        username,
        auth,
        host_key_fingerprint: env::var("TABBY_TAURI_SSH_HOST_KEY").ok(),
        term: None,
        unsupported_features: vec![],
    })
}

#[tokio::test]
async fn ssh_transport_smoke_uses_real_server_when_env_is_present() {
    let Some(request) = smoke_request_from_env() else {
        eprintln!(
            "skipping SSH transport smoke; set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH"
        );
        return;
    };

    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = request_with_scanned_host_key(&manager, request).await;
    let connected =
        tokio::time::timeout(Duration::from_secs(15), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.open_shell_transport(&session_id, SshShellSize { cols: 80, rows: 24 }),
    )
    .await
    .expect("ssh shell open timed out")
    .expect("ssh shell open failed");

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_transport(&session_id, b"echo tabby-tauri-smoke\n".to_vec()),
    )
    .await
    .expect("ssh write timed out")
    .expect("ssh write failed");
    read_until_contains(
        &manager,
        &session_id,
        "tabby-tauri-smoke",
        Duration::from_secs(15),
    )
    .await;

    let closed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.close_transport(&session_id, "smoke-complete"),
    )
    .await
    .expect("ssh close timed out")
    .expect("ssh close failed");

    assert_eq!(closed.close_reason.as_deref(), Some("smoke-complete"));
}

#[tokio::test]
async fn ssh_sftp_roundtrip_uses_real_server_when_env_is_present() {
    let Some(request) = smoke_request_from_env() else {
        eprintln!(
            "skipping SSH SFTP roundtrip; set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH"
        );
        return;
    };

    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = request_with_scanned_host_key(&manager, request).await;
    let connected = tokio::time::timeout(
        Duration::from_secs(15),
        manager.connect_sftp_transport(request),
    )
    .await
    .expect("ssh sftp connect timed out")
    .expect("ssh sftp connect failed");
    let session_id = connected.session.session_id;
    let remote_dir = format!("/tmp/tabby-tauri-sftp-{}", std::process::id());
    let remote_file = format!("{remote_dir}/roundtrip.txt");
    let payload = b"tabby-tauri-native-sftp-ok\n".to_vec();

    let test_result = async {
        manager.sftp_mkdir(&session_id, remote_dir.clone()).await?;
        let handle = manager
            .sftp_open(&session_id, remote_file.clone(), 0x00000002 | 0x00000008)
            .await?;
        manager
            .sftp_write_file_chunk(&handle.handle_id, payload.clone())
            .await?;
        manager.sftp_close_file(&handle.handle_id).await?;

        let stat = manager.sftp_stat(&session_id, remote_file.clone()).await?;
        assert_eq!(stat.name, "roundtrip.txt");
        assert_eq!(stat.size, payload.len() as u64);

        let names = manager
            .sftp_readdir(&session_id, remote_dir.clone())
            .await?
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "roundtrip.txt"));

        let handle = manager
            .sftp_open(&session_id, remote_file.clone(), 0x00000001)
            .await?;
        let read_back = manager
            .sftp_read_file_chunk(&handle.handle_id, 256 * 1024)
            .await?;
        manager.sftp_close_file(&handle.handle_id).await?;
        assert_eq!(read_back, payload);
        Ok::<(), String>(())
    }
    .await;

    let _ = manager.sftp_unlink(&session_id, remote_file).await;
    let _ = manager.sftp_rmdir(&session_id, remote_dir).await;
    let closed = manager
        .close_sftp_transport(&session_id, "sftp-roundtrip-complete")
        .await
        .expect("ssh sftp close failed");
    assert_eq!(
        closed.close_reason.as_deref(),
        Some("sftp-roundtrip-complete")
    );
    test_result.expect("ssh sftp roundtrip failed");
}

#[tokio::test]
async fn ssh_local_port_forward_uses_real_server_when_env_is_present() {
    let Some(request) = smoke_request_from_env() else {
        eprintln!(
            "skipping SSH local port-forward smoke; set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH"
        );
        return;
    };

    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = request_with_scanned_host_key(&manager, request).await;
    let target_port = request.port;
    let connected =
        tokio::time::timeout(Duration::from_secs(15), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    let forward = tokio::time::timeout(
        Duration::from_secs(10),
        manager.start_local_port_forward(SshLocalPortForwardRequest {
            session_id: session_id.clone(),
            bind_host: "127.0.0.1".to_owned(),
            bind_port: 0,
            target_host: "127.0.0.1".to_owned(),
            target_port,
        }),
    )
    .await
    .expect("local port forward start timed out")
    .expect("local port forward start failed");

    let mut socket = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((forward.bind_host.as_str(), forward.bind_port)),
    )
    .await
    .expect("local port forward connect timed out")
    .expect("local port forward connect failed");
    let mut banner = vec![0_u8; 64];
    let read = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut banner))
        .await
        .expect("local port forward banner read timed out")
        .expect("local port forward banner read failed");
    let banner = String::from_utf8_lossy(&banner[..read]);
    assert!(
        banner.starts_with("SSH-"),
        "expected SSH banner through local port forward, got {banner:?}"
    );

    manager
        .stop_port_forward(&forward.forward_id)
        .await
        .expect("local port forward stop failed");
    let closed = manager
        .close_transport(&session_id, "local-forward-real-smoke-complete")
        .await
        .expect("ssh close failed");
    assert_eq!(
        closed.close_reason.as_deref(),
        Some("local-forward-real-smoke-complete")
    );
}

#[tokio::test]
async fn ssh_dynamic_socks_forward_uses_real_server_when_env_is_present() {
    let Some(request) = smoke_request_from_env() else {
        eprintln!(
            "skipping SSH dynamic SOCKS forward smoke; set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH"
        );
        return;
    };

    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = request_with_scanned_host_key(&manager, request).await;
    let target_port = request.port;
    let connected =
        tokio::time::timeout(Duration::from_secs(15), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    let forward = tokio::time::timeout(
        Duration::from_secs(10),
        manager.start_dynamic_port_forward(SshDynamicPortForwardRequest {
            session_id: session_id.clone(),
            bind_host: "127.0.0.1".to_owned(),
            bind_port: 0,
        }),
    )
    .await
    .expect("dynamic SOCKS forward start timed out")
    .expect("dynamic SOCKS forward start failed");

    let mut socket = connect_socks5(
        forward.bind_host.as_str(),
        forward.bind_port,
        "127.0.0.1",
        target_port,
    )
    .await;
    let mut banner = vec![0_u8; 64];
    let read = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut banner))
        .await
        .expect("dynamic SOCKS banner read timed out")
        .expect("dynamic SOCKS banner read failed");
    let banner = String::from_utf8_lossy(&banner[..read]);
    assert!(
        banner.starts_with("SSH-"),
        "expected SSH banner through dynamic SOCKS forward, got {banner:?}"
    );

    manager
        .stop_port_forward(&forward.forward_id)
        .await
        .expect("dynamic SOCKS forward stop failed");
    manager
        .close_transport(&session_id, "dynamic-socks-smoke-complete")
        .await
        .expect("ssh close failed");
}

#[tokio::test]
#[ignore = "requires TABBY_TAURI_SSH_* real server env and may run for one hour"]
async fn ssh_transport_idle_soak_uses_real_server_when_env_is_present() {
    let Some(request) = smoke_request_from_env() else {
        eprintln!(
            "set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH"
        );
        return;
    };
    let idle_seconds = env::var("TABBY_TAURI_SSH_IDLE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(3600);
    let probes = env::var("TABBY_TAURI_SSH_KEEPALIVE_PROBES")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3);
    let interval_ms = env::var("TABBY_TAURI_SSH_KEEPALIVE_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1000);

    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = request_with_scanned_host_key(&manager, request).await;
    let connected =
        tokio::time::timeout(Duration::from_secs(15), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.open_shell_transport(&session_id, SshShellSize { cols: 80, rows: 24 }),
    )
    .await
    .expect("ssh shell open timed out")
    .expect("ssh shell open failed");

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_transport(&session_id, b"echo tabby-tauri-before-idle\n".to_vec()),
    )
    .await
    .expect("pre-idle write timed out")
    .expect("pre-idle write failed");
    read_until_contains(
        &manager,
        &session_id,
        "tabby-tauri-before-idle",
        Duration::from_secs(15),
    )
    .await;

    tokio::time::sleep(Duration::from_secs(idle_seconds)).await;

    let keepalive = tokio::time::timeout(
        Duration::from_secs(30),
        manager.keepalive_evaluator_transport(
            &session_id,
            SshKeepaliveProbeRequest {
                probes,
                interval_ms,
            },
        ),
    )
    .await
    .expect("ssh keepalive timed out")
    .expect("ssh keepalive failed");
    assert_eq!(keepalive.status, "healthy");
    assert_eq!(keepalive.probes_attempted, probes);
    assert_eq!(keepalive.probes_succeeded, probes);

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_transport(&session_id, b"echo tabby-tauri-after-idle\n".to_vec()),
    )
    .await
    .expect("post-idle write timed out")
    .expect("post-idle write failed");
    read_until_contains(
        &manager,
        &session_id,
        "tabby-tauri-after-idle",
        Duration::from_secs(15),
    )
    .await;

    let closed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.close_transport(&session_id, "idle-soak-complete"),
    )
    .await
    .expect("ssh close timed out")
    .expect("ssh close failed");

    assert_eq!(closed.close_reason.as_deref(), Some("idle-soak-complete"));
}

#[tokio::test]
async fn ssh_transport_command_matrix_uses_real_server_when_env_is_present() {
    let Some(request) = smoke_request_from_env() else {
        eprintln!(
            "skipping SSH command matrix; set TABBY_TAURI_SSH_HOST, TABBY_TAURI_SSH_USERNAME, and TABBY_TAURI_SSH_PASSWORD or TABBY_TAURI_SSH_KEY_PATH"
        );
        return;
    };

    let host = request.host.clone();
    let port = request.port;
    let username = request.username.clone();
    let commands = linux_command_matrix();
    assert!(
        commands.len() >= 10,
        "real remote command matrix must cover at least 10 commands"
    );

    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = request_with_scanned_host_key(&manager, request).await;
    let connected =
        tokio::time::timeout(Duration::from_secs(15), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.open_shell_transport(
            &session_id,
            SshShellSize {
                cols: 120,
                rows: 40,
            },
        ),
    )
    .await
    .expect("ssh shell open timed out")
    .expect("ssh shell open failed");

    let script = linux_command_matrix_script(&username);
    tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_transport(&session_id, script.into_bytes()),
    )
    .await
    .expect("ssh command matrix write timed out")
    .expect("ssh command matrix write failed");

    let output = read_until_contains(
        &manager,
        &session_id,
        "__TABBY_E2E_DONE__",
        Duration::from_secs(45),
    )
    .await;
    let results = commands
        .iter()
        .map(|command| RemoteCommandResult {
            index: command.index,
            name: command.name,
            input: command.input,
            expected: command.expected,
            passed: output.contains(&command.pass_marker()),
            output_excerpt: output_excerpt(&extract_command_output(&output, command.index)),
        })
        .collect::<Vec<_>>();
    let commands_passed = results.iter().filter(|result| result.passed).count();

    write_command_matrix_artifact_if_requested(CommandMatrixArtifact {
        scenario: "ssh-command-matrix",
        target: CommandMatrixTarget {
            host,
            port,
            username_present: true,
        },
        commands_total: results.len(),
        commands_passed,
        credential_values_redacted: true,
        raw_credentials_persisted: false,
        commands: &results,
    });

    let closed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.close_transport(&session_id, "command-matrix-complete"),
    )
    .await
    .expect("ssh close timed out")
    .expect("ssh close failed");
    assert_eq!(
        closed.close_reason.as_deref(),
        Some("command-matrix-complete")
    );

    assert!(
        output.contains(COMMAND_MATRIX_LAST_PASS_MARKER),
        "remote command stream should include the final command pass marker; raw output tail:\n{}",
        output_excerpt(&output).join("\n")
    );
    assert_eq!(
        commands_passed,
        results.len(),
        "all remote shell command inputs must return the expected output markers; raw output tail:\n{}",
        output_excerpt(&output).join("\n")
    );
}

#[derive(Clone, Copy)]
struct LinuxCommandExpectation {
    index: u8,
    name: &'static str,
    input: &'static str,
    expected: &'static str,
}

impl LinuxCommandExpectation {
    fn pass_marker(&self) -> String {
        format!("__TABBY_CMD_{:02}_PASS__", self.index)
    }
}

#[derive(Serialize)]
struct CommandMatrixArtifact<'a> {
    scenario: &'static str,
    target: CommandMatrixTarget,
    commands_total: usize,
    commands_passed: usize,
    credential_values_redacted: bool,
    raw_credentials_persisted: bool,
    commands: &'a [RemoteCommandResult],
}

#[derive(Serialize)]
struct CommandMatrixTarget {
    host: String,
    port: u16,
    username_present: bool,
}

#[derive(Serialize)]
struct RemoteCommandResult {
    index: u8,
    name: &'static str,
    input: &'static str,
    expected: &'static str,
    passed: bool,
    output_excerpt: Vec<String>,
}

fn linux_command_matrix() -> Vec<LinuxCommandExpectation> {
    vec![
        LinuxCommandExpectation {
            index: 1,
            name: "whoami",
            input: "whoami",
            expected: "current SSH username",
        },
        LinuxCommandExpectation {
            index: 2,
            name: "uname",
            input: "uname -s",
            expected: "Linux",
        },
        LinuxCommandExpectation {
            index: 3,
            name: "pwd",
            input: "pwd",
            expected: "non-empty output",
        },
        LinuxCommandExpectation {
            index: 4,
            name: "id_un",
            input: "id -un",
            expected: "current SSH username",
        },
        LinuxCommandExpectation {
            index: 5,
            name: "id_u",
            input: "id -u",
            expected: "non-empty output",
        },
        LinuxCommandExpectation {
            index: 6,
            name: "hostname",
            input: "hostname",
            expected: "non-empty output",
        },
        LinuxCommandExpectation {
            index: 7,
            name: "shell_path",
            input: "command -v sh",
            expected: "sh",
        },
        LinuxCommandExpectation {
            index: 8,
            name: "arithmetic",
            input: "sh -c 'echo $((6*7))'",
            expected: "42",
        },
        LinuxCommandExpectation {
            index: 9,
            name: "tmp_listing",
            input: "ls -ld /tmp",
            expected: "/tmp",
        },
        LinuxCommandExpectation {
            index: 10,
            name: "tmp_file_roundtrip",
            input: "printf tabby-tauri-file-ok > /tmp/tabby-tauri-e2e-$$.txt; cat /tmp/tabby-tauri-e2e-$$.txt; rm -f /tmp/tabby-tauri-e2e-$$.txt",
            expected: "tabby-tauri-file-ok",
        },
        LinuxCommandExpectation {
            index: 11,
            name: "disk_usage",
            input: "df -P /",
            expected: "non-empty output",
        },
        LinuxCommandExpectation {
            index: 12,
            name: "utc_date",
            input: "date -u +%Y-%m-%d",
            expected: "non-empty output",
        },
    ]
}

fn linux_command_matrix_script(username: &str) -> String {
    format!(
        r#"sh <<'__TABBY_E2E_SCRIPT__'
expected_user={expected_user}

run_contains() {{
  idx="$1"
  name="$2"
  expected="$3"
  shift 3
  marker=$(printf '%02d' "$idx")
  printf '\n__TABBY_CMD_%s_BEGIN__\n' "$marker"
  printf '__TABBY_CMD_%s_INPUT__ %s\n' "$marker" "$*"
  output="$("$@" 2>&1)"
  rc=$?
  printf '%s\n' "$output"
  if [ "$rc" -eq 0 ] && printf '%s' "$output" | grep -F "$expected" >/dev/null 2>&1; then
    printf '__TABBY_CMD_%s_PASS__\n' "$marker"
  else
    printf '__TABBY_CMD_%s_FAIL__ rc=%s expected=%s name=%s\n' "$marker" "$rc" "$expected" "$name"
  fi
  printf '__TABBY_CMD_%s_END__\n' "$marker"
}}

run_nonempty() {{
  idx="$1"
  name="$2"
  shift 2
  marker=$(printf '%02d' "$idx")
  printf '\n__TABBY_CMD_%s_BEGIN__\n' "$marker"
  printf '__TABBY_CMD_%s_INPUT__ %s\n' "$marker" "$*"
  output="$("$@" 2>&1)"
  rc=$?
  printf '%s\n' "$output"
  if [ "$rc" -eq 0 ] && [ -n "$output" ]; then
    printf '__TABBY_CMD_%s_PASS__\n' "$marker"
  else
    printf '__TABBY_CMD_%s_FAIL__ rc=%s name=%s\n' "$marker" "$rc" "$name"
  fi
  printf '__TABBY_CMD_%s_END__\n' "$marker"
}}

tmp_file="/tmp/tabby-tauri-e2e-$$.txt"

run_contains 1 whoami "$expected_user" whoami
run_contains 2 uname Linux uname -s
run_nonempty 3 pwd pwd
run_contains 4 id_un "$expected_user" id -un
run_nonempty 5 id_u id -u
run_nonempty 6 hostname hostname
run_contains 7 shell_path sh command -v sh
run_contains 8 arithmetic 42 sh -c 'echo $((6*7))'
run_contains 9 tmp_listing /tmp ls -ld /tmp
printf 'tabby-tauri-file-ok\n' > "$tmp_file"
run_contains 10 tmp_file_roundtrip tabby-tauri-file-ok cat "$tmp_file"
rm -f "$tmp_file"
run_nonempty 11 disk_usage df -P /
run_nonempty 12 utc_date date -u +%Y-%m-%d
printf '\n%s%s\n' "__TABBY_E2E_" "DONE__"
__TABBY_E2E_SCRIPT__
"#,
        expected_user = sh_single_quote(username)
    )
}

fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn extract_command_output(output: &str, index: u8) -> String {
    let begin = format!("__TABBY_CMD_{index:02}_BEGIN__");
    let end = format!("__TABBY_CMD_{index:02}_END__");
    let Some(start) = output.find(&begin) else {
        return String::new();
    };
    let after_begin = &output[start + begin.len()..];
    let Some(end) = after_begin.find(&end) else {
        return after_begin.to_owned();
    };
    after_begin[..end].to_owned()
}

fn output_excerpt(output: &str) -> Vec<String> {
    let mut lines = output
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut excerpt = line.chars().take(180).collect::<String>();
            if line.chars().count() > 180 {
                excerpt.push('…');
            }
            excerpt
        })
        .collect::<Vec<_>>();
    let keep_from = lines.len().saturating_sub(40);
    lines.split_off(keep_from)
}

fn write_command_matrix_artifact_if_requested(artifact: CommandMatrixArtifact<'_>) {
    let Ok(path) = env::var("TABBY_TAURI_SSH_COMMAND_MATRIX_ARTIFACT") else {
        return;
    };
    let json = serde_json::to_string_pretty(&artifact).expect("serialize command matrix artifact");
    std::fs::write(path, format!("{json}\n")).expect("write command matrix artifact");
}

async fn read_until_contains(
    manager: &SshManager,
    session_id: &str,
    marker: &str,
    timeout: Duration,
) -> String {
    tokio::time::timeout(timeout, async {
        let mut seq = 0_u64;
        let mut output = String::new();
        loop {
            let data = manager
                .next_data_transport(session_id, seq)
                .await
                .expect("ssh read failed")
                .expect("ssh stream closed before marker was observed");
            output.push_str(&String::from_utf8_lossy(&data.bytes));
            manager
                .ack(session_id, data.bytes.len() as u64)
                .expect("ssh ack failed");
            if output.contains(marker) {
                return output;
            }
            seq = seq.saturating_add(1);
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for SSH output marker: {marker}"))
}

async fn request_with_scanned_host_key(
    manager: &SshManager,
    mut request: SshConnectRequest,
) -> SshConnectRequest {
    if request.host_key_fingerprint.is_none() {
        let scan = manager
            .scan_host_key(SshHostKeyScanRequest {
                host: request.host.clone(),
                port: request.port,
            })
            .await
            .expect("ssh host key scan failed");
        request.host_key_fingerprint = Some(scan.sha256);
    }
    request
}

async fn connect_socks5(
    bind_host: &str,
    bind_port: u16,
    target_host: &str,
    target_port: u16,
) -> TcpStream {
    let mut socket = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((bind_host, bind_port)),
    )
    .await
    .expect("SOCKS listener connect timed out")
    .expect("SOCKS listener connect failed");
    socket
        .write_all(&[0x05, 0x01, 0x00])
        .await
        .expect("SOCKS greeting write failed");
    let mut method = [0_u8; 2];
    socket
        .read_exact(&mut method)
        .await
        .expect("SOCKS method reply read failed");
    assert_eq!(method, [0x05, 0x00]);

    let host_bytes = target_host.as_bytes();
    assert!(
        host_bytes.len() <= u8::MAX as usize,
        "SOCKS target host is too long for one-byte domain length"
    );
    let mut request = vec![0x05, 0x01, 0x00, 0x03, host_bytes.len() as u8];
    request.extend_from_slice(host_bytes);
    request.extend_from_slice(&target_port.to_be_bytes());
    socket
        .write_all(&request)
        .await
        .expect("SOCKS connect request write failed");
    let mut reply = [0_u8; 10];
    socket
        .read_exact(&mut reply)
        .await
        .expect("SOCKS connect reply read failed");
    assert_eq!(reply[0], 0x05);
    assert_eq!(reply[1], 0x00, "SOCKS connect failed with reply {reply:?}");
    socket
}

async fn spawn_tcp_echo_target() -> (String, u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind local TCP echo target");
    let addr = listener
        .local_addr()
        .expect("inspect local TCP echo target");
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let (mut reader, mut writer) = socket.split();
                let _ = tokio::io::copy(&mut reader, &mut writer).await;
            });
        }
    });
    (addr.ip().to_string(), addr.port(), task)
}

#[derive(Clone)]
struct EchoSshServer {
    username: &'static str,
    password: &'static str,
    accept_password_auth: bool,
    channel_open_delay: Duration,
    reply_to_shell_request: bool,
    shell_reply_delay: Duration,
    remote_forward_payload: Option<Vec<u8>>,
    remote_forward_channels: Arc<Mutex<Vec<ChannelId>>>,
    remote_forward_echoes: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl Server for EchoSshServer {
    type Handler = Self;

    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl ServerHandler for EchoSshServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if self.accept_password_auth && user == self.username && password == self.password {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _: &str,
        mut response: Option<server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        if user != self.username {
            return Ok(Auth::reject());
        }

        let Some(response) = response.as_mut() else {
            return Ok(Auth::Partial {
                name: Cow::Borrowed("password"),
                instructions: Cow::Borrowed(""),
                prompts: Cow::Owned(vec![(Cow::Borrowed("Password: "), false)]),
            });
        };

        let password = response.next().unwrap_or_default();
        if password.as_ref() == self.password.as_bytes() {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _: russh::Channel<server::Msg>,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        if !self.channel_open_delay.is_zero() {
            tokio::time::sleep(self.channel_open_delay).await;
        }
        Ok(true)
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        _: russh::Channel<server::Msg>,
        _: &str,
        _: u32,
        _: &str,
        _: u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.shell_reply_delay.is_zero() {
            tokio::time::sleep(self.shell_reply_delay).await;
        }
        if self.reply_to_shell_request {
            session.channel_success(channel)?;
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self
            .remote_forward_channels
            .lock()
            .expect("remote forward channel registry lock")
            .contains(&channel)
        {
            self.remote_forward_echoes
                .lock()
                .expect("remote forward echo registry lock")
                .push(data.to_vec());
            session.close(channel)?;
            return Ok(());
        }
        session.data(channel, data.to_vec())?;
        Ok(())
    }

    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let Some(payload) = self.remote_forward_payload.clone() else {
            return Ok(false);
        };
        if *port == 0 {
            *port = 41080;
        }
        let handle = session.handle();
        let address = address.to_owned();
        let connected_port = *port;
        let channels = self.remote_forward_channels.clone();
        tokio::spawn(async move {
            let Ok(channel) = handle
                .channel_open_forwarded_tcpip(address, connected_port, "127.0.0.1", 65000)
                .await
            else {
                return;
            };
            channels
                .lock()
                .expect("remote forward channel registry lock")
                .push(channel.id());
            let _ = channel.data(&*payload).await;
            let _ = channel.eof().await;
        });
        Ok(true)
    }

    async fn cancel_tcpip_forward(
        &mut self,
        _address: &str,
        _port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn spawn_echo_server(accept_password_auth: bool) -> (String, u16, String) {
    spawn_echo_server_with_options(accept_password_auth, true, Duration::ZERO, Duration::ZERO).await
}

async fn spawn_echo_server_with_options(
    accept_password_auth: bool,
    reply_to_shell_request: bool,
    channel_open_delay: Duration,
    shell_reply_delay: Duration,
) -> (String, u16, String) {
    let host_key = random_host_key();
    let fingerprint = host_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let mut config = server::Config {
        auth_rejection_time: Duration::from_millis(10),
        ..Default::default()
    };
    config.keys.push(host_key);
    let config = Arc::new(config);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut server = EchoSshServer {
        username: "tabby",
        password: "secret",
        accept_password_auth,
        channel_open_delay,
        reply_to_shell_request,
        shell_reply_delay,
        remote_forward_payload: None,
        remote_forward_channels: Arc::new(Mutex::new(Vec::new())),
        remote_forward_echoes: Arc::new(Mutex::new(Vec::new())),
    };

    tokio::spawn(async move {
        let (socket, peer) = listener.accept().await.unwrap();
        let handler = server.new_client(Some(peer));
        let _ = server::run_stream(config, socket, handler).await;
    });

    (addr.ip().to_string(), addr.port(), fingerprint)
}

async fn spawn_echo_server_with_remote_forward_probe(
    payload: Vec<u8>,
) -> (String, u16, String, Arc<Mutex<Vec<Vec<u8>>>>) {
    let host_key = random_host_key();
    let fingerprint = host_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let mut config = server::Config {
        auth_rejection_time: Duration::from_millis(10),
        ..Default::default()
    };
    config.keys.push(host_key);
    let config = Arc::new(config);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let echoes = Arc::new(Mutex::new(Vec::new()));
    let mut server = EchoSshServer {
        username: "tabby",
        password: "secret",
        accept_password_auth: true,
        channel_open_delay: Duration::ZERO,
        reply_to_shell_request: true,
        shell_reply_delay: Duration::ZERO,
        remote_forward_payload: Some(payload),
        remote_forward_channels: Arc::new(Mutex::new(Vec::new())),
        remote_forward_echoes: echoes.clone(),
    };

    tokio::spawn(async move {
        let (socket, peer) = listener.accept().await.unwrap();
        let handler = server.new_client(Some(peer));
        let _ = server::run_stream(config, socket, handler).await;
    });

    (addr.ip().to_string(), addr.port(), fingerprint, echoes)
}

#[tokio::test]
async fn ssh_open_shell_timeout_marks_session_reconnectable_and_removes_transport() {
    let (host, port, fingerprint) =
        spawn_echo_server_with_options(true, true, Duration::from_secs(1), Duration::ZERO).await;
    let manager = SshManager::with_timeouts(
        Arc::new(Mutex::new(SessionRegistry::default())),
        SshTransportTimeouts {
            connect: Duration::from_secs(10),
            open_shell: Duration::from_millis(50),
        },
    );
    let request = SshConnectRequest {
        host,
        port,
        username: "tabby".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some(fingerprint),
        term: None,
        unsupported_features: vec![],
    };

    let connected =
        tokio::time::timeout(Duration::from_secs(10), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    let error = manager
        .open_shell_transport(&session_id, SshShellSize { cols: 80, rows: 24 })
        .await
        .expect_err("shell open must time out when the server delays channel_open_session");

    assert!(error.contains("open shell timed out"));
    let snapshot = manager
        .state(&session_id)
        .expect("session lookup failed")
        .expect("timed-out session should remain observable");
    assert_eq!(
        snapshot.state,
        tabby_tauri::session::SessionState::Reconnectable
    );
    assert!(snapshot
        .error_reason
        .as_deref()
        .unwrap_or_default()
        .contains("open shell timed out"));
    assert!(
        manager.keepalive_transport(&session_id).await.is_err(),
        "timed-out shell startup must remove the backend transport to avoid orphaned SSH sessions",
    );
}

#[tokio::test]
async fn ssh_transport_smoke_runs_against_in_process_server() {
    let (host, port, fingerprint) = spawn_echo_server(true).await;
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = SshConnectRequest {
        host,
        port,
        username: "tabby".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some(fingerprint),
        term: None,
        unsupported_features: vec![],
    };

    let connected =
        tokio::time::timeout(Duration::from_secs(10), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.open_shell_transport(&session_id, SshShellSize { cols: 80, rows: 24 }),
    )
    .await
    .expect("ssh shell open timed out")
    .expect("ssh shell open failed");

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.resize_transport(
            &session_id,
            SshShellSize {
                cols: 100,
                rows: 32,
            },
        ),
    )
    .await
    .expect("ssh resize timed out")
    .expect("ssh resize failed");

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_transport(&session_id, b"echo tabby-tauri-smoke\n".to_vec()),
    )
    .await
    .expect("ssh write timed out")
    .expect("ssh write failed");

    let echoed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.next_data_transport(&session_id, 0),
    )
    .await
    .expect("ssh read timed out")
    .expect("ssh read failed")
    .expect("ssh server closed before echoing smoke command");
    assert_eq!(echoed.bytes, b"echo tabby-tauri-smoke\n");
    manager
        .ack(&session_id, echoed.bytes.len() as u64)
        .expect("ssh ack failed");

    let keepalive = tokio::time::timeout(
        Duration::from_secs(10),
        manager.keepalive_evaluator_transport(
            &session_id,
            SshKeepaliveProbeRequest {
                probes: 2,
                interval_ms: 1,
            },
        ),
    )
    .await
    .expect("ssh keepalive timed out")
    .expect("ssh keepalive failed");
    assert_eq!(keepalive.status, "healthy");
    assert_eq!(keepalive.probes_succeeded, 2);
    assert_eq!(
        keepalive.session.state,
        tabby_tauri::session::SessionState::Running
    );

    tokio::time::sleep(Duration::from_millis(5)).await;
    tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_transport(&session_id, b"echo tabby-tauri-after-idle\n".to_vec()),
    )
    .await
    .expect("post-idle write timed out")
    .expect("post-idle write failed");
    let post_idle_echo = tokio::time::timeout(
        Duration::from_secs(10),
        manager.next_data_transport(&session_id, 1),
    )
    .await
    .expect("post-idle read timed out")
    .expect("post-idle read failed")
    .expect("ssh server closed before echoing post-idle command");
    assert_eq!(post_idle_echo.bytes, b"echo tabby-tauri-after-idle\n");

    let closed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.close_transport(&session_id, "in-process-smoke-complete"),
    )
    .await
    .expect("ssh close timed out")
    .expect("ssh close failed");

    assert_eq!(
        closed.close_reason.as_deref(),
        Some("in-process-smoke-complete")
    );
}

#[tokio::test]
async fn ssh_local_port_forward_roundtrips_against_in_process_server() {
    let (host, port, fingerprint) = spawn_echo_server(true).await;
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = SshConnectRequest {
        host,
        port,
        username: "tabby".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some(fingerprint),
        term: None,
        unsupported_features: vec![],
    };

    let connected =
        tokio::time::timeout(Duration::from_secs(10), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;
    let forward = tokio::time::timeout(
        Duration::from_secs(10),
        manager.start_local_port_forward(SshLocalPortForwardRequest {
            session_id: session_id.clone(),
            bind_host: "127.0.0.1".to_owned(),
            bind_port: 0,
            target_host: "127.0.0.1".to_owned(),
            target_port: 7,
        }),
    )
    .await
    .expect("local port forward start timed out")
    .expect("local port forward start failed");
    assert_eq!(forward.status, "listening");
    assert_eq!(forward.session_id, session_id);

    let mut socket = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((forward.bind_host.as_str(), forward.bind_port)),
    )
    .await
    .expect("local port forward connect timed out")
    .expect("local port forward connect failed");
    let payload = b"tabby-forward-ok";
    socket
        .write_all(payload)
        .await
        .expect("write to local port forward failed");
    let mut read_back = vec![0_u8; payload.len()];
    tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut read_back))
        .await
        .expect("local port forward read timed out")
        .expect("read from local port forward failed");
    assert_eq!(read_back, payload);

    manager
        .stop_port_forward(&forward.forward_id)
        .await
        .expect("local port forward stop failed");
    manager
        .close_transport(&session_id, "local-forward-smoke-complete")
        .await
        .expect("ssh close failed");
}

#[tokio::test]
async fn ssh_dynamic_socks_forward_roundtrips_against_in_process_server() {
    let (host, port, fingerprint) = spawn_echo_server(true).await;
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = SshConnectRequest {
        host,
        port,
        username: "tabby".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some(fingerprint),
        term: None,
        unsupported_features: vec![],
    };

    let connected =
        tokio::time::timeout(Duration::from_secs(10), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;
    let forward = tokio::time::timeout(
        Duration::from_secs(10),
        manager.start_dynamic_port_forward(SshDynamicPortForwardRequest {
            session_id: session_id.clone(),
            bind_host: "127.0.0.1".to_owned(),
            bind_port: 0,
        }),
    )
    .await
    .expect("dynamic SOCKS forward start timed out")
    .expect("dynamic SOCKS forward start failed");
    assert_eq!(forward.status, "listening");
    assert_eq!(forward.session_id, session_id);

    let mut socket = connect_socks5(
        forward.bind_host.as_str(),
        forward.bind_port,
        "example.internal",
        7,
    )
    .await;
    let payload = b"tabby-dynamic-socks-ok";
    socket
        .write_all(payload)
        .await
        .expect("write to dynamic SOCKS forward failed");
    let mut read_back = vec![0_u8; payload.len()];
    tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut read_back))
        .await
        .expect("dynamic SOCKS forward read timed out")
        .expect("read from dynamic SOCKS forward failed");
    assert_eq!(read_back, payload);

    manager
        .stop_port_forward(&forward.forward_id)
        .await
        .expect("dynamic SOCKS forward stop failed");
    manager
        .close_transport(&session_id, "dynamic-socks-forward-smoke-complete")
        .await
        .expect("ssh close failed");
}

#[tokio::test]
async fn ssh_remote_port_forward_roundtrips_against_in_process_server() {
    let payload = b"tabby-remote-forward-ok".to_vec();
    let (host, port, fingerprint, remote_echoes) =
        spawn_echo_server_with_remote_forward_probe(payload.clone()).await;
    let (target_host, target_port, target_task) = spawn_tcp_echo_target().await;
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = SshConnectRequest {
        host,
        port,
        username: "tabby".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some(fingerprint),
        term: None,
        unsupported_features: vec![],
    };

    let connected =
        tokio::time::timeout(Duration::from_secs(10), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;
    let forward = tokio::time::timeout(
        Duration::from_secs(10),
        manager.start_remote_port_forward(SshRemotePortForwardRequest {
            session_id: session_id.clone(),
            bind_host: "127.0.0.1".to_owned(),
            bind_port: 41080,
            target_host,
            target_port,
        }),
    )
    .await
    .expect("remote port forward start timed out")
    .expect("remote port forward start failed");
    assert_eq!(forward.status, "listening");
    assert_eq!(forward.session_id, session_id);
    assert_eq!(forward.bind_port, 41080);

    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if remote_echoes
                .lock()
                .expect("remote forward echo registry lock")
                .iter()
                .any(|echo| echo == &payload)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("remote forward echo was not observed");

    manager
        .stop_port_forward(&forward.forward_id)
        .await
        .expect("remote port forward stop failed");
    manager
        .close_transport(&session_id, "remote-forward-smoke-complete")
        .await
        .expect("ssh close failed");
    target_task.abort();
}

#[tokio::test]
async fn ssh_transport_scans_host_key_before_authentication() {
    let (host, port, fingerprint) = spawn_echo_server(true).await;
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));

    let scan = tokio::time::timeout(
        Duration::from_secs(10),
        manager.scan_host_key(SshHostKeyScanRequest { host, port }),
    )
    .await
    .expect("ssh host key scan timed out")
    .expect("ssh host key scan failed");

    assert_eq!(scan.sha256, fingerprint);
    assert!(scan.sha512.starts_with("SHA512:"));
}

#[tokio::test]
async fn ssh_transport_password_auth_falls_back_to_keyboard_interactive() {
    let (host, port, fingerprint) = spawn_echo_server(false).await;
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = SshConnectRequest {
        host,
        port,
        username: "tabby".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some(fingerprint),
        term: None,
        unsupported_features: vec![],
    };

    let connected =
        tokio::time::timeout(Duration::from_secs(10), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.open_shell_transport(&session_id, SshShellSize { cols: 80, rows: 24 }),
    )
    .await
    .expect("ssh shell open timed out")
    .expect("ssh shell open failed");

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.write_transport(&session_id, b"echo keyboard-interactive\n".to_vec()),
    )
    .await
    .expect("ssh write timed out")
    .expect("ssh write failed");

    let echoed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.next_data_transport(&session_id, 0),
    )
    .await
    .expect("ssh read timed out")
    .expect("ssh read failed")
    .expect("ssh server closed before echoing command");
    assert_eq!(echoed.bytes, b"echo keyboard-interactive\n");

    let closed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.close_transport(&session_id, "keyboard-interactive-smoke-complete"),
    )
    .await
    .expect("ssh close timed out")
    .expect("ssh close failed");

    assert_eq!(
        closed.close_reason.as_deref(),
        Some("keyboard-interactive-smoke-complete")
    );
}

#[tokio::test]
async fn ssh_transport_serializes_overlapping_commands_for_one_session() {
    let (host, port, fingerprint) = spawn_echo_server(true).await;
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let request = SshConnectRequest {
        host,
        port,
        username: "tabby".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some(fingerprint),
        term: None,
        unsupported_features: vec![],
    };

    let connected =
        tokio::time::timeout(Duration::from_secs(10), manager.connect_transport(request))
            .await
            .expect("ssh connect timed out")
            .expect("ssh connect failed");
    let session_id = connected.session.session_id;

    tokio::time::timeout(
        Duration::from_secs(10),
        manager.open_shell_transport(&session_id, SshShellSize { cols: 80, rows: 24 }),
    )
    .await
    .expect("ssh shell open timed out")
    .expect("ssh shell open failed");

    let (write, resize, keepalive) = tokio::join!(
        manager.write_transport(&session_id, b"echo overlap\n".to_vec()),
        manager.resize_transport(
            &session_id,
            SshShellSize {
                cols: 120,
                rows: 40,
            },
        ),
        manager.keepalive_transport(&session_id),
    );

    assert!(write.is_ok(), "overlapping write should wait for transport");
    assert!(
        resize.is_ok(),
        "overlapping resize should wait for transport"
    );
    assert!(
        keepalive.is_ok(),
        "overlapping keepalive should wait for transport"
    );

    let closed = tokio::time::timeout(
        Duration::from_secs(10),
        manager.close_transport(&session_id, "overlap-complete"),
    )
    .await
    .expect("ssh close timed out")
    .expect("ssh close failed");

    assert_eq!(closed.close_reason.as_deref(), Some("overlap-complete"));
}
