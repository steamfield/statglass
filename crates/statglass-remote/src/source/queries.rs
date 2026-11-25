//! Typed remote queries (D-117): each asks the host one `Query` and takes the `Answer`
//! it expects. How a refusal or a mismatched answer becomes an error is decided once, in
//! `ask`.
use super::RemoteSource;
use crate::{RemoteError, Result};
use statglass_proto::{Answer, ErrorCode, HostAlertRules, Query, RuleEntry};
use statglass_schema::disk_space::{
    SpaceFile, SpaceReport, SpaceScanStatus, SpaceSubtree, SpaceTarget, SpaceVolume,
};
use statglass_schema::usage::{UsageByApp, UsageKey};
use std::time::Duration;
use uuid::Uuid;

/// How long a query waits for its answer before the host counts as busy.
const ANSWER_WITHIN: Duration = Duration::from_secs(15);

impl RemoteSource {
    async fn ask<T>(&self, query: Query, pick: impl FnOnce(Answer) -> Option<T>) -> Result<T> {
        match self.call(query, ANSWER_WITHIN).await? {
            Answer::Error { code, message } => Err(match code {
                ErrorCode::Unsupported => RemoteError::Unsupported(message),
                ErrorCode::HistoryUnavailable => RemoteError::HistoryUnavailable(message),
                ErrorCode::InvalidArgument => RemoteError::InvalidArgument(message),
                ErrorCode::Busy => RemoteError::Busy(message),
                ErrorCode::Stale => RemoteError::Stale(message),
                _ => RemoteError::Refused(message),
            }),
            // A newer host's answer this build cannot read.
            Answer::Unknown => Err(RemoteError::Unsupported(
                "This host answered in a form this StatGlass can't read; update StatGlass on this Mac"
                    .into(),
            )),
            answer => pick(answer)
                .ok_or_else(|| RemoteError::Protocol("the host sent an unexpected answer".into())),
        }
    }

    pub async fn alert_rules(&self) -> Result<HostAlertRules> {
        self.ask(Query::AlertRules, pick_alert_rules).await
    }

    pub async fn set_alert_rules(
        &self,
        base_revision: i64,
        rules: Vec<RuleEntry>,
        keep: Vec<Uuid>,
    ) -> Result<HostAlertRules> {
        let query = Query::SetAlertRules {
            base_revision,
            rules,
            keep,
        };
        self.ask(query, pick_alert_rules).await
    }

    pub async fn usage_by_app(
        &self,
        from_ms: i64,
        to_ms: i64,
        by: UsageKey,
        limit: u32,
    ) -> Result<UsageByApp> {
        let query = Query::UsageByApp {
            from_ms,
            to_ms,
            by,
            limit,
        };
        self.ask(query, |a| match a {
            Answer::UsageByApp(usage) => Some(usage),
            _ => None,
        })
        .await
    }

    pub async fn historical_usage(
        &self,
        request: statglass_schema::durable_usage::HistoricalUsageRequest,
    ) -> Result<statglass_schema::durable_usage::HistoricalUsageReply> {
        request
            .validate()
            .map_err(|e| RemoteError::InvalidArgument(e.to_string()))?;
        if request.host != self.record.id {
            return Err(RemoteError::InvalidArgument(
                "usage query host does not match the source".into(),
            ));
        }
        self.ask(Query::HistoricalUsage(request), |answer| match answer {
            Answer::HistoricalUsage(reply) => Some(reply),
            _ => None,
        })
        .await
    }

    pub async fn usage_processes(
        &self,
        request: statglass_schema::durable_usage::UsageProcessRequest,
    ) -> Result<statglass_schema::durable_usage::UsageProcessReply> {
        request
            .validate()
            .map_err(|e| RemoteError::InvalidArgument(e.to_string()))?;
        if request.host != self.record.id {
            return Err(RemoteError::InvalidArgument(
                "usage query host does not match the source".into(),
            ));
        }
        self.ask(Query::UsageProcesses(request), |answer| match answer {
            Answer::UsageProcesses(reply) => Some(reply),
            _ => None,
        })
        .await
    }

    pub async fn space_volumes(&self) -> Result<Vec<SpaceVolume>> {
        self.ask(Query::SpaceVolumes, |a| match a {
            Answer::SpaceVolumes(v) => Some(v),
            _ => None,
        })
        .await
    }

    pub async fn space_start(&self, volume: String) -> Result<SpaceScanStatus> {
        // A remote scan never enters protected locations (D-117), so none are asked for.
        let query = Query::SpaceStart {
            volume,
            include: Vec::new(),
        };
        self.ask(query, status).await
    }

    pub async fn space_status(&self) -> Result<SpaceScanStatus> {
        self.ask(Query::SpaceStatus, status).await
    }

    pub async fn space_cancel(&self) -> Result<()> {
        self.ask(Query::SpaceCancel, done).await
    }

    /// Drops the scan this session started there (the dashboard closed).
    pub async fn space_clear(&self) -> Result<()> {
        self.ask(Query::SpaceClear, done).await
    }

    pub async fn space_report(&self) -> Result<Option<SpaceReport>> {
        self.ask(Query::SpaceReport, |a| match a {
            Answer::SpaceReport(r) => Some(r),
            _ => None,
        })
        .await
    }

    pub async fn space_subtree(&self, report: u32, node: Option<u32>) -> Result<SpaceSubtree> {
        self.ask(Query::SpaceSubtree { report, node }, |a| match a {
            Answer::SpaceSubtree(s) => Some(s),
            _ => None,
        })
        .await
    }

