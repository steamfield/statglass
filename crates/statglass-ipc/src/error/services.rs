//! Disk space and Docker failures at the command boundary, converted by variant and never
//! by inspecting display strings. Both engine services are compiled out on iOS, so these
//! conversions are too.
use super::CommandError;
use statglass_engine::disk_space::SpaceError;
use statglass_engine::docker::{DockerServiceError, storage::DockerStorageError};

impl From<SpaceError> for CommandError {
    fn from(e: SpaceError) -> Self {
        Self::DiskSpace {
            message: e.to_string(),
        }
    }
}

impl From<DockerServiceError> for CommandError {
    fn from(error: DockerServiceError) -> Self {
        match error {
            DockerServiceError::InvalidRequest(message) => Self::InvalidArgument {
                message: message.into(),
            },
            DockerServiceError::Range(error) => error.into(),
            DockerServiceError::NotFound(message) => Self::DockerNotFound {
                message: message.into(),
            },
            DockerServiceError::SnapshotExpired(message) => Self::DockerSnapshotExpired {
                message: message.into(),
            },
            DockerServiceError::ResourceLimit(message) => Self::DockerResourceLimit {
                message: message.into(),
            },
            DockerServiceError::Store(source) => source.into(),
            DockerServiceError::Collector(source) => Self::Docker {
                message: source.to_string(),
            },
            DockerServiceError::Metadata { message, .. } => Self::StoreCorrupt {
                message: message.into(),
            },
            DockerServiceError::Serialization(source) => Self::Internal {
                message: source.to_string(),
            },
            DockerServiceError::WriteFailed(message) => Self::Store { message },
            DockerServiceError::Unavailable(message) => Self::Docker {
                message: message.into(),
            },
        }
    }
}

impl From<DockerStorageError> for CommandError {
    fn from(error: DockerStorageError) -> Self {
        let message = error.to_string();
        match error {
            DockerStorageError::Selection | DockerStorageError::VolumeConfirmation => {
                Self::InvalidArgument { message }
            }
            DockerStorageError::Review => Self::DockerSnapshotExpired { message },
            DockerStorageError::Busy => Self::DockerResourceLimit { message },
            DockerStorageError::Operation => Self::DockerNotFound { message },
            DockerStorageError::Unavailable(_) => Self::Docker { message },
        }
    }
}

#[cfg(test)]
mod tests;
