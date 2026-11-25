//! Tauri adapters for local metrics/control servers and their lifecycle.
use super::*;
use crate::pairing::{PairingState, device_seen};
use statglass_engine::disk_space::SpaceService;
use statglass_proto::pairing::{PairError, PairReply};
pub fn start(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let path = saved_path(app)?;
    if let Ok(bytes) = std::fs::read(&path) {
        let (saved, errors) = parse_saved(&bytes);
        if !errors.is_empty() {
            // The next save rewrites the file without these hosts; keep the original.
            let kept = path.with_extension("json.unreadable");
            tracing::warn!(
                "remote hosts could not be read ({}); the file is kept at {}",
                errors.join("; "),
                kept.display()
            );
            if let Err(e) = std::fs::copy(&path, &kept) {
                tracing::warn!("keeping the unreadable remote host file: {e}");
            }
        }
        *state.remotes.saved.lock_ok() = saved;
    }
    let (stop, mut rx) = tokio::sync::watch::channel(false);
    super::rr::start(app, rx.clone());
    *state.remotes.stop.lock_ok() = Some(stop);
    let dir = data_dir(app)?;
    if let Ok(local) = state.host(state.local) {
        app.state::<PairingState>().initialize(&dir, local.record());
    }
    let paths = SocketPaths::new(dir);
    let handle = app.clone();
    let control = Arc::new(move |request| {
        control(&handle, request, statglass_engine::wall_ms(), |request| {
            app_control(&handle, request)
        })
    });
    tauri::async_runtime::spawn(async move {
        loop {
            if *rx.borrow() {
                break;
            }
            if let Err(e) =
                statglass_remote::serve_control(paths.control.clone(), control.clone(), rx.clone())
                    .await
            {
                tracing::error!("remote control socket: {e}");
            } else {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                _ = rx.changed() => break,
            }
        }
    });
    refresh_metrics(app, state.settings.settings().remote_access.enabled);
    let handle = app.clone();
    *state.remotes.monitor.lock_ok() = match crate::remote_network::start(
        app,
        Arc::new(move |event| {
            let state = handle.state::<AppState>();
            for source in state.remotes.sources.lock_ok().values() {
                match event {
                    crate::remote_network::Event::NetworkChanged => source.network_changed(),
                    crate::remote_network::Event::WillSleep => source.sleep(),
                    crate::remote_network::Event::DidWake => source.wake(),
                }
            }
        }),
    ) {
        Ok(monitor) => Some(monitor),
        Err(error) => {
            tracing::warn!("remote network observer unavailable: {error}");
            None
        }
    };
    let saved: Vec<_> = state.remotes.saved.lock_ok().values().cloned().collect();
    for h in saved {
        if let Err(e) = register(app, h) {
            tracing::warn!("restoring remote host: {e}");
        }
    }
    Ok(())
}

fn control_response(app: &AppHandle, ok: bool, message: String) -> ControlResponse {
    let state = app.state::<AppState>();
    let settings = state.settings.settings();
    ControlResponse {
        ok,
        message,
        host: state.host(state.local).ok().map(|h| h.record()),
        allow_remote_monitoring: Some(settings.remote_access.enabled),
        show_menu_bar_icon: Some(settings.general.show_menu_bar),
        launch_at_login: Some(settings.general.launch_at_login),
        updates: Some(super::update_controls::local_status(app)),
        pairing: None,
        pairing_expires_ms: None,
    }
}
fn control<R: tauri::Runtime>(
    app: &AppHandle<R>,
    request: ControlRequest,
    now_ms: i64,
    other: impl FnOnce(ControlRequest) -> ControlResponse,
) -> ControlResponse {
    match request {
        ControlRequest::PairStart { .. }
        | ControlRequest::PairStatus { .. }
        | ControlRequest::PairAbandon { .. } => app
            .state::<PairingState>()
            .control_reply(request, now_ms)
            .unwrap_or_else(pairing_unavailable),
        request => other(request),
    }
}