    pub async fn space_largest_files(&self, report: u32) -> Result<Vec<SpaceFile>> {
        self.ask(Query::SpaceLargestFiles { report }, |a| match a {
            Answer::SpaceFiles(f) => Some(f),
            _ => None,
        })
        .await
    }

    pub async fn space_path(&self, report: u32, target: SpaceTarget) -> Result<String> {
        self.ask(Query::SpacePath { report, target }, |a| match a {
            Answer::SpacePath(p) => Some(p),
            _ => None,
        })
        .await
    }
}

fn pick_alert_rules(answer: Answer) -> Option<HostAlertRules> {
    match answer {
        Answer::AlertRules(rules) => Some(rules),
        _ => None,
    }
}

fn status(answer: Answer) -> Option<SpaceScanStatus> {
    match answer {
        Answer::SpaceStatus(s) => Some(s),
        _ => None,
    }
}

fn done(answer: Answer) -> Option<()> {
    matches!(answer, Answer::Done).then_some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calls::{Pending, open};
    use crate::{EndpointConfig, ServerProvider};
    use statglass_proto::Message;
    use statglass_schema::{
        AlertRule, Cmp, Condition, HostId, HostRecord, Labels, MetricId, SeriesSelector,
    };
    use std::sync::Arc;

    async fn request(
        queued: &mut tokio::sync::mpsc::Receiver<crate::calls::Call>,
        pending: &mut Pending,
    ) -> (u32, Query) {
        let call = tokio::time::timeout(ANSWER_WITHIN, queued.recv())
            .await
            .unwrap()
            .unwrap();
        let Message::Request { id, query } = pending.request(call) else {
            panic!("expected a request");
        };
        (id, query)
    }

    fn source() -> Arc<RemoteSource> {
        let hello = crate::server::tests::provider().hello();
        RemoteSource::new(
            HostRecord::from_identity(hello.host, false),
            HostId(Uuid::nil()),
            EndpointConfig {
                lan: Some("fixture".into()),
                tailscale: None,
                command: crate::RemoteCommand::default(),
            },
            Arc::new(|_| {}),
            None,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn alert_rules_queries_return_the_hosts_current_rules() {
        let source = source();
        let (_line, mut queued) = open(&source.line, true, false);
        let rule = RuleEntry::Known(AlertRule {
            id: Uuid::from_u128(1),
            name: "Memory pressure".into(),
            when: Condition::Threshold {
                series: SeriesSelector {
                    metric: MetricId::from_static("mem.pressure"),
                    labels: Labels::new(),
                },
                op: Cmp::Gt,
                value: 80.0,
            },
            for_secs: 120,
            cooldown_secs: 600,
            enabled: true,
        });
        let newer_id = Uuid::from_u128(2);
        let newer =
            RuleEntry::Unknown(vec![("id".into(), newer_id.as_bytes().as_slice().into())].into());
        let initial = HostAlertRules {
            revision: 1 << 45,
            rules: vec![newer.clone()],
        };
        let applied = HostAlertRules {
            revision: initial.revision + 1,
            rules: vec![rule.clone(), newer],
        };
        let edit = Query::SetAlertRules {
            base_revision: initial.revision,
            rules: vec![rule.clone()],
            keep: vec![newer_id],
        };
        let ((), ()) = tokio::join!(
            async {
                let loaded = source.alert_rules().await.unwrap();
                assert_eq!(loaded, initial);
                let saved = source
                    .set_alert_rules(loaded.revision, vec![rule], vec![newer_id])
                    .await
                    .unwrap();
                assert_eq!(saved, applied);
            },
            async {
                let mut pending = Pending::default();
                for (expected, reply) in [
                    (Query::AlertRules, initial.clone()),
                    (edit, applied.clone()),
                ] {
                    let (id, query) = request(&mut queued, &mut pending).await;
                    assert_eq!(query, expected);
                    pending.reply(id, Answer::AlertRules(reply));
                }
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn alert_rules_queries_preserve_host_refusals() {
        use RemoteError::{InvalidArgument, Refused, Stale, Unsupported};

        let source = source();
        let (_line, mut queued) = open(&source.line, true, false);
        let mut pending = Pending::default();
        let cases = [
            (ErrorCode::Stale, Stale("reload the rules".into())),
            (
                ErrorCode::Unsupported,
                Unsupported("update the agent".into()),
            ),
            (
                ErrorCode::InvalidArgument,
                InvalidArgument("rule value is out of range".into()),
            ),
            (
                ErrorCode::Internal,
                Refused("saving the rules failed".into()),
            ),
        ];
        for (code, expected) in cases {
            let answer = Answer::Error {
                code,
                message: expected.to_string(),
            };
            let (actual, ()) = tokio::join!(
                async {
                    if code == ErrorCode::Unsupported {
                        source.alert_rules().await
                    } else {
                        source.set_alert_rules(1, vec![], vec![]).await
                    }
                },
                async {
                    let (id, _) = request(&mut queued, &mut pending).await;
                    pending.reply(id, answer);
                }
            );
            let actual = actual.unwrap_err();
            assert_eq!(
                std::mem::discriminant(&actual),
                std::mem::discriminant(&expected),
                "{actual:?}"
            );
            assert_eq!(actual.to_string(), expected.to_string());
            assert!(!actual.retryable());
        }
    }
}
