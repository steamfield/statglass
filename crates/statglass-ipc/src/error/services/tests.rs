use super::*;
use statglass_store::StoreError;

fn kind(error: impl Into<CommandError>) -> String {
    serde_json::to_value(error.into()).unwrap()["kind"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn query_error_categories_survive_ipc_serialization() {
    // Identical diagnostics must still produce different machine-readable results.
    assert_eq!(
        kind(DockerServiceError::InvalidRequest("same")),
        "invalid_argument"
    );
    assert_eq!(
        kind(DockerServiceError::NotFound("same")),
        "docker_not_found"
    );
    assert_eq!(
        kind(DockerServiceError::SnapshotExpired("same")),
        "docker_snapshot_expired"
    );
    assert_eq!(
        kind(DockerServiceError::ResourceLimit("same")),
        "docker_resource_limit"
    );
    assert_eq!(kind(DockerServiceError::Unavailable("same")), "docker");
}

#[test]
fn docker_store_failures_use_existing_store_recovery_categories() {
    assert_eq!(
        kind(DockerServiceError::Store(StoreError::WriterGone)),
        "history_unavailable"
    );
    assert_eq!(
        kind(DockerServiceError::Store(StoreError::Corrupt(
            "bad metadata".into()
        ))),
        "store_corrupt"
    );
    assert_eq!(
        kind(DockerServiceError::Store(StoreError::TooNew {
            found: 9,
            supported: 2
        })),
        "store_too_new"
    );
}

#[test]
fn cleanup_errors_distinguish_revalidation_from_busy_and_missing_results() {
    assert_eq!(kind(DockerStorageError::Review), "docker_snapshot_expired");
    assert_eq!(kind(DockerStorageError::Busy), "docker_resource_limit");
    assert_eq!(kind(DockerStorageError::Operation), "docker_not_found");
    assert_eq!(
        kind(DockerStorageError::VolumeConfirmation),
        "invalid_argument"
    );
    assert_eq!(kind(DockerStorageError::Selection), "invalid_argument");
}