fn app_control(app: &AppHandle, request: ControlRequest) -> ControlResponse {
    match request {
        ControlRequest::Status | ControlRequest::UpdateStatus => {
            control_response(app, true, "StatGlass is running".into())
        }
        ControlRequest::UpdatePolicy {
            check_updates,
            auto_install_updates,
        } => {
            let _maintenance = match crate::updates::maintenance(app) {
                Ok(guard) => guard,
                Err(error) => return control_response(app, false, error.to_string()),
            };
            let patch = crate::settings::SettingsPatch {
                general: Some(crate::settings::GeneralPatch {
                    check_updates: Some(check_updates),
                    auto_install_updates: Some(auto_install_updates),
                    ..Default::default()
                }),
                ..Default::default()
            };
            match app.state::<AppState>().update_settings(app, &patch) {
                Ok(_) => control_response(app, true, "Update policy saved".into()),
                Err(error) => control_response(app, false, error.to_string()),
            }
        }
        ControlRequest::Configure {
            allow_remote_monitoring,
            show_menu_bar_icon,
            launch_at_login,
        } => {
            let _maintenance = match crate::updates::maintenance(app) {
                Ok(guard) => guard,
                Err(error) => return control_response(app, false, error.to_string()),
            };
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let handle = app.clone();
            if let Err(e) = app.run_on_main_thread(move || {
                let state = handle.state::<AppState>();
                let patch = crate::settings::SettingsPatch {
                    remote_access: Some(crate::settings::RemoteAccessPatch {
                        enabled: Some(allow_remote_monitoring),
                    }),
                    general: Some(crate::settings::GeneralPatch {
                        show_menu_bar: show_menu_bar_icon,
                        launch_at_login,
                        ..Default::default()
                    }),
                    onboarding: Some(crate::settings::OnboardingPatch {
                        completed: Some(true),
                    }),
                    ..Default::default()
                };
                let _ = tx.send(state.update_settings(&handle, &patch));
            }) {
                return control_response(app, false, e.to_string());
            }
            match rx.recv_timeout(std::time::Duration::from_secs(15)) {
                Ok(Ok(_)) => control_response(app, true, "Remote monitoring configured".into()),
                Ok(Err(e)) => control_response(app, false, e.to_string()),
                Err(e) => control_response(app, false, e.to_string()),
            }
        }
        ControlRequest::PairStart { .. }
        | ControlRequest::PairStatus { .. }
        | ControlRequest::PairAbandon { .. } => {
            tracing::warn!("pairing control request reached the settings handler");
            control_response(app, false, "Unsupported control request".into())
        }
    }
}

fn pairing_unavailable() -> ControlResponse {
    ControlResponse {
        ok: false,
        message: PairError::Unavailable.to_string(),
        host: None,
        allow_remote_monitoring: None,
        show_menu_bar_icon: None,
        launch_at_login: None,
        updates: None,
        pairing: Some(PairReply::Error {
            error: PairError::Unavailable,
        }),
        pairing_expires_ms: None,
    }
}

/// Starts or stops sharing over the metrics socket. `enabled` comes from the caller: see
/// [`crate::settings::SettingsEffects`] for why the settings-change path can't read it.
pub fn refresh_metrics(app: &AppHandle, enabled: bool) {
    if let Some(pairing) = app.try_state::<PairingState>() {
        pairing.set_enabled(enabled);
    }
    let state = app.state::<AppState>();
    let mut setting = state.remotes.metrics_stop.lock_ok();
    if let Some(tx) = setting.as_ref() {
        let _ = tx.send(enabled);
        return;
    }
    let Ok(entry) = state.host(state.local) else {
        return;
    };
    let Ok(dir) = data_dir(app) else { return };
    // Remote sessions get their own space service, apart from the dashboard's (D-117),
    // in editions that scan at all.
    let mut server =
        HostServer::new(entry, state.history.store()).with_device_seen(device_seen(&dir));
    if crate::disk_space::available() {
        server = server.with_space(Arc::new(SpaceService::new()));
    }
    let provider = Arc::new(server);
    let path = SocketPaths::new(dir).metrics;
    let (tx, mut desired) = tokio::sync::watch::channel(enabled);
    *setting = Some(tx);
    // One owner serializes bind/unlink, including rapid off/on settings changes.
    tauri::async_runtime::spawn(async move {
        loop {
            if !*desired.borrow_and_update() {
                if desired.changed().await.is_err() {
                    break;
                }
                continue;
            }
            let (stop, rx) = tokio::sync::watch::channel(false);
            let server = statglass_remote::serve_metrics(path.clone(), provider.clone(), rx);
            tokio::pin!(server);
            tokio::select! {
                result=&mut server=>{
                    if let Err(e)=result{tracing::error!("remote metrics socket: {e}");}
                    tokio::select!{_ = tokio::time::sleep(std::time::Duration::from_secs(1))=>{}, changed=desired.changed()=>{if changed.is_err(){break;}}}
                }
                changed=desired.changed()=>{
                    let _=stop.send(true);
                    let _=server.await;
                    if changed.is_err(){break;}
                }
            }
        }
    });
}

