use std::sync::{Arc, Mutex};

use tabby_tauri::session::{SessionRegistry, SessionState};
use tabby_tauri::ssh::{
    ssh_known_host_forget_at, ssh_known_host_get_at, ssh_known_host_mismatch_report,
    ssh_known_host_trust_at, ssh_known_hosts_list_at, PrivateKeyCandidate, SshAuthMethod,
    SshConnectRequest, SshData, SshDynamicPortForwardRequest, SshKeepaliveProbeRequest,
    SshKnownHostForgetRequest, SshKnownHostTrustRequest, SshLocalPortForwardRequest, SshManager,
    SshRemotePortForwardRequest, SshShellSize,
};

fn temp_known_hosts_path(test_name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "tabby-tauri-{test_name}-{}-ssh-known-hosts.json",
        std::process::id()
    ))
}

fn valid_request() -> SshConnectRequest {
    SshConnectRequest {
        host: "example.test".to_owned(),
        port: 22,
        username: "user".to_owned(),
        auth: SshAuthMethod::Password {
            password: "secret".to_owned(),
        },
        host_key_fingerprint: Some("SHA256:abc".to_owned()),
        term: None,
        unsupported_features: vec![],
    }
}

#[test]
fn ssh_connect_request_rejects_empty_host() {
    let request = SshConnectRequest {
        host: " ".to_owned(),
        ..valid_request()
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("host"));
}

#[test]
fn ssh_connect_request_rejects_zero_port() {
    let request = SshConnectRequest {
        port: 0,
        ..valid_request()
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("port"));
}

#[test]
fn ssh_connect_request_rejects_deferred_features_explicitly() {
    let request = SshConnectRequest {
        unsupported_features: vec!["jump-host".to_owned(), "agent-forwarding".to_owned()],
        ..valid_request()
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("jump-host"));
    assert!(error.contains("agent-forwarding"));
}

#[test]
fn ssh_connect_request_accepts_password_auth_shape() {
    let request = valid_request();

    assert!(request.validate().is_ok());
}

#[test]
fn ssh_connect_request_accepts_keyboard_interactive_auth_shape() {
    let request = SshConnectRequest {
        auth: SshAuthMethod::KeyboardInteractive {
            prompt_provider: "renderer".to_owned(),
        },
        ..valid_request()
    };

    assert!(request.validate().is_ok());
}

#[test]
fn ssh_connect_request_accepts_ordered_private_key_candidates() {
    let request = SshConnectRequest {
        auth: SshAuthMethod::PrivateKeys {
            private_keys: vec![
                PrivateKeyCandidate {
                    private_key_path: "C:/Users/alice/.ssh/id_bad".to_owned(),
                    passphrase: None,
                },
                PrivateKeyCandidate {
                    private_key_path: "C:/Users/alice/.ssh/id_ed25519".to_owned(),
                    passphrase: Some("secret".to_owned()),
                },
            ],
        },
        ..valid_request()
    };

    assert!(request.validate().is_ok());
}

#[test]
fn ssh_connect_request_rejects_empty_host_key_fingerprint() {
    let request = SshConnectRequest {
        host_key_fingerprint: Some("SHA256: ".to_owned()),
        ..valid_request()
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("host_key_fingerprint"));
}

#[test]
fn ssh_connect_request_requires_host_key_fingerprint_before_authentication() {
    let request = SshConnectRequest {
        host_key_fingerprint: None,
        ..valid_request()
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("host_key_fingerprint"));
    assert!(error.contains("required"));
}

#[test]
fn ssh_connect_request_requires_host_key_fingerprint_before_auth_material_validation() {
    let request = SshConnectRequest {
        host_key_fingerprint: None,
        auth: SshAuthMethod::PrivateKey {
            private_key_path: " ".to_owned(),
            passphrase: Some("secret".to_owned()),
        },
        ..valid_request()
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("host_key_fingerprint"));
    assert!(!error.contains("private_key_path"));
}

#[test]
fn ssh_auth_debug_redacts_ordered_private_key_candidates() {
    let auth = SshAuthMethod::PrivateKeys {
        private_keys: vec![PrivateKeyCandidate {
            private_key_path: "C:/Users/alice/.ssh/id_ed25519".to_owned(),
            passphrase: Some("secret-passphrase".to_owned()),
        }],
    };

    let debug = format!("{auth:?}");

    assert!(debug.contains("id_ed25519"));
    assert!(debug.contains("<redacted>"));
    assert!(!debug.contains("secret-passphrase"));
}

#[test]
fn ssh_local_port_forward_request_accepts_loopback_bind_and_ephemeral_port() {
    let request = SshLocalPortForwardRequest {
        session_id: "ssh-1".to_owned(),
        bind_host: "127.0.0.1".to_owned(),
        bind_port: 0,
        target_host: "127.0.0.1".to_owned(),
        target_port: 22,
    };

    assert!(request.validate().is_ok());
}

