use super::*;

fn saved(id: HostId) -> SavedHost {
    let mut record = statglass_engine::host_record(id);
    record.is_local = false;
    record.display_name = "Studio".into();
    SavedHost {
        config: RemoteHostConfig {
            id: id.to_string(),
            name: "Studio".into(),
            lan: Some("studio.local".into()),
            tailscale: Some("studio-tail".into()),
            enabled: false,
            mirror_budget_mb: 731,
        },
        record,
        command: RemoteCommand::default(),
        last_agent_version: Some("0.0.9".into()),
    }
}

#[test]
fn reinstalling_its_own_identity_keeps_the_saved_record_and_budget() {
    let id = HostId(Uuid::new_v4());
    let original = saved(id);
    let hosts = BTreeMap::from([(id, original.clone())]);
    let retained = saved_reinstall(&hosts, id, Some(id)).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(retained).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[&id].config.mirror_budget_mb, 731);
}

#[test]
fn another_saved_mac_still_reports_the_existing_duplicate_message() {
    let requested = HostId(Uuid::new_v4());
    let reported = HostId(Uuid::new_v4());
    let hosts = BTreeMap::from([(requested, saved(requested)), (reported, saved(reported))]);
    for reinstall in [None, Some(requested)] {
        assert!(matches!(saved_reinstall(&hosts, reported, reinstall),
            Err(CommandError::Internal { message }) if message == "This Mac is already in your host list"));
    }
}

#[test]
fn a_changed_identity_is_rejected_without_repairing_or_adding_it() {
    let requested = HostId(Uuid::new_v4());
    let reported = HostId(Uuid::new_v4());
    let hosts = BTreeMap::from([(requested, saved(requested))]);
    assert!(matches!(saved_reinstall(&hosts, reported, Some(requested)),
        Err(CommandError::RemoteIdentity { message }) if message.contains("different identity") && message.contains("Re-pair")));
    assert_eq!(hosts.len(), 1);
    assert!(!hosts.contains_key(&reported));
}

#[test]
fn a_removed_reinstall_target_is_not_added_as_a_new_host() {
    let id = HostId(Uuid::new_v4());
    assert!(matches!(saved_reinstall(&BTreeMap::new(), id, Some(id)),
        Err(CommandError::UnknownHost { host }) if host == id));
    assert!(
        saved_reinstall(&BTreeMap::new(), id, None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_disabled_reinstall_reports_the_confirmed_version_without_needing_a_source_callback() {
    let id = HostId(Uuid::new_v4());
    let other = HostId(Uuid::new_v4());
    let old = RemoteHostStatus {
        state: RemoteState::Disabled,
        agent_version: Some("0.0.9".into()),
        agent_update: super::super::super::commands::agent_update(false, Some("0.0.9"), false),
        ..Default::default()
    };
    let mut statuses = BTreeMap::from([(id, old.clone()), (other, old)]);
    let confirmed = confirmed_version(&mut statuses, id, env!("CARGO_PKG_VERSION"));
    let status = statuses.get(&id).unwrap();
    assert_eq!(
        status.agent_version.as_deref(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    assert!(
        matches!(&status.agent_update, AgentUpdate::UpToDate { installed } if installed == env!("CARGO_PKG_VERSION"))
    );
    assert!(matches!(status.state, RemoteState::Disabled));
    assert_eq!(
        serde_json::to_value(&confirmed).unwrap(),
        serde_json::to_value(status).unwrap()
    );
    assert_eq!(
        statuses.get(&other).unwrap().agent_version.as_deref(),
        Some("0.0.9")
    );
}