pub fn shutdown(app: &AppHandle) {
    if let Some(pairing) = app.try_state::<PairingState>() {
        pairing.shutdown();
    }
    let state = app.state::<AppState>();
    if let Some(task) = state.remotes.rr_task.lock_ok().take() {
        task.abort();
    }
    state.remotes.monitor.lock_ok().take();
    for (_, watcher) in std::mem::take(&mut *state.remotes.watchers.lock_ok()) {
        watcher.abort();
    }
    if let Some(tx) = state.remotes.stop.lock_ok().take() {
        let _ = tx.send(true);
    }
    state.remotes.metrics_stop.lock_ok().take();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::{
        PairingStatus, pairing_approve, pairing_status,
        tests::{DEVICE_KEY, app},
    };
    use statglass_proto::pairing::{BundleHost, PairStart};

    #[tokio::test(start_paused = true)]
    async fn pairing_control_returns_the_deadline_and_forwards_abandonment() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let socket = dir.path().join("control.sock");
        let app = app(dir.path());
        let state = app.state::<PairingState>();
        state.set_enabled(true);
        let host = state.host().unwrap();
        let now = statglass_engine::wall_ms();
        let bundle = BundleHost {
            host_id: HostId(Uuid::nil()),
            name: "Test Mac".into(),
            os: "macOS".into(),
            user: "test".into(),
            port: None,
            targets: vec![],
            host_keys: vec![],
        };
        let offer = host
            .offer(bundle.clone(), std::time::Duration::ZERO, now)
            .unwrap();
        let start = |nonce: &str| PairStart {
            nonce: nonce.into(),
            device_key: DEVICE_KEY.into(),
            device_name: "Riley’s iPhone".into(),
            model: "iPhone 16".into(),
        };
        let attempt = [1; 16];
        let handle = app.handle().clone();
        let (stop, rx) = tokio::sync::watch::channel(false);
        let server = statglass_remote::serve_control(
            socket.clone(),
            Arc::new(move |request| {
                control(&handle, request, now, |_| {
                    panic!("expected a pairing request")
                })
            }),
            rx,
        );
        let request = |request| {
            let socket = &socket;
            async move {
                statglass_remote::control_request(socket, &request)
                    .await
                    .unwrap()
            }
        };
        let client = async {
            let response = request(ControlRequest::PairStart {
                start: start(&offer.nonce),
                attempt,
            })
            .await;
            assert_eq!(response.pairing, Some(PairReply::Waiting));
            assert_eq!(response.pairing_expires_ms, Some(offer.expires_ms));
            assert!(matches!(
                pairing_status(offer.nonce.clone(), app.state()).await.unwrap(),
                PairingStatus::Pending { device_name, model, code } if device_name == "Riley’s iPhone" && model == "iPhone 16" && code == offer.code
            ));
            let status = || ControlRequest::PairStatus {
                nonce: offer.nonce.clone(),
            };
            assert_eq!(request(status()).await.pairing, Some(PairReply::Waiting));
            let abandon = ControlRequest::PairAbandon {
                nonce: offer.nonce.clone(),
                attempt,
            };
            assert_eq!(request(abandon).await.pairing, Some(PairReply::Expired));
            assert_eq!(request(status()).await.pairing, Some(PairReply::Expired));
            assert!(matches!(
                pairing_status(offer.nonce.clone(), app.state())
                    .await
                    .unwrap(),
                PairingStatus::Expired
            ));
            assert!(matches!(
                pairing_approve(offer.nonce, app.state()).await.unwrap(),
                PairingStatus::Expired
            ));

            let second = host
                .offer(bundle.clone(), std::time::Duration::ZERO, now)
                .unwrap();
            let reply = request(ControlRequest::PairStart {
                start: start(&second.nonce),
                attempt,
            })
            .await;
            assert_eq!(reply.pairing, Some(PairReply::Waiting));
            let PairingStatus::Paired { device } =
                pairing_approve(second.nonce.clone(), app.state())
                    .await
                    .unwrap()
            else {
                panic!("the waiting phone should pair after approval");
            };
            let receipt = request(ControlRequest::PairStatus {
                nonce: second.nonce,
            })
            .await;
            assert_eq!(
                receipt.pairing,
                Some(PairReply::Approved {
                    device,
                    hosts: vec![bundle]
                })
            );
            stop.send(true).unwrap();
        };
        let (server, ()) = tokio::join!(server, client);
        server.unwrap();
    }
}