#[test]
fn ssh_local_port_forward_request_rejects_non_loopback_bind() {
    let request = SshLocalPortForwardRequest {
        session_id: "ssh-1".to_owned(),
        bind_host: "0.0.0.0".to_owned(),
        bind_port: 8080,
        target_host: "127.0.0.1".to_owned(),
        target_port: 22,
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("localhost"));
}

#[test]
fn ssh_local_port_forward_request_rejects_empty_target_and_zero_target_port() {
    let empty_target = SshLocalPortForwardRequest {
        session_id: "ssh-1".to_owned(),
        bind_host: "localhost".to_owned(),
        bind_port: 8080,
        target_host: " ".to_owned(),
        target_port: 22,
    };
    let zero_target_port = SshLocalPortForwardRequest {
        target_host: "127.0.0.1".to_owned(),
        target_port: 0,
        ..empty_target.clone()
    };

    assert!(empty_target.validate().unwrap_err().contains("target_host"));
    assert!(zero_target_port
        .validate()
        .unwrap_err()
        .contains("target_port"));
}

#[test]
fn ssh_dynamic_port_forward_request_accepts_loopback_bind_and_ephemeral_port() {
    let request = SshDynamicPortForwardRequest {
        session_id: "ssh-1".to_owned(),
        bind_host: "127.0.0.1".to_owned(),
        bind_port: 0,
    };

    assert!(request.validate().is_ok());
}

#[test]
fn ssh_dynamic_port_forward_request_rejects_non_loopback_bind() {
    let request = SshDynamicPortForwardRequest {
        session_id: "ssh-1".to_owned(),
        bind_host: "0.0.0.0".to_owned(),
        bind_port: 1080,
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("localhost"));
}

#[test]
fn ssh_remote_port_forward_request_accepts_loopback_bind_and_ephemeral_port() {
    let request = SshRemotePortForwardRequest {
        session_id: "ssh-1".to_owned(),
        bind_host: "127.0.0.1".to_owned(),
        bind_port: 0,
        target_host: "127.0.0.1".to_owned(),
        target_port: 9000,
    };

    assert!(request.validate().is_ok());
}

#[test]
fn ssh_remote_port_forward_request_rejects_non_loopback_and_empty_target() {
    let non_loopback = SshRemotePortForwardRequest {
        session_id: "ssh-1".to_owned(),
        bind_host: "0.0.0.0".to_owned(),
        bind_port: 9000,
        target_host: "127.0.0.1".to_owned(),
        target_port: 9001,
    };
    let empty_target = SshRemotePortForwardRequest {
        bind_host: "127.0.0.1".to_owned(),
        target_host: " ".to_owned(),
        ..non_loopback.clone()
    };

    assert!(non_loopback.validate().unwrap_err().contains("localhost"));
    assert!(empty_target.validate().unwrap_err().contains("target_host"));
}

#[test]
fn ssh_manager_connects_and_opens_shell_contract_surface() {
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));

    let connected = manager.connect(valid_request()).unwrap();
    assert_eq!(connected.transport_status, "pending-russh-transport");
    assert_eq!(connected.session.state, SessionState::Starting);
    assert!(connected.session.session_id.starts_with("ssh-"));

    let opened = manager
        .open_shell(
            &connected.session.session_id,
            SshShellSize { cols: 80, rows: 24 },
        )
        .unwrap();

    assert_eq!(opened.state, SessionState::Running);
    assert_eq!(
        manager
            .state(&connected.session.session_id)
            .unwrap()
            .unwrap()
            .state,
        SessionState::Running
    );
}

#[test]
fn ssh_manager_tracks_write_ack_close_and_forced_disconnect_state() {
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let session_id = manager.connect(valid_request()).unwrap().session.session_id;

    manager
        .open_shell(
            &session_id,
            SshShellSize {
                cols: 120,
                rows: 30,
            },
        )
        .unwrap();
    let after_write = manager.write(&session_id, &[1, 2, 3, 4]).unwrap();
    assert_eq!(after_write.bytes_in, 4);

    let after_ack = manager.ack(&session_id, 1024).unwrap();
    assert_eq!(after_ack.queue_depth, 0);

    let after_keepalive = manager.keepalive(&session_id).unwrap();
    assert_eq!(after_keepalive.state, SessionState::Running);

    let reconnectable = manager
        .forced_disconnect_test(&session_id, "synthetic network loss")
        .unwrap();
    assert_eq!(reconnectable.state, SessionState::Reconnectable);
    assert_eq!(
        reconnectable.error_reason.as_deref(),
        Some("synthetic network loss")
    );

    let closed = manager.close(&session_id, "user-request").unwrap();
    assert_eq!(closed.state, SessionState::Closed);
    assert_eq!(closed.close_reason.as_deref(), Some("user-request"));
}

