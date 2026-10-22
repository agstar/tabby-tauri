use tabby_tauri::session::{SessionKind, SessionRegistry, SessionState};

#[test]
fn create_local_session_records_contract_fields() {
    let mut registry = SessionRegistry::default();

    let session = registry.create(SessionKind::Local);

    assert_eq!(session.kind, SessionKind::Local);
    assert_eq!(session.state, SessionState::Starting);
    assert_eq!(session.bytes_in, 0);
    assert_eq!(session.bytes_out, 0);
    assert_eq!(session.queue_depth, 0);
    assert!(session.close_reason.is_none());
    assert!(registry.get(&session.session_id).is_some());
}

#[test]
fn data_and_ack_update_observability_counters() {
    let mut registry = SessionRegistry::default();
    let session_id = registry.create(SessionKind::Local).session_id;

    registry.record_output(&session_id, 4096).unwrap();
    registry.ack_output(&session_id, 1024).unwrap();
    registry.record_input(&session_id, 10).unwrap();

    let session = registry.get(&session_id).unwrap();
    assert_eq!(session.bytes_out, 4096);
    assert_eq!(session.bytes_in, 10);
    assert_eq!(session.queue_depth, 3072);
}

#[test]
fn session_state_can_transition_to_running() {
    let mut registry = SessionRegistry::default();
    let session_id = registry.create(SessionKind::Local).session_id;

    let session = registry
        .set_state(&session_id, SessionState::Running)
        .unwrap();

    assert_eq!(session.state, SessionState::Running);
    assert_eq!(
        registry.get(&session_id).unwrap().state,
        SessionState::Running
    );
}

#[test]
fn close_session_records_reason_and_removes_lookup_when_requested() {
    let mut registry = SessionRegistry::default();
    let session_id = registry.create(SessionKind::Ssh).session_id;

    let closed = registry.close(&session_id, "user-request").unwrap();

    assert_eq!(closed.state, SessionState::Closed);
    assert_eq!(closed.close_reason.as_deref(), Some("user-request"));
    assert!(registry.remove(&session_id).is_some());
    assert!(registry.get(&session_id).is_none());
}

#[test]
fn output_queue_pauses_at_high_water_and_resumes_at_low_water() {
    let mut registry = SessionRegistry::default();
    let session_id = registry.create(SessionKind::Local).session_id;

    registry.record_output(&session_id, 1024 * 1024).unwrap();
    assert!(registry.get(&session_id).unwrap().reader_paused);

    registry.ack_output(&session_id, (768 * 1024) - 1).unwrap();
    assert!(registry.get(&session_id).unwrap().reader_paused);

    registry.ack_output(&session_id, 1).unwrap();
    assert!(!registry.get(&session_id).unwrap().reader_paused);
}
