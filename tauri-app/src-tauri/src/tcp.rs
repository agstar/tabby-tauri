use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::session::{SessionKind, SessionRegistry, SessionSnapshot, SessionState};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{Mutex as AsyncMutex, Notify};

const DEFAULT_TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(25);

type SharedTcpReader = Arc<AsyncMutex<OwnedReadHalf>>;
type SharedTcpWriter = Arc<AsyncMutex<OwnedWriteHalf>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct TcpConnectRequest {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct TcpConnectResponse {
    pub session: SessionSnapshot,
    pub transport_status: &'static str,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct TcpData {
    pub session_id: String,
    pub seq: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone)]
struct TcpConnection {
    reader: SharedTcpReader,
    writer: SharedTcpWriter,
    closed: Arc<AtomicBool>,
    close_notify: Arc<Notify>,
}

#[derive(Clone)]
pub struct TcpManager {
    sessions: Arc<Mutex<SessionRegistry>>,
    connections: Arc<Mutex<HashMap<String, TcpConnection>>>,
    connect_timeout: Duration,
}

impl TcpConnectRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("native_tcp_connect host must not be empty".to_owned());
        }
        if self.port == 0 {
            return Err("native_tcp_connect port must be greater than zero".to_owned());
        }
        Ok(())
    }
}

impl TcpManager {
    pub fn new(sessions: Arc<Mutex<SessionRegistry>>) -> Self {
        Self {
            sessions,
            connections: Arc::new(Mutex::new(HashMap::new())),
            connect_timeout: DEFAULT_TCP_CONNECT_TIMEOUT,
        }
    }

    pub async fn connect(&self, request: TcpConnectRequest) -> Result<TcpConnectResponse, String> {
        request.validate()?;
        let host = request.host.trim().to_owned();
        let stream = tokio::time::timeout(
            self.connect_timeout,
            TcpStream::connect((host.as_str(), request.port)),
        )
        .await
        .map_err(|_| {
            format!(
                "native_tcp_connect timed out connecting to {host}:{}",
                request.port
            )
        })?
        .map_err(|error| {
            format!(
                "native_tcp_connect failed for {host}:{}: {error}",
                request.port
            )
        })?;
        stream
            .set_nodelay(true)
            .map_err(|error| format!("native_tcp_connect set_nodelay failed: {error}"))?;
        let (reader, writer) = stream.into_split();

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?;
        let session = sessions.create(SessionKind::Tcp);
        let session = sessions
            .set_state(&session.session_id, SessionState::Running)
            .map_err(|error| format!("{error:?}"))?;
        drop(sessions);

        self.connections
            .lock()
            .map_err(|_| "tcp connection map lock poisoned".to_owned())?
            .insert(
                session.session_id.clone(),
                TcpConnection {
                    reader: Arc::new(AsyncMutex::new(reader)),
                    writer: Arc::new(AsyncMutex::new(writer)),
                    closed: Arc::new(AtomicBool::new(false)),
                    close_notify: Arc::new(Notify::new()),
                },
            );

        Ok(TcpConnectResponse {
            session,
            transport_status: "connected",
        })
    }

    pub async fn write(&self, session_id: &str, bytes: Vec<u8>) -> Result<SessionSnapshot, String> {
        let writer = self.writer(session_id)?;
        writer
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(|error| format!("native_tcp_write failed: {error}"))?;
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .record_input(session_id, bytes.len() as u64)
            .map_err(|error| format!("{error:?}"))
    }

    pub async fn read_once(&self, session_id: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
        let reader = self.reader(session_id)?;
        let mut buffer = vec![0_u8; max_bytes.max(1)];
        let length = reader
            .lock()
            .await
            .read(&mut buffer)
            .await
            .map_err(|error| format!("native_tcp_read failed: {error}"))?;
        buffer.truncate(length);
        self.record_output(session_id, length)?;
        Ok(buffer)
    }

