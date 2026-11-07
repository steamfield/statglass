//! Coverage reads. Rows stream to a visitor in start order without a count cap, so one
//! flapping container's episodes never fail a read; the caller folds what it keeps.
use super::*;

/// The columns every coverage read selects, joined to the container's external ID.
const COLUMNS: &str = "SELECT c.start_ms,c.end_ms,c.metric,c.reason,c.revision,c.sampled_ms,c.expected_ms,e.external_id";
/// What every coverage read joins its rows `c` to.
const JOIN: &str = "c LEFT JOIN docker_entities e ON e.id=c.entity_id";
/// At most this many event-coverage rows are returned; events-kind rows are a handful
/// per reconnect, so the bound only keeps a pathological store from growing a page.
const MAX_EVENT_ROWS: usize = 10_000;
/// The engine-wide scope. The partial `docker_coverage_engine_end` index holds only
/// these rows, so an engine-wide read never walks the containers' rows.
const ENGINE: &str = "engine_id=?1 AND entity_id IS NULL";

/// The rows of each `scope` that overlap `(?2, ?3)`, each from its scope's end index:
/// closed rows ending after `?2`, and open rows. Each half is its own indexed search: an
/// `OR`, or an indexable start bound, makes SQLite walk the start index (the scope's
/// whole history), so `+start_ms` keeps the start bound a filter. Callers order by start.
fn overlapping(scopes: &[&str]) -> String {
    let halves = scopes
        .iter()
        .flat_map(|scope| {
            ["end_ms>?2", "end_ms IS NULL"].map(|end| {
                format!("SELECT * FROM docker_coverage WHERE {scope} AND {end} AND +start_ms<?3")
            })
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    format!("{COLUMNS} FROM ({halves}) {JOIN}")
}
fn engine_sql() -> String {
    format!("{} ORDER BY c.start_ms,c.id", overlapping(&[ENGINE]))
}
fn entity_sql() -> String {
    format!(
        "{} ORDER BY c.start_ms,c.id",
        overlapping(&["entity_id=?1"])
    )
}
/// Placeholders: `?4` is the container (or none), and the `reasons` start at `?5`.
fn event_sql(reasons: usize) -> String {
    let list = (0..reasons)
        .map(|i| format!("?{}", i + 5))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{} WHERE c.reason IN ({list}) ORDER BY c.start_ms,c.id",
        overlapping(&[ENGINE, "entity_id=?4"])
    )
}

impl DockerReadSnapshot<'_> {
    /// Each engine-wide row overlapping `[start, end)`, in start order.
    pub fn engine_coverage(
        &self,
        start: i64,
        end: i64,
        visit: impl FnMut(DockerCoverage) -> Result<()>,
    ) -> Result<()> {
        bounds(start, end, 900_000)?;
        self.stream(
            &engine_sql(),
            params![self.engine, start, end],
            Some(start),
            visit,
        )
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
        self.stream(&entity_sql(), params![id, start, end], Some(start), visit)
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
        let sql = event_sql(reasons.len());
        let mut values: Vec<&dyn rusqlite::ToSql> = vec![&self.engine, &start, &end, &entity];
        values.extend(reasons.iter().map(|r| r as &dyn rusqlite::ToSql));
        let mut out = Vec::new();
        let mut bytes = 0;
        self.stream(&sql, values.as_slice(), Some(start), |c| {
            // Only the rows kept count against the byte bound; `stream` checks the
            // read's lifetime for every row.
            if out.len() < MAX_EVENT_ROWS {
                bytes += c.reason.len() + 256;
                self.check(bytes)?;
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
            "{COLUMNS} FROM docker_coverage {JOIN} WHERE c.engine_id=?1 AND c.end_ms IS NULL AND c.metric IS NULL ORDER BY c.start_ms,c.id LIMIT 10001"
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Each plan step's detail for `sql` on a freshly migrated file.
    fn plan(sql: &str) -> Vec<String> {
        let dir = crate::test_dir("coverage-plan");
        let (conn, _) = crate::db::open_writer(&dir.path().join("h.sqlite"), 0).unwrap();
        // The engine-wide end index holds no container's rows.
        let partial: bool = conn
            .query_row(
                "SELECT partial FROM pragma_index_list('docker_coverage') WHERE name='docker_coverage_engine_end'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(partial);
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        // Unbound placeholders plan as NULL.
        let mut rows = stmt.raw_query();
        let mut steps = Vec::new();
        while let Some(r) = rows.next().unwrap() {
            steps.push(r.get::<_, String>(3).unwrap());
        }
        steps
    }
    /// Every coverage-table step of `sql`'s plan searches one of `indexes` by the end
    /// bound; none walks a scope's history by start.
    fn assert_searches(sql: &str, indexes: &[&str]) -> Vec<String> {
        let plan = plan(sql);
        let searches: Vec<_> = plan
            .iter()
            .filter(|step| step.contains("docker_coverage"))
            .collect();
        assert!(!searches.is_empty(), "{plan:#?}");
        for step in searches {
            assert!(
                step.starts_with("SEARCH docker_coverage USING INDEX")
                    && indexes.iter().any(|index| step.contains(index))
                    && step.contains("end_ms"),
                "{plan:#?}"
            );
        }
        plan
    }

    #[test]
    fn every_coverage_read_searches_its_scope_end_index() {
        let plans = [
            assert_searches(&engine_sql(), &["docker_coverage_engine_end "]),
            assert_searches(&entity_sql(), &["docker_coverage_entity_end "]),
            assert_searches(
                &event_sql(3),
                &["docker_coverage_engine_end ", "docker_coverage_entity_end "],
            ),
        ];
        // `--nocapture` prints them for review.
        println!("{plans:#?}");
    }
}
