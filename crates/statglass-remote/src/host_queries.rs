//! Answers to remote queries (D-117) from the host this process samples: per-app use from
//! its usage ring and its space report service. A scan belongs to the session that
//! started it: only that session cancels or clears it, and it is cancelled and its report
//! dropped when that session ends. A remote scan never enters privacy-protected
//! locations, so a remote user cannot read through this app's macOS privacy grants.
use crate::host_server::{HostServer, ServedHost};
use statglass_engine::disk_space::{SpaceError, SpaceService};
use statglass_proto::{Answer, ErrorCode, Query};
use statglass_schema::JS_SAFE_INT_MAX;
use statglass_schema::disk_space::SpaceVolume;
use statglass_schema::lock::LockExt;
use std::sync::{Arc, Mutex};

/// The host's space report service, and which session started its scan.
pub struct SpaceAccess {
    service: Arc<SpaceService>,
    owner: Mutex<Option<u64>>,
}

impl SpaceAccess {
    pub fn new(service: Arc<SpaceService>) -> Self {
        Self {
            service,
            owner: Mutex::new(None),
        }
    }

    fn answer(&self, session: u64, query: Query) -> Answer {
        let service = &self.service;
        let result = match query {
            Query::SpaceVolumes => Ok(Answer::SpaceVolumes(
                service
                    .volumes()
                    .into_iter()
                    .map(|v| SpaceVolume {
                        protected: Vec::new(),
                        ..v
                    })
                    .collect(),
            )),
            // `include` names protected locations, which a remote scan never enters.
            Query::SpaceStart { volume, .. } => service.start(&volume, &[]).map(|status| {
                *self.owner.lock_ok() = Some(session);
                Answer::SpaceStatus(status)
            }),
            Query::SpaceStatus => Ok(Answer::SpaceStatus(service.status())),
            Query::SpaceCancel => {
                if matches!(*self.owner.lock_ok(), Some(owner) if owner != session) {
                    return Answer::Error {
                        code: ErrorCode::Internal,
                        message: "Another StatGlass started this scan".into(),
                    };
                }
                service.cancel();
                Ok(Answer::Done)
            }
            Query::SpaceClear => {
                self.release(session);
                Ok(Answer::Done)
            }
            Query::SpaceReport => Ok(Answer::SpaceReport(service.report())),
            Query::SpaceSubtree { report, node } => {
                service.subtree(report, node).map(Answer::SpaceSubtree)
            }
            Query::SpaceLargestFiles { report } => {
                service.largest_files(report).map(Answer::SpaceFiles)
            }
            Query::SpacePath { report, target } => service
                .reveal_path(report, target)
                .map(|path| Answer::SpacePath(path.to_string_lossy().into_owned())),
            _ => return unsupported(),
        };
        result.unwrap_or_else(|e: SpaceError| Answer::Error {
            code: ErrorCode::Internal,
            message: e.to_string(),
        })
    }

    /// A session ended: a scan it started stops, and its report goes, so a controller
    /// that went away leaves no walk running and no tree held on the host.
    fn release(&self, session: u64) {
        let mut owner = self.owner.lock_ok();
        if *owner == Some(session) {
            *owner = None;
            self.service.cancel();
            self.service.clear();
        }
    }
}

pub(crate) fn unsupported() -> Answer {
    Answer::Error {
        code: ErrorCode::Unsupported,
        message: "This host does not answer that query".into(),
    }
}