    pub async fn stream(
        &self,
        session_id: String,
        channel: tauri::ipc::Channel<TcpData>,
    ) -> Result<SessionSnapshot, String> {
        let connection = self.connection(&session_id)?;
        let reader = connection.reader.clone();
        let closed = connection.closed.clone();
        let close_notify = connection.close_notify.clone();
        let sessions = self.sessions.clone();
        let connections = self.connections.clone();
        let session = sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("unknown TCP session: {session_id}"))?;

        tokio::spawn(async move {
            let mut seq = 0_u64;
            let mut buffer = vec![0_u8; 8192];
            loop {
                if closed.load(Ordering::SeqCst) {
                    break;
                }
                if is_reader_paused(&sessions, &session_id) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }

                let read_result = async {
                    let mut reader = reader.lock().await;
                    reader.read(&mut buffer).await
                };
                let length = tokio::select! {
                    _ = close_notify.notified() => break,
                    result = read_result => {
                        match result {
                            Ok(0) => break,
                            Ok(length) => length,
                            Err(error) => {
                                if let Ok(mut registry) = sessions.lock() {
                                    let _ = registry
                                        .mark_reconnectable(&session_id, format!("tcp-read: {error}"));
                                }
                                break;
                            }
                        }
                    }
                };
                let bytes = buffer[..length].to_vec();
                if let Ok(mut registry) = sessions.lock() {
                    let _ = registry.record_output(&session_id, length as u64);
                }
                if channel
                    .send(TcpData {
                        session_id: session_id.clone(),
                        seq,
                        bytes,
                    })
                    .is_err()
                {
                    break;
                }
                seq = seq.saturating_add(1);
            }
            let _ = connections.lock().map(|mut map| map.remove(&session_id));
            if let Ok(mut registry) = sessions.lock() {
                if !matches!(
                    registry.get(&session_id).map(|session| &session.state),
                    Some(&SessionState::Closed)
                ) {
                    let _ = registry.close(&session_id, "tcp-reader-ended");
                }
            }
        });

        Ok(session)
    }

    pub fn ack(&self, session_id: &str, length: u64) -> Result<SessionSnapshot, String> {
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .ack_output(session_id, length)
            .map_err(|error| format!("{error:?}"))
    }

    pub async fn close(
        &self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<SessionSnapshot, String> {
        let connection = self
            .connections
            .lock()
            .map_err(|_| "tcp connection map lock poisoned".to_owned())?
            .remove(session_id);
        if let Some(connection) = connection {
            connection.closed.store(true, Ordering::SeqCst);
            connection.close_notify.notify_waiters();
            let _ = connection.writer.lock().await.shutdown().await;
        }
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .close(session_id, reason)
            .map_err(|error| format!("{error:?}"))
    }

    fn reader(&self, session_id: &str) -> Result<SharedTcpReader, String> {
        self.connection(session_id)
            .map(|connection| connection.reader.clone())
    }

    fn writer(&self, session_id: &str) -> Result<SharedTcpWriter, String> {
        self.connection(session_id)
            .map(|connection| connection.writer.clone())
    }

    fn connection(&self, session_id: &str) -> Result<TcpConnection, String> {
        self.connections
            .lock()
            .map_err(|_| "tcp connection map lock poisoned".to_owned())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("unknown TCP session: {session_id}"))
    }

    fn record_output(&self, session_id: &str, length: usize) -> Result<SessionSnapshot, String> {
        self.sessions
            .lock()
            .map_err(|_| "session registry lock poisoned".to_owned())?
            .record_output(session_id, length as u64)
            .map_err(|error| format!("{error:?}"))
    }
}

fn is_reader_paused(sessions: &Arc<Mutex<SessionRegistry>>, session_id: &str) -> bool {
    sessions
        .lock()
        .ok()
        .and_then(|registry| registry.get(session_id).cloned())
        .map(|session| session.reader_paused)
        .unwrap_or(true)
}