#[test]
fn ssh_shell_size_rejects_zero_dimensions() {
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let session_id = manager.connect(valid_request()).unwrap().session.session_id;

    let error = manager
        .open_shell(&session_id, SshShellSize { cols: 0, rows: 24 })
        .unwrap_err();

    assert!(error.contains("cols"));
}

#[test]
fn ssh_data_serializes_session_sequence_and_bytes() {
    let data = SshData {
        session_id: "ssh-42".to_owned(),
        seq: 7,
        bytes: vec![104, 105],
        current_dir: None,
        clipboard_text: None,
    };

    let json = serde_json::to_value(data).unwrap();

    assert_eq!(json["session_id"], "ssh-42");
    assert_eq!(json["seq"], 7);
    assert_eq!(json["bytes"], serde_json::json!([104, 105]));
    assert!(json.get("current_dir").is_none());
    assert!(json.get("clipboard_text").is_none());
}

#[test]
fn ssh_known_host_store_persists_lists_and_forgets_trusted_fingerprints() {
    let path = temp_known_hosts_path("persist-list-forget");
    let _ = std::fs::remove_file(&path);

    let entry = ssh_known_host_trust_at(
        &path,
        SshKnownHostTrustRequest {
            host: "Example.Test".to_owned(),
            port: 2222,
            sha256: "SHA256:abc123".to_owned(),
            alias: Some("prod".to_owned()),
            comment: None,
        },
    )
    .unwrap();

    assert_eq!(entry.host, "example.test");
    assert_eq!(entry.sha256, "SHA256:abc123");
    assert_eq!(ssh_known_hosts_list_at(&path).unwrap().len(), 1);
    assert_eq!(
        ssh_known_host_get_at(
            &path,
            SshKnownHostForgetRequest {
                host: "example.test".to_owned(),
                port: 2222,
            },
        )
        .unwrap()
        .unwrap()
        .sha256,
        "SHA256:abc123",
    );
    assert!(ssh_known_host_forget_at(
        &path,
        SshKnownHostForgetRequest {
            host: "example.test".to_owned(),
            port: 2222,
        },
    )
    .unwrap());
    assert!(ssh_known_hosts_list_at(&path).unwrap().is_empty());

    let _ = std::fs::remove_file(&path);
}

#[test]
fn ssh_known_host_mismatch_report_blocks_before_auth_without_secrets() {
    let path = temp_known_hosts_path("mismatch-report");
    let _ = std::fs::remove_file(&path);
    let stored = ssh_known_host_trust_at(
        &path,
        SshKnownHostTrustRequest {
            host: "example.test".to_owned(),
            port: 22,
            sha256: "SHA256:old".to_owned(),
            alias: None,
            comment: None,
        },
    )
    .unwrap();

    let report = ssh_known_host_mismatch_report(&stored, "SHA256:new").unwrap();
    let json = serde_json::to_string(&report).unwrap();

    assert_eq!(report.action, "blocked-before-authentication");
    assert!(json.contains("SHA256:old"));
    assert!(json.contains("SHA256:new"));
    assert!(!json.contains("secret"));
    assert!(!json.contains("password"));

    let _ = std::fs::remove_file(&path);
}

#[test]
fn ssh_manager_registers_stream_only_for_existing_ssh_sessions() {
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let missing = manager.start_stream("ssh-missing").unwrap_err();
    assert!(missing.contains("unknown SSH session"));

    let session_id = manager.connect(valid_request()).unwrap().session.session_id;
    let snapshot = manager.start_stream(&session_id).unwrap();

    assert_eq!(snapshot.session_id, session_id);
}

#[tokio::test]
async fn ssh_keepalive_evaluator_tracks_probe_counts_offline() {
    let manager = SshManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let session_id = manager.connect(valid_request()).unwrap().session.session_id;
    manager
        .open_shell(&session_id, SshShellSize { cols: 80, rows: 24 })
        .unwrap();

    let report = manager
        .keepalive_evaluator(
            &session_id,
            SshKeepaliveProbeRequest {
                probes: 2,
                interval_ms: 1,
            },
        )
        .await
        .unwrap();

    assert_eq!(report.probes_attempted, 2);
    assert_eq!(report.probes_succeeded, 2);
    assert_eq!(report.status, "healthy");
    assert_eq!(report.session.state, SessionState::Running);
}

#[test]
fn ssh_keepalive_evaluator_rejects_zero_probes() {
    let request = SshKeepaliveProbeRequest {
        probes: 0,
        interval_ms: 1,
    };

    let error = request.validate().unwrap_err();

    assert!(error.contains("probes"));
}
