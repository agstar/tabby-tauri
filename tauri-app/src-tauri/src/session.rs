use serde::Serialize;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

const HIGH_WATER_MARK: u64 = 1024 * 1024;
const LOW_WATER_MARK: u64 = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Local,
    Ssh,
    Tcp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    Starting,
    Running,
    Idle,
    Closed,
    Errored,
    Reconnectable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub kind: SessionKind,
    pub state: SessionState,
    pub last_activity_at: u128,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub queue_depth: u64,
    pub reader_paused: bool,
    pub close_reason: Option<String>,
    pub error_reason: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum SessionError {
    UnknownSession(String),
}

#[derive(Default)]
pub struct SessionRegistry {
    next_id: u64,
    sessions: HashMap<String, SessionSnapshot>,
}

impl SessionRegistry {
    pub fn create(&mut self, kind: SessionKind) -> SessionSnapshot {
        self.next_id += 1;
        let prefix = match kind {
            SessionKind::Local => "local",
            SessionKind::Ssh => "ssh",
            SessionKind::Tcp => "tcp",
        };
        let session = SessionSnapshot {
            session_id: format!("{prefix}-{}", self.next_id),
            kind,
            state: SessionState::Starting,
            last_activity_at: now_millis(),
            bytes_in: 0,
            bytes_out: 0,
            queue_depth: 0,
            reader_paused: false,
            close_reason: None,
            error_reason: None,
        };
        self.sessions
            .insert(session.session_id.clone(), session.clone());
        session
    }

    pub fn get(&self, session_id: &str) -> Option<&SessionSnapshot> {
        self.sessions.get(session_id)
    }

    pub fn remove(&mut self, session_id: &str) -> Option<SessionSnapshot> {
        self.sessions.remove(session_id)
    }

    pub fn record_input(
        &mut self,
        session_id: &str,
        length: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        self.update(session_id, |session| {
            session.bytes_in = session.bytes_in.saturating_add(length);
        })
    }

    pub fn record_output(
        &mut self,
        session_id: &str,
        length: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        self.update(session_id, |session| {
            session.bytes_out = session.bytes_out.saturating_add(length);
            session.queue_depth = session.queue_depth.saturating_add(length);
            if session.queue_depth >= HIGH_WATER_MARK {
                session.reader_paused = true;
            }
        })
    }

    pub fn ack_output(
        &mut self,
        session_id: &str,
        length: u64,
    ) -> Result<SessionSnapshot, SessionError> {
        self.update(session_id, |session| {
            session.queue_depth = session.queue_depth.saturating_sub(length);
            if session.queue_depth <= LOW_WATER_MARK {
                session.reader_paused = false;
            }
        })
    }

    pub fn set_state(
        &mut self,
        session_id: &str,
        state: SessionState,
    ) -> Result<SessionSnapshot, SessionError> {
        self.update(session_id, |session| {
            session.state = state;
        })
    }

    pub fn close(
        &mut self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<SessionSnapshot, SessionError> {
        let reason = reason.into();
        self.update(session_id, |session| {
            session.state = SessionState::Closed;
            session.close_reason = Some(reason);
        })
    }

    pub fn mark_reconnectable(
        &mut self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<SessionSnapshot, SessionError> {
        let reason = reason.into();
        self.update(session_id, |session| {
            session.state = SessionState::Reconnectable;
            session.error_reason = Some(reason);
        })
    }

    fn update(
        &mut self,
        session_id: &str,
        mutate: impl FnOnce(&mut SessionSnapshot),
    ) -> Result<SessionSnapshot, SessionError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| SessionError::UnknownSession(session_id.to_owned()))?;
        mutate(session);
        session.last_activity_at = now_millis();
        Ok(session.clone())
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before Unix epoch")
        .as_millis()
}
