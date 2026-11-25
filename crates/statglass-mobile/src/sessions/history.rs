use statglass_ipc::{
    error::CommandError,
    history::{HistoryPoint, HistorySeries},
    mobile::{HistoryClamp, HostHistoryPage, HostHistoryRequest, SeriesHistoryStats},
};
use statglass_proto::{HistoryAnswer, HistoryClamp as WireClamp, HistoryQuery, WireEvent};
use statglass_schema::{Event, EventDetail};

use super::registry::Registry;

impl Registry {
    pub(super) async fn host_history(
        &self,
        request: HostHistoryRequest,
    ) -> Result<HostHistoryPage, CommandError> {
        let entry = self.entry(request.host)?.running()?;
        let answer = entry
            .source
            .history(HistoryQuery {
                series: request.series,
                from_ms: request.from_ms,
                to_ms: request.to_ms,
                max_points: request.max_points,
                events_for: request.events_for,
            })
            .await?;
        Ok(page(answer))
    }
}

fn page(answer: HistoryAnswer) -> HostHistoryPage {
    HostHistoryPage {
        tier: answer.tier,
        bucket_ms: answer.bucket_ms,
        complete_to_ms: answer.complete_to_ms,
        series: answer
            .series
            .into_iter()
            .map(|series| HistorySeries {
                key: series.key,
                hold_ms: series.hold_ms,
                points: series
                    .points
                    .into_iter()
                    .map(|(t, avg, min, max)| HistoryPoint { t, avg, min, max })
                    .collect(),
            })
            .collect(),
        gaps: answer.gaps,
        events: answer.events.into_iter().filter_map(event).collect(),
        stats: answer
            .stats
            .into_iter()
            .map(|stats| SeriesHistoryStats {
                key: stats.key,
                avg: stats.avg,
                peak: stats.peak,
            })
            .collect(),
        clamped: answer
            .clamped
            .into_iter()
            .map(|clamp| match clamp {
                WireClamp::Points => HistoryClamp::Points,
                WireClamp::Series => HistoryClamp::Series,
                WireClamp::Events => HistoryClamp::Events,
                WireClamp::Bytes => HistoryClamp::Bytes,
                WireClamp::Unknown => HistoryClamp::Unknown,
            })
            .collect(),
    }
}

fn event(row: WireEvent) -> Option<Event> {
    if !EventDetail::KINDS.contains(&row.kind.as_str()) {
        return None;
    }
    ciborium::from_reader(row.payload.as_slice())
        .inspect_err(|error| {
            tracing::debug!(
                error = error as &dyn std::error::Error,
                kind = %row.kind,
                ts_ms = row.ts_ms,
                "skipping unreadable history event"
            );
        })
        .ok()
}
