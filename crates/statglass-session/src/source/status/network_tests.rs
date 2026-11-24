//! Per-route failure recording and refinement against this Mac's network.
use super::{ConnectionFailureKind as K, ConnectionStatus, RouteFailure};
use crate::network::LocalNetwork;
use crate::{RemoteError, Route, UnreachableKind};

fn unreachable(kind: UnreachableKind) -> RemoteError {
    RemoteError::Unreachable {
        kind,
        detail: "studio.local: ssh failed".into(),
    }
}

fn both(lan: RemoteError, tailscale: RemoteError) -> RemoteError {
    RemoteError::Routes(vec![
        crate::RouteError {
            route: Route::Lan,
            host: "studio.local".into(),
            error: lan,
        },
        crate::RouteError {
            route: Route::Tailscale,
            host: "studio".into(),
            error: tailscale,
        },
    ])
}

const ONLINE: LocalNetwork = LocalNetwork {
    online: true,
    tailscale_up: true,
};

#[test]
fn unreachable_kinds_map_to_their_failure_kinds_and_retry() {
    let cases = [
        (UnreachableKind::NameNotResolved, K::NameNotResolved),
        (UnreachableKind::Refused, K::Refused),
        (UnreachableKind::NoRoute, K::NoRoute),
    ];
    for (kind, expected) in cases {
        let mut status = ConnectionStatus::default();
        status.record_failure(&unreachable(kind), Some(Route::Lan));
        assert_eq!(status.failure_kind, Some(expected));
        assert!(status.retrying, "{kind:?} is retryable");
        assert_eq!(
            status.route_failures,
            vec![RouteFailure {
                route: Route::Lan,
                kind: expected
            }]
        );
        assert_eq!(status.error.as_deref(), Some("studio.local: ssh failed"));
    }
}

#[test]
fn both_routes_keep_each_cause_and_pick_the_most_actionable() {
    let mut status = ConnectionStatus::default();
    status.record_failure(
        &both(
            unreachable(UnreachableKind::NameNotResolved),
            RemoteError::Timeout("studio-ts: Operation timed out".into()),
        ),
        None,
    );
    assert_eq!(status.failure_kind, Some(K::Timeout));
    assert_eq!(
        status.route_failures,
        vec![
            RouteFailure {
                route: Route::Lan,
                kind: K::NameNotResolved
            },
            RouteFailure {
                route: Route::Tailscale,
                kind: K::Timeout
            },
        ]
    );
    assert!(status.retrying);
    assert_eq!(
        status.error.as_deref(),
        Some("LAN: studio.local: ssh failed; Tailscale: studio-ts: Operation timed out")
    );
}

#[test]
fn multiple_targets_on_one_route_keep_their_individual_failures() {
    let error = RemoteError::Routes(vec![
        crate::RouteError {
            route: Route::Lan,
            host: "studio.local".into(),
            error: unreachable(UnreachableKind::NameNotResolved),
        },
        crate::RouteError {
            route: Route::Tailscale,
            host: "studio.tailnet.ts.net".into(),
            error: RemoteError::Timeout("timed out".into()),
        },
        crate::RouteError {
            route: Route::Tailscale,
            host: "100.64.0.1".into(),
            error: unreachable(UnreachableKind::Refused),
        },
    ]);
    let mut status = ConnectionStatus::default();
    status.record_failure(&error, None);
    assert_eq!(status.failure_kind, Some(K::Refused));
    assert_eq!(
        status.route_failures,
        vec![
            RouteFailure {
                route: Route::Lan,
                kind: K::NameNotResolved
            },
            RouteFailure {
                route: Route::Tailscale,
                kind: K::Timeout
            },
            RouteFailure {
                route: Route::Tailscale,
                kind: K::Refused
            },
        ]
    );
}

#[test]
fn a_dual_route_error_that_was_not_combined_records_no_routes() {
    let mut status = ConnectionStatus::default();
    status.record_failure(&RemoteError::Authentication("denied".into()), None);
    assert!(status.route_failures.is_empty());
    assert_eq!(status.failure_kind, Some(K::Authentication));
}

#[test]
fn priority_orders_causes_by_what_this_mac_can_fix() {
    let order = [
        K::LocalOffline,
        K::TailscaleDown,
        K::AgentNotRunning,
        K::Refused,
        K::Timeout,
        K::NoRoute,
        K::NameNotResolved,
        K::Unreachable,
    ];
    for pair in order.windows(2) {
        assert!(pair[0].priority() < pair[1].priority(), "{pair:?}");
    }
}

#[test]
fn tailscale_down_on_this_mac_outranks_a_lan_name_miss() {
    let mut status = ConnectionStatus::default();
    status.record_failure(
        &both(
            unreachable(UnreachableKind::NameNotResolved),
            unreachable(UnreachableKind::NameNotResolved),
        ),
        None,
    );
    status.apply_network(LocalNetwork {
        online: true,
        tailscale_up: false,
    });
    assert_eq!(status.failure_kind, Some(K::TailscaleDown));
    assert_eq!(status.route_failures[0].kind, K::NameNotResolved);
    assert_eq!(status.route_failures[1].kind, K::TailscaleDown);
}

#[test]
fn offline_overrides_every_route_and_an_uncombined_network_error() {
    let mut status = ConnectionStatus::default();
    status.record_failure(
        &both(
            unreachable(UnreachableKind::NoRoute),
            RemoteError::Timeout("timed out".into()),
        ),
        None,
    );
    let offline = LocalNetwork {
        online: false,
        tailscale_up: false,
    };
    status.apply_network(offline);
    assert_eq!(status.failure_kind, Some(K::LocalOffline));
    assert!(
        status
            .route_failures
            .iter()
            .all(|r| r.kind == K::LocalOffline)
    );

    let mut single = ConnectionStatus::default();
    single.record_failure(&RemoteError::Transport("socket closed".into()), None);
    single.apply_network(offline);
    assert_eq!(single.failure_kind, Some(K::LocalOffline));
}

#[test]
fn a_healthy_network_changes_nothing() {
    let mut status = ConnectionStatus::default();
    status.record_failure(
        &unreachable(UnreachableKind::Refused),
        Some(Route::Tailscale),
    );
    let before = (status.failure_kind, status.route_failures.clone());
    status.apply_network(ONLINE);
    assert_eq!((status.failure_kind, status.route_failures.clone()), before);
}

#[test]
fn blocking_failures_survive_an_offline_probe() {
    let mut status = ConnectionStatus::default();
    status.record_failure(&RemoteError::HostKey("changed".into()), Some(Route::Lan));
    status.apply_network(LocalNetwork {
        online: false,
        tailscale_up: false,
    });
    assert_eq!(status.failure_kind, Some(K::HostKey));
}