impl<H: ServedHost> HostServer<H> {
    pub(crate) fn answer_query(&self, session: u64, query: Query) -> Answer {
        match query {
            Query::UsageByApp {
                from_ms,
                to_ms,
                by,
                limit,
            } => Answer::UsageByApp(self.host().hub().usage_by_app(
                // Timestamps are below 2^53 (statglass-schema); a wire value past that would
                // overflow the bucket rounding.
                from_ms.clamp(-JS_SAFE_INT_MAX, JS_SAFE_INT_MAX),
                to_ms.clamp(-JS_SAFE_INT_MAX, JS_SAFE_INT_MAX),
                by,
                usize::try_from(limit).unwrap_or(usize::MAX).min(500),
            )),
            Query::HistoricalUsage(request) => {
                if let Err(error) = request.validate() {
                    return invalid(&error.to_string());
                }
                if request.host != self.host().record().id {
                    return invalid("usage query host does not match this host");
                }
                self.history()
                    .historical_usage(&request, || {
                        self.host()
                            .hub()
                            .recent_usage_apps(request.from_ms, request.to_ms)
                    })
                    .map(Answer::HistoricalUsage)
                    .unwrap_or_else(usage_error)
            }
            Query::UsageProcesses(request) => {
                if let Err(error) = request.validate() {
                    return invalid(&error.to_string());
                }
                if request.host != self.host().record().id {
                    return invalid("usage query host does not match this host");
                }
                self.history()
                    .usage_processes(&request, || {
                        self.host().hub().recent_usage_processes(
                            request.from_ms,
                            request.to_ms,
                            &request.app_name,
                        )
                    })
                    .map(Answer::UsageProcesses)
                    .unwrap_or_else(usage_error)
            }
            Query::AlertRules => self.host().alert_rules(),
            Query::SetAlertRules {
                base_revision,
                rules,
                keep,
            } => self.host().set_alert_rules(base_revision, rules, keep),
            Query::Unknown => unsupported(),
            space => match self.space() {
                Some(access) => access.answer(session, space),
                None => unsupported(),
            },
        }
    }

    pub(crate) fn release_queries(&self, session: u64) {
        if let Some(access) = self.space() {
            access.release(session);
        }
    }
}

fn invalid(message: &str) -> Answer {
    Answer::Error {
        code: ErrorCode::InvalidArgument,
        message: message.into(),
    }
}

