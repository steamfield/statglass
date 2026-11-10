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

fn probe(installed: bool) -> statglass_remote::install::InstallProbe {
    statglass_remote::install::InstallProbe {
        os: "Darwin".into(),
        os_version: "26".into(),
        arch: "arm64".into(),
        user: "alice".into(),
        console_user: "alice".into(),
        app_path: installed.then(|| "/Applications/StatGlass.app".into()),
        helper_path: installed
            .then(|| "/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper".into()),
    }
}

#[tokio::test]
async fn reinstall_rejects_changed_or_missing_identity_before_touching_the_remote() {
    let id = HostId(Uuid::new_v4());
    let hosts = BTreeMap::from([(id, saved(id))]);
    for installed in [true, false] {
        let calls = std::cell::RefCell::new(Vec::new());
        let reported = HostId(Uuid::new_v4());
        let result = prepare_checked(
            probe(installed),
            Some(id),
            &hosts,
            |_| async {
                calls.borrow_mut().push("status");
                Ok(serde_json::from_value(serde_json::json!({
                    "ok": true, "message": "", "host": statglass_engine::host_record(reported),
                }))
                .unwrap())
            },
            |_| async {
                calls.borrow_mut().extend(["install", "update", "launch"]);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            *calls.borrow(),
            if installed { vec!["status"] } else { vec![] }
        );
        if !installed {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("StatGlass isn't installed on that Mac anymore; add it again")
            );
        }
    }
}

#[tokio::test]
async fn reinstall_refreshes_the_helper_and_replaces_the_source_only_when_it_changes() {
    let id = HostId(Uuid::new_v4());
    let mut host = saved(id);
    let original = host.config.clone();
    let source = std::cell::RefCell::new(host.endpoint());
    let replacements = std::cell::Cell::new(0);
    let helper = "/Users/alice/Applications/StatGlass.app/Contents/MacOS/statglass-remote-helper";
    for changed in [true, false] {
        let got = refresh_saved(
            &mut host,
            statglass_engine::host_record(id),
            "1.0.0".into(),
            helper.into(),
            |next| {
                let source = &source;
                let replacements = &replacements;
                async move {
                    *source.borrow_mut() = next.endpoint();
                    replacements.set(replacements.get() + 1);
                    Ok(())
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(got, changed);
        assert_eq!(
            source.borrow().command,
            RemoteCommand::MacHelper(helper.into())
        );
        assert_eq!(host.endpoint().command, source.borrow().command);
        assert_eq!(
            replacements.get(),
            1,
            "an unchanged helper must retain its source"
        );
    }
    assert_eq!(
        serde_json::to_value(&host.config).unwrap(),
        serde_json::to_value(original).unwrap()
    );
}
