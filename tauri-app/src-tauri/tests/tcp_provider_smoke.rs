use std::sync::{Arc, Mutex};
use std::time::Duration;

use tabby_tauri::session::{SessionKind, SessionRegistry, SessionState};
use tabby_tauri::tcp::{TcpConnectRequest, TcpManager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
async fn tcp_manager_roundtrips_bytes_against_loopback_echo_server() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback tcp listener");
    let port = listener.local_addr().expect("listener address").port();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept tcp client");
        socket.write_all(b"banner\n").await.expect("write banner");

        let mut buffer = vec![0_u8; 64];
        let length = socket.read(&mut buffer).await.expect("read client bytes");
        assert_eq!(&buffer[..length], b"ping\n");
        socket
            .write_all(b"pong\n")
            .await
            .expect("write echo response");
    });

    let manager = TcpManager::new(Arc::new(Mutex::new(SessionRegistry::default())));
    let connected = tokio::time::timeout(
        Duration::from_secs(5),
        manager.connect(TcpConnectRequest {
            host: "127.0.0.1".to_owned(),
            port,
        }),
    )
    .await
    .expect("tcp connect timed out")
    .expect("tcp connect failed");

    let session_id = connected.session.session_id;
    assert_eq!(connected.session.kind, SessionKind::Tcp);
    assert_eq!(connected.session.state, SessionState::Running);

    let banner = manager
        .read_once(&session_id, 64)
        .await
        .expect("read banner from tcp provider");
    assert_eq!(banner, b"banner\n");

    let written = manager
        .write(&session_id, b"ping\n".to_vec())
        .await
        .expect("write through tcp provider");
    assert_eq!(written.bytes_in, 5);

    let response = manager
        .read_once(&session_id, 64)
        .await
        .expect("read echo response through tcp provider");
    assert_eq!(response, b"pong\n");

    let closed = manager
        .close(&session_id, "roundtrip-complete")
        .await
        .expect("close tcp provider session");
    assert_eq!(closed.close_reason.as_deref(), Some("roundtrip-complete"));
}