fn usage_error(error: statglass_engine::HistoryStoreError) -> Answer {
    match error {
        statglass_engine::HistoryStoreError::Unavailable { .. }
        | statglass_engine::HistoryStoreError::Store(statglass_store::StoreError::WriterGone) => {
            Answer::Error {
                code: ErrorCode::HistoryUnavailable,
                message: "History is unavailable on this host".into(),
            }
        }
        statglass_engine::HistoryStoreError::Store(statglass_store::StoreError::Usage(message)) => {
            invalid(&message)
        }
        statglass_engine::HistoryStoreError::Store(error) if error.is_busy() => Answer::Error {
            code: ErrorCode::Busy,
            message: error.to_string(),
        },
        // A damaged database file cannot answer until it is reset on the host. A row that
        // fails to decode stays `Internal`: the rest of the store still answers.
        statglass_engine::HistoryStoreError::Store(error) if error.is_corrupt_database() => {
            Answer::Error {
                code: ErrorCode::HistoryUnavailable,
                message: error.to_string(),
            }
        }
        error => Answer::Error {
            code: ErrorCode::Internal,
            message: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServerProvider;
    use statglass_engine::{HistoryStore, HistoryStoreError, LiveHub};
    use statglass_proto::{HostAlertRules, RuleEntry};
    use statglass_schema::{
        AlertRule, Capabilities, Cmp, Condition, HostRecord, Labels, MetricId, OsKind,
        SeriesSelector,
    };
    use statglass_store::{StoreError, rusqlite};
    use uuid::Uuid;

    #[derive(Default)]
    struct DefaultHost(LiveHub);

    impl ServedHost for DefaultHost {
        fn record(&self) -> HostRecord {
            crate::test_support::bare_host(7, "Server", OsKind::Linux)
        }

        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }

        fn hub(&self) -> &LiveHub {
            &self.0
        }

        fn set_remote_interest(&self, _: u64, _: statglass_proto::RemoteInterest) {}
    }

    #[derive(Default)]
    struct AlertHost {
        host: DefaultHost,
        set_call: Mutex<Option<Query>>,
    }

    impl ServedHost for AlertHost {
        fn record(&self) -> HostRecord {
            self.host.record()
        }

        fn capabilities(&self) -> Capabilities {
            self.host.capabilities()
        }

        fn hub(&self) -> &LiveHub {
            self.host.hub()
        }

        fn set_remote_interest(&self, session: u64, interest: statglass_proto::RemoteInterest) {
            self.host.set_remote_interest(session, interest);
        }

        fn alert_rules(&self) -> Answer {
            Answer::AlertRules(HostAlertRules {
                revision: 9,
                rules: vec![],
            })
        }

        fn set_alert_rules(
            &self,
            base_revision: i64,
            rules: Vec<RuleEntry>,
            keep: Vec<Uuid>,
        ) -> Answer {
            *self.set_call.lock_ok() = Some(Query::SetAlertRules {
                base_revision,
                rules: rules.clone(),
                keep,
            });
            Answer::AlertRules(HostAlertRules {
                revision: 12,
                rules,
            })
        }
    }

    #[test]
    fn host_without_alert_overrides_refuses_both_queries() {
        let server = HostServer::new(
            Arc::new(DefaultHost::default()),
            Arc::new(HistoryStore::unavailable()),
        );
        for query in [
            Query::AlertRules,
            Query::SetAlertRules {
                base_revision: 9,
                rules: vec![],
                keep: vec![],
            },
        ] {
            assert!(matches!(
                server.answer(1, query),
                Answer::Error {
                    code: ErrorCode::Unsupported,
                    ..
                }
            ));
        }
    }

    #[test]
    fn alert_queries_use_host_overrides_and_forward_the_complete_update() {
        let host = Arc::new(AlertHost::default());
        let server = HostServer::new(host.clone(), Arc::new(HistoryStore::unavailable()));
        assert_eq!(
            server.answer(1, Query::AlertRules),
            Answer::AlertRules(HostAlertRules {
                revision: 9,
                rules: vec![]
            })
        );
        let rules = vec![
            RuleEntry::Known(AlertRule {
                id: Uuid::from_u128(1),
                name: "Boot volume almost full".into(),
                when: Condition::Threshold {
                    series: SeriesSelector {
                        metric: MetricId::from_static("disk.free"),
                        labels: Labels::single("vol", "/"),
                    },
                    op: Cmp::Lt,
                    value: 20e9,
                },
                for_secs: 60,
                cooldown_secs: 600,
                enabled: true,
            }),
            RuleEntry::Unknown(41_u32.into()),
        ];
        let query = Query::SetAlertRules {
            base_revision: 9,
            rules: rules.clone(),
            keep: vec![Uuid::from_u128(6), Uuid::from_u128(3)],
        };
        assert_eq!(
            server.answer(1, query.clone()),
            Answer::AlertRules(HostAlertRules {
                revision: 12,
                rules
            })
        );
        assert_eq!(host.set_call.lock_ok().take(), Some(query));
    }

    #[test]
    fn source_query_errors_preserve_validation_availability_and_retryability() {
        let cases = [
            (
                StoreError::Usage("process history changed; restart expansion".into()),
                ErrorCode::InvalidArgument,
            ),
            (StoreError::WriterGone, ErrorCode::HistoryUnavailable),
            (
                StoreError::Corrupt("bad usage blob".into()),
                ErrorCode::Internal,
            ),
            (
                StoreError::Cbor("bad usage row".into()),
                ErrorCode::Internal,
            ),
            (
                StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
                    None,
                )),
                ErrorCode::HistoryUnavailable,
            ),
            (
                StoreError::Locked {
                    path: "history.sqlite".into(),
                },
                ErrorCode::Busy,
            ),
            (
                StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
                    None,
                )),
                ErrorCode::Internal,
            ),
            (
                StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                    None,
                )),
                ErrorCode::Busy,
            ),
        ];
        for (error, expected) in cases {
            let Answer::Error { code, message } = usage_error(HistoryStoreError::Store(error))
            else {
                panic!("expected typed error")
            };
            assert_eq!(code, expected);
            assert!(!message.is_empty());
        }
    }
}
