use super::*;
use DockerRuntimeKind as K;

fn installed(kind: K, name: &str, launchable: bool) -> DockerRuntimeApp {
    DockerRuntimeApp {
        kind,
        name: name.into(),
        launchable,
    }
}

fn message(result: Result<&'static str, CommandError>) -> String {
    match result {
        Err(CommandError::Docker { message }) => message,
        other => panic!("expected a Docker error, got {other:?}"),
    }
}

#[test]
fn an_installed_app_opens_by_its_bundle_id() {
    let apps = [
        installed(K::DockerDesktop, "Docker Desktop", true),
        installed(K::OrbStack, "OrbStack", true),
    ];
    assert_eq!(
        launch_target(K::OrbStack, &apps).unwrap(),
        "dev.kdrag0n.MacVirt"
    );
    assert_eq!(
        launch_target(K::DockerDesktop, &apps).unwrap(),
        "com.docker.docker"
    );
}

#[test]
fn a_runtime_that_is_not_installed_is_refused() {
    let apps = [installed(K::OrbStack, "OrbStack", true)];
    assert_eq!(
        message(launch_target(K::DockerDesktop, &apps)),
        "Docker Desktop isn’t installed on this Mac."
    );
}

#[test]
fn colima_has_no_app_to_open() {
    let apps = [installed(K::Colima, "Colima", false)];
    assert_eq!(
        message(launch_target(K::Colima, &apps)),
        "Colima has no app to open. Run `colima start` in Terminal."
    );
}
