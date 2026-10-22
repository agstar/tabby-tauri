#[cfg(windows)]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tabby_tauri::pty::{
    install_ssh_keepalive_wrapper_in_env, normalize_spawn_env_from, PtyChildProcess, PtyData,
    PtyManager, PtySizeSpec, PtySpawnRequest,
};
use tabby_tauri::session::SessionRegistry;

#[test]
fn spawn_request_rejects_empty_command() {
    let request = PtySpawnRequest {
        command: "  ".to_owned(),
        args: vec![],
        cwd: None,
        env: vec![],
        size: PtySizeSpec { cols: 80, rows: 24 },
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("command"));
}

#[test]
fn spawn_request_rejects_zero_terminal_size() {
    let request = PtySpawnRequest {
        command: "cmd.exe".to_owned(),
        args: vec![],
        cwd: None,
        env: vec![],
        size: PtySizeSpec { cols: 0, rows: 24 },
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("cols"));
}

#[test]
fn spawn_request_accepts_windows_shell_shape() {
    let request = PtySpawnRequest {
        command: "cmd.exe".to_owned(),
        args: vec!["/C".to_owned(), "echo ok".to_owned()],
        cwd: None,
        env: vec![("TABBY_TAURI_TEST".to_owned(), "1".to_owned())],
        size: PtySizeSpec {
            cols: 100,
            rows: 30,
        },
    };

    assert!(request.validate().is_ok());
}

#[test]
fn spawn_environment_preserves_host_path_when_renderer_sends_blank_path() {
    let env = normalize_spawn_env_from(
        [
            (
                "Path".to_owned(),
                r"C:\WINDOWS\System32;C:\WINDOWS\System32\OpenSSH;C:\Users\dev\bin".to_owned(),
            ),
            ("SystemRoot".to_owned(), r"C:\WINDOWS".to_owned()),
        ],
        &[
            ("PATH".to_owned(), String::new()),
            ("Path".to_owned(), String::new()),
            ("TERM".to_owned(), "xterm-256color".to_owned()),
        ],
    );

    let path = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("Path"))
        .map(|(_, value)| value.as_str())
        .unwrap_or_default();

    assert!(path.contains(r"OpenSSH"));
    assert!(path.contains(r"dev\bin"));
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "TERM")
            .map(|(_, value)| value.as_str()),
        Some("xterm-256color"),
    );
    assert!(
        !env.iter()
            .any(|(key, value)| key.eq_ignore_ascii_case("Path") && value.is_empty()),
        "blank renderer PATH must not clear the backend host PATH",
    );
}

#[test]
#[cfg(windows)]
fn local_spawn_env_installs_ssh_keepalive_wrapper_without_changing_system_path() {
    let unique = format!(
        "tabby-tauri-ssh-wrapper-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let root = std::env::temp_dir().join(unique);
    let wrapper_dir = root.join("bin");
    let real_ssh = root.join("OpenSSH").join("ssh.exe");
    std::fs::create_dir_all(real_ssh.parent().unwrap()).unwrap();
    std::fs::write(&real_ssh, b"fake exe").unwrap();

    let mut env = vec![
        (
            "Path".to_owned(),
            format!(
                r"C:\Windows\System32;{}",
                real_ssh.parent().unwrap().display()
            ),
        ),
        ("SystemRoot".to_owned(), r"C:\Windows".to_owned()),
    ];

    install_ssh_keepalive_wrapper_in_env(&mut env, &wrapper_dir, &real_ssh).unwrap();

    let path = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("Path"))
        .map(|(_, value)| value.as_str())
        .unwrap_or_default();
    assert!(
        path.starts_with(wrapper_dir.to_string_lossy().as_ref()),
        "wrapper directory must be prepended only inside the spawned shell environment"
    );
    assert!(
        path.contains(real_ssh.parent().unwrap().to_string_lossy().as_ref()),
        "existing OpenSSH directory must remain in PATH"
    );
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "TABBY_TAURI_REAL_SSH")
            .map(|(_, value)| PathBuf::from(value)),
        Some(real_ssh.clone()),
    );

    let wrapper = std::fs::read_to_string(wrapper_dir.join("ssh.cmd")).unwrap();
    assert!(wrapper.contains("ServerAliveInterval=15"));
    assert!(wrapper.contains("ServerAliveCountMax=3"));
    assert!(wrapper.contains("TABBY_TAURI_REAL_SSH"));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn pty_size_rejects_zero_dimensions() {
    assert!(PtySizeSpec { cols: 0, rows: 24 }.validate().is_err());
    assert!(PtySizeSpec { cols: 80, rows: 0 }.validate().is_err());
}

#[test]
fn pty_size_accepts_non_zero_dimensions() {
    assert!(PtySizeSpec { cols: 80, rows: 24 }.validate().is_ok());
}

#[test]
fn pty_data_serializes_session_sequence_and_bytes() {
    let data = PtyData {
        session_id: "local-1".to_owned(),
        seq: 7,
        bytes: vec![111, 107],
    };

    let json = serde_json::to_value(data).unwrap();

    assert_eq!(json["session_id"], "local-1");
    assert_eq!(json["seq"], 7);
    assert_eq!(json["bytes"], serde_json::json!([111, 107]));
}

#[test]
fn child_process_contract_serializes_pid_parent_and_command() {
    let child = PtyChildProcess {
        pid: 12,
        ppid: 11,
        command: "cmd.exe".to_owned(),
    };

    let json = serde_json::to_value(child).unwrap();

    assert_eq!(json["pid"], 12);
    assert_eq!(json["ppid"], 11);
    assert_eq!(json["command"], "cmd.exe");
}

#[test]
#[cfg(windows)]
#[ignore = "manual ConPTY smoke; default suite must not block on platform PTY output timing"]
fn pty_manager_spawns_windows_command_and_records_output_ack() {
    let sessions = Arc::new(Mutex::new(SessionRegistry::default()));
    let manager = PtyManager::new(sessions);
    let spawned = manager
        .spawn(PtySpawnRequest {
            command: "cmd.exe".to_owned(),
            args: vec!["/C".to_owned(), "echo tabby-tauri-pty-smoke".to_owned()],
            cwd: None,
            env: vec![],
            size: PtySizeSpec { cols: 80, rows: 24 },
        })
        .unwrap();

    let output = manager
        .read_once(&spawned.session.session_id, 4096)
        .unwrap();
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("tabby-tauri-pty-smoke"));

    let after_ack = manager
        .ack(&spawned.session.session_id, output.len() as u64)
        .unwrap();
    assert_eq!(after_ack.queue_depth, 0);
}
