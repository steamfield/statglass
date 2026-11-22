use super::*;
use DockerUnavailableReason as R;
use statglass_schema::docker::DockerRuntimeKind;

fn engine(socket: &str, reachable: bool, preferred: bool) -> DockerEngine {
    DockerEngine {
        id: socket.into(),
        daemon_id: None,
        runtime: "Docker Desktop".into(),
        context: None,
        socket: socket.into(),
        reachable,
        preferred,
        error: None,
        api_version: None,
        capacity_bytes: None,
        capacity_observed_ms: None,
    }
}

fn desktop() -> DockerRuntimeApp {
    DockerRuntimeApp {
        kind: DockerRuntimeKind::DockerDesktop,
        name: "Docker Desktop".into(),
        launchable: true,
    }
}

fn reason(
    engines: &[DockerEngine],
    runtimes: &[DockerRuntimeApp],
    selected: Option<&str>,
    was_connected: bool,
) -> DockerUnavailableReason {
    unavailable_reason(ReasonInput {
        engines,
        runtimes,
        selected,
        was_connected,
    })
}

#[test]
fn nothing_found_is_not_installed() {
    assert_eq!(reason(&[], &[], None, false), R::NotInstalled);
}

#[test]
fn an_installed_runtime_without_an_answering_engine_is_not_running() {
    assert_eq!(reason(&[], &[desktop()], None, false), R::NotRunning);
    let stale = [engine("/Users/me/.docker/run/docker.sock", false, false)];
    assert_eq!(reason(&stale, &[], None, false), R::NotRunning);
}

#[test]
fn an_engine_that_answered_earlier_has_stopped() {
    assert_eq!(reason(&[], &[desktop()], None, true), R::Stopped);
}

#[test]
fn several_answering_engines_without_a_choice_need_one() {
    let engines = [
        engine("/a.sock", true, false),
        engine("/b.sock", true, false),
    ];
    assert_eq!(reason(&engines, &[desktop()], None, false), R::ChooseEngine);
}

#[test]
fn a_preferred_or_selected_engine_means_no_choice_is_needed() {
    let preferred = [
        engine("/a.sock", true, true),
        engine("/b.sock", true, false),
    ];
    assert_eq!(reason(&preferred, &[desktop()], None, false), R::NotRunning);
    let plain = [
        engine("/a.sock", true, false),
        engine("/b.sock", true, false),
    ];
    assert_ne!(
        reason(&plain, &[desktop()], Some("/a.sock"), false),
        R::ChooseEngine
    );
}

#[test]
fn a_selected_socket_that_vanished_with_no_runtime_is_missing() {
    let other = [engine("/b.sock", false, false)];
    assert_eq!(
        reason(&other, &[], Some("/gone.sock"), false),
        R::SelectedMissing
    );
}

#[test]
fn a_selected_socket_of_an_installed_runtime_is_just_not_running() {
    assert_eq!(
        reason(
            &[],
            &[desktop()],
            Some("/Users/me/.docker/run/docker.sock"),
            false
        ),
        R::NotRunning
    );
}
