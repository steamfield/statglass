//! Coverage reads. Rows stream to a visitor in start order without a count cap, so one
//! flapping container's episodes never fail a read; the caller folds what it keeps.
use super::*;

/// The columns every coverage read selects, joined to the container's external ID.
const COLUMNS: &str = "SELECT c.start_ms,c.end_ms,c.metric,c.reason,c.revision,c.sampled_ms,c.expected_ms,e.external_id FROM docker_coverage c LEFT JOIN docker_entities e ON e.id=c.entity_id";
/// Rows that overlap `(?2, ?3)`: the `(engine_id|entity_id, end_ms)` indexes serve the
/// end bound, and an open row overlaps every later range.
const OVERLAPS: &str = "c.start_ms<?3 AND (c.end_ms>?2 OR c.end_ms IS NULL)";
/// At most this many event-coverage rows are returned; events-kind rows are a handful
/// per reconnect, so the bound only keeps a pathological store from growing a page.
const MAX_EVENT_ROWS: usize = 10_000;

impl DockerReadSnapshot<'_> {
    /// Each engine-wide row overlapping `[start, end)`, in start order.
    pub fn engine_coverage(
        &self,
        start: i64,
        end: i64,
        visit: impl FnMut(DockerCoverage) -> Result<()>,
    ) -> Result<()> {
        bounds(start, end, 900_000)?;
        let sql = format!(
            "{COLUMNS} WHERE c.engine_id=?1 AND c.entity_id IS NULL AND {OVERLAPS} ORDER BY c.start_ms,c.id"
        );
        self.stream(&sql, params![self.engine, start, end], Some(start), visit)
    }
    /// Each row of one container (or the aggregate, `""`) overlapping `[start, end)`,
    /// in start order. Engine-wide rows are not included.
    pub fn entity_coverage(
        &self,
        entity: &str,
        start: i64,
        end: i64,
        visit: impl FnMut(DockerCoverage) -> Result<()>,
    ) -> Result<()> {
        bounds(start, end, 900_000)?;
        let Some(id) = self.entity(entity)? else {
            return Ok(());
        };
        let sql = format!("{COLUMNS} WHERE c.entity_id=?1 AND {OVERLAPS} ORDER BY c.start_ms,c.id");
        self.stream(&sql, params![id, start, end], Some(start), visit)
    }
    /// Rows with one of `reasons` (the events-kind keys) overlapping `[start, end)`:
    /// engine-wide ones, and `entity`'s own when given.
    pub fn event_coverage(
        &self,
        entity: Option<&str>,
        start: i64,
        end: i64,
        reasons: &[&str],
    ) -> Result<Vec<DockerCoverage>> {
        bounds(start, end, 0)?;
        if reasons.is_empty() || reasons.len() > 32 {
            return Err(invalid("invalid event coverage reasons"));
        }
        let entity = entity
            .map(|id| self.entity(id).map(|id| id.unwrap_or(-1)))
            .transpose()?;
        let list = (0..reasons.len())
            .map(|i| format!("?{}", i + 5))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "{COLUMNS} WHERE c.engine_id=?1 AND (c.entity_id IS NULL OR c.entity_id=?4) AND {OVERLAPS} AND c.reason IN ({list}) ORDER BY c.start_ms,c.id"
        );
        let mut values: Vec<&dyn rusqlite::ToSql> = vec![&self.engine, &start, &end, &entity];
        values.extend(reasons.iter().map(|r| r as &dyn rusqlite::ToSql));
        let mut out = Vec::new();
        let mut bytes = 0;
        self.stream(&sql, values.as_slice(), Some(start), |c| {
            bytes += c.reason.len() + 256;
            self.check(bytes)?;
            if out.len() < MAX_EVENT_ROWS {
                out.push(c);
            }
            Ok(())
        })?;
        Ok(out)
    }
    /// The engine's coverage rows without a metric that are still open, at any age,
    /// after the reads' resumption rule closes those a later observation ended.
    /// Restore reads only these, never the closed rows of the retained range.
    pub fn open_coverage(&self) -> Result<Vec<DockerCoverage>> {
        let sql = format!(
            "{COLUMNS} WHERE c.engine_id=?1 AND c.end_ms IS NULL AND c.metric IS NULL ORDER BY c.start_ms,c.id LIMIT 10001"
        );
        let mut result = Vec::new();
        let mut bytes = 0;
        self.stream(&sql, [self.engine], None, |c| {
            bytes += pack(&c)?.len();
            self.check(bytes)?;
            if result.len() >= 10_000 {
                return Err(invalid("coverage response count exceeded"));
            }
            if c.end_ms.is_none() {
                result.push(c);
            }
            Ok(())
        })?;
        Ok(result)
    }
    fn stream(
        &self,
        sql: &str,
        values: impl rusqlite::Params,
        from: Option<i64>,
        mut visit: impl FnMut(DockerCoverage) -> Result<()>,
    ) -> Result<()> {
        let mut stmt = self.conn.prepare_cached(sql)?;
        let mut rows = stmt.query(values)?;
        while let Some(r) = rows.next()? {
            // The read lifetime still bounds a streamed read.
            self.check(0)?;
            let c = self.coverage_row(r)?;
            // The resumption rule can close a row before the range.
            if from.is_some_and(|from| c.end_ms.is_some_and(|end| end <= from)) {
                continue;
            }
            visit(c)?;
        }
        Ok(())
    }
    fn coverage_row(&self, r: &rusqlite::Row<'_>) -> Result<DockerCoverage> {
        let mut c = DockerCoverage {
            start_ms: r.get(0)?,
            end_ms: r.get(1)?,
            metric: r.get(2)?,
            reason: r.get(3)?,
            revision: r.get(4)?,
            sampled_ms: r.get(5)?,
            expected_ms: r.get(6)?,
            entity: r.get(7)?,
        };
        if super::super::resumes_on_observation(&c.reason)
            && c.end_ms.is_none()
            && c.entity.is_none()
            && c.metric.is_none()
            && let Some(engine) = self.engine
            && let Some(end) = super::super::resumed_after(self.conn, engine, c.start_ms)?
        {
            c.end_ms = Some(end);
            c.expected_ms = end - c.start_ms;
        }
        Ok(c)
    }
}
