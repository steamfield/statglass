//! Rank bounded container comparisons from a consistent reader snapshot.
use super::coverage::{EngineCoverage, live_coverage};
use super::*;
impl DockerRecorder {
    pub fn comparison(
        &self,
        q: &api::DockerComparisonRequest,
    ) -> Result<api::DockerComparisonPage, DockerServiceError> {
        TimeRange::new(q.from_ms, q.to_ms, db::MAX_RANGE_MS)?;
        if q.max_points == 0
            || q.max_points > 360
            || q.selected.as_ref().is_some_and(|ids| ids.len() > 6)
            || q.engine_id.len() > 256
            || q.project.as_ref().is_some_and(|p| p.len() > 256)
            || q.selected
                .as_ref()
                .is_some_and(|ids| ids.iter().any(|id| id.len() > 256))
        {
            return Err(DockerServiceError::InvalidRequest(
                "Comparison request exceeds six-series or 360-point bounds",
            ));
        }
        let (attached, coord) = self.context();
        let mut reader = attached
            .as_ref()
            .map(|a| Reader::open(&a.path))
            .transpose()?;
        let guard = coord.lock_ok();
        let snapshot = reader
            .as_mut()
            .map(|r| r.docker_snapshot(self.host, &q.engine_id))
            .transpose()?;
        let mut s = self.state.lock_ok();
        drain(&mut s);
        let mut read = self.comparison_read(q, &mut s)?;
        drop(s);
        drop(guard);
        let ranked = self.rank_comparison(q, snapshot.as_ref(), &mut read)?;
        let page = self.comparison_page(q, snapshot.as_ref(), &read, ranked)?;
        if !read.pin.valid() {
            return Err(DockerServiceError::SnapshotExpired(
                "Comparison response expired or exceeded byte bound",
            ));
        }
        if serde_json::to_vec(&page)?.len() > db::MAX_QUERY_BYTES {
            return Err(DockerServiceError::ResourceLimit(
                "Comparison response expired or exceeded byte bound",
            ));
        }
        drop(read.ring);
        drop(read.pin);
        Ok(page)
    }
}
fn comparison_value(
    row: &api::DockerRankedContainer,
    metric: api::DockerComparisonMetric,
) -> Option<f64> {
    match metric {
        api::DockerComparisonMetric::Cpu => row.peak_cpu_pct,
        api::DockerComparisonMetric::Memory => row.peak_working_set_bytes,
    }
}
fn rank_order(
    a: &api::DockerRankedContainer,
    b: &api::DockerRankedContainer,
    metric: api::DockerComparisonMetric,
) -> std::cmp::Ordering {
    match (comparison_value(a, metric), comparison_value(b, metric)) {
        (Some(a), Some(b)) => b.total_cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
    .then_with(|| a.container.id.cmp(&b.container.id))
}

struct ComparisonRead<'a> {
    ring: Vec<Arc<db::DockerBucket>>,
    facts: Vec<db::DockerEntity>,
    metadata: Vec<db::DockerEntity>,
    coverage: Vec<api::DockerCoverage>,
    pin: ReadPin<'a>,
}
struct RankedComparison {
    ranking: Vec<api::DockerRankedContainer>,
    /// The kept candidates' series, with their own records and how many there were.
    pages: BTreeMap<String, (api::DockerContainerSeries, Vec<api::DockerCoverage>, u32)>,
    engine: EngineCoverage,
}

impl DockerRecorder {
    fn comparison_read(
        &self,
        q: &api::DockerComparisonRequest,
        s: &mut State,
    ) -> Result<ComparisonRead<'_>, DockerServiceError> {
        let from = floor_to(q.from_ms, 900_000);
        let ring: Vec<_> = s
            .entries
            .iter()
            .filter(|((engine, id, time), _)| {
                engine == &q.engine_id && !id.is_empty() && *time >= from && *time < q.to_ms
            })
            .map(|(_, entry)| Arc::clone(&entry.bucket))
            .collect();
        let facts: Vec<_> = s
            .facts
            .iter()
            .filter(|((engine, id), _)| engine == &q.engine_id && !id.is_empty())
            .map(|(_, fact)| fact.clone())
            .collect();
        let metadata: Vec<_> = s
            .metadata_history
            .iter()
            .filter(|(engine, _)| engine == &q.engine_id)
            .map(|(_, fact)| fact.clone())
            .collect();
        let coverage = live_coverage(s, &q.engine_id);
        // Payloads are immutable Arcs already charged to the ring. Register their
        // shared ownership so replacing/evicting a live revision transfers its
        // charge to the read, instead of charging every payload twice up front.
        for bucket in &ring {
            s.shared_read_buckets
                .entry(Arc::as_ptr(bucket) as usize)
                .or_insert_with(|| SharedReadBucket {
                    key: (q.engine_id.clone(), bucket.entity.clone(), bucket.bucket_ms),
                    bucket: Arc::downgrade(bucket),
                    bytes: bucket_bytes(bucket),
                });
        }
        recount_aux(s);
        let held = ring.len() * std::mem::size_of::<Arc<db::DockerBucket>>()
            + facts
                .iter()
                .chain(&metadata)
                .map(|m| m.extras.len() + 512)
                .sum::<usize>()
            + coverage.len() * 512;
        if held > db::MAX_QUERY_BYTES
            || s.bytes
                .saturating_add(s.aux_bytes)
                .saturating_add(s.reader_bytes)
                .saturating_add(held)
                > RING_BYTES
        {
            return Err(DockerServiceError::ResourceLimit(
                "Comparison snapshot byte bound exceeded",
            ));
        }
        s.reader_bytes += held;
        let pin = ReadPin {
            state: &self.state,
            bytes: held,
            generation: s.generation,
            reset_epoch: s.reset_epoch,
            started: Instant::now(),
        };

        Ok(ComparisonRead {
            ring,
            facts,
            metadata,
            coverage,
            pin,
        })
    }

    fn rank_comparison(
        &self,
        q: &api::DockerComparisonRequest,
        snapshot: Option<&db::DockerReadSnapshot<'_>>,
        read: &mut ComparisonRead<'_>,
    ) -> Result<RankedComparison, DockerServiceError> {
        let facts = std::mem::take(&mut read.facts);
        let candidates = comparison_candidates(q, snapshot, facts, &read.ring)?;
        let mut ranking = Vec::new();
        let mut pages = BTreeMap::new();
        // Engine-wide records, read once; each candidate's page reads only its own.
        let engine = EngineCoverage::read(
            snapshot,
            &read.coverage,
            floor_to(q.from_ms, 900_000),
            q.to_ms,
        )?;
        for (id, fact) in candidates {
            if q.project
                .as_ref()
                .is_some_and(|project| fact.project.as_deref().unwrap_or("") != project)
            {
                continue;
            }
            let container: api::DockerContainer =
                serde_json::from_slice(&fact.extras).map_err(|source| {
                    DockerServiceError::Metadata {
                        message: "Comparison metadata is unavailable",
                        source,
                    }
                })?;
            let page = self.comparison_history(q, snapshot, read, &engine, &id)?;
            if page.points.is_empty() {
                continue;
            }
            let (peak_cpu_pct, avg_cpu_pct, cpu_measured_ms) = weighted_summary(&page.points, true);
            let (peak_working_set_bytes, avg_working_set_bytes, memory_measured_ms) =
                weighted_summary(&page.points, false);
            let last_lifecycle = page.metadata.last().map(|metadata| metadata.lifecycle);
            let own: Vec<_> = page
                .coverage
                .into_iter()
                .filter(|c| c.container_id.as_deref() == Some(id.as_str()))
                .collect();
            let own_total = page
                .coverage_total
                .saturating_sub(u32::try_from(engine.total).unwrap_or(u32::MAX));
            let selected_weight = match q.metric {
                api::DockerComparisonMetric::Cpu => cpu_measured_ms,
                api::DockerComparisonMetric::Memory => memory_measured_ms,
            };
            if cpu_measured_ms == 0 && memory_measured_ms == 0 {
                continue;
            }
            ranking.push(api::DockerRankedContainer {
                last_lifecycle,
                container: container.clone(),
                peak_cpu_pct,
                avg_cpu_pct,
                cpu_measured_ms,
                peak_working_set_bytes,
                avg_working_set_bytes,
                memory_measured_ms,
            });
            if selected_weight > 0
                && q.selected
                    .as_ref()
                    .is_none_or(|selected| selected.contains(&id))
            {
                pages.insert(
                    id,
                    (
                        api::DockerContainerSeries {
                            container,
                            points: page.points,
                        },
                        own,
                        own_total,
                    ),
                );
            }
            // Only six point arrays may survive a candidate pass; rankings keep
            // scalar weighted summaries, not every container's chart payload.
            ranking.sort_by(|a, b| rank_order(a, b, q.metric));
            if q.selected.is_none() {
                let keep: BTreeSet<_> = ranking
                    .iter()
                    .filter(|r| comparison_value(r, q.metric).is_some())
                    .take(6)
                    .map(|r| r.container.id.as_str())
                    .collect();
                pages.retain(|id, _| keep.contains(id.as_str()));
            }
            ranking.truncate(500);
            if !read.pin.valid() {
                return Err(DockerServiceError::SnapshotExpired(
                    "Comparison snapshot expired or was reset",
                ));
            }
        }
        Ok(RankedComparison {
            ranking,
            pages,
            engine,
        })
    }

    fn comparison_history(
        &self,
        q: &api::DockerComparisonRequest,
        snapshot: Option<&db::DockerReadSnapshot<'_>>,
        read: &ComparisonRead<'_>,
        engine: &EngineCoverage,
        id: &str,
    ) -> Result<api::DockerHistoryPage, DockerServiceError> {
        let own_ring: Vec<_> = read
            .ring
            .iter()
            .filter(|b| b.entity == id)
            .cloned()
            .collect();
        let page = self.history_page(
            &api::DockerHistoryRequest {
                engine_id: q.engine_id.clone(),
                container_id: Some(id.to_owned()),
                from_ms: q.from_ms,
                to_ms: q.to_ms,
                max_points: q.max_points,
            },
            snapshot,
            &own_ring,
            read.metadata
                .iter()
                .filter(|m| m.external_id == id)
                .cloned()
                .collect(),
            (&read.coverage, engine),
            read.pin.generation,
        )?;

        Ok(page)
    }

    fn comparison_page(
        &self,
        q: &api::DockerComparisonRequest,
        snapshot: Option<&db::DockerReadSnapshot<'_>>,
        read: &ComparisonRead<'_>,
        ranked: RankedComparison,
    ) -> Result<api::DockerComparisonPage, DockerServiceError> {
        let RankedComparison {
            mut ranking,
            mut pages,
            engine,
        } = ranked;
        ranking.sort_by(|a, b| rank_order(a, b, q.metric));
        ranking.truncate(500);
        let selected = q.selected.clone().unwrap_or_else(|| {
            let eligible = ranking
                .iter()
                .filter(|r| comparison_value(r, q.metric).is_some())
                .count();
            ranking
                .iter()
                .filter(|r| comparison_value(r, q.metric).is_some())
                .take(if eligible <= 6 { 6 } else { 5 })
                .map(|r| r.container.id.clone())
                .collect()
        });
        // The banner and History details list engine-wide records and the charted
        // containers' own; every candidate's points were masked by all of its records.
        let mut coverage = engine.listed;
        let mut coverage_total = engine.total;
        let mut series = Vec::new();
        for id in selected {
            if let Some((page, own, own_total)) = pages.remove(&id) {
                series.push(page);
                coverage.extend(own);
                coverage_total += own_total as usize;
            }
        }
        coverage.retain(|c| {
            c.container_id.as_deref() != Some("")
                && c.start_ms < q.to_ms
                && c.end_ms.is_none_or(|end| end > q.from_ms)
        });
        let mut persistence = self.status();
        let durable_start = snapshot
            .as_ref()
            .map(|snap| snap.retained_range())
            .transpose()?
            .flatten()
            .map(|(from, _)| from);
        persistence.retained_from_ms = durable_start
            .into_iter()
            .chain(read.ring.iter().map(|b| b.bucket_ms))
            .min();
        let page = api::DockerComparisonPage {
            generation: read.pin.generation,
            ranking,
            series,
            coverage,
            coverage_total: u32::try_from(coverage_total).unwrap_or(u32::MAX),
            persistence,
        };
        Ok(page)
    }
}

fn comparison_candidates(
    q: &api::DockerComparisonRequest,
    snapshot: Option<&db::DockerReadSnapshot<'_>>,
    facts: Vec<db::DockerEntity>,
    ring: &[Arc<db::DockerBucket>],
) -> Result<BTreeMap<String, db::DockerEntity>, DockerServiceError> {
    let mut candidates: BTreeMap<String, db::DockerEntity> = snapshot
        .as_ref()
        .map(|snap| snap.comparison_candidates(q.from_ms, q.to_ms))
        .transpose()?
        .unwrap_or_default()
        .into_iter()
        .map(|fact| (fact.external_id.clone(), fact))
        .collect();
    for fact in facts {
        if (candidates.contains_key(&fact.external_id)
            || ring
                .iter()
                .any(|b| b.entity == fact.external_id && b.bucket_ms >= q.from_ms))
            && candidates.get(&fact.external_id).is_none_or(|old| {
                (fact.effective_ms, fact.revision) >= (old.effective_ms, old.revision)
            })
        {
            candidates.insert(fact.external_id.clone(), fact);
        }
    }
    Ok(candidates)
}

fn weighted_summary(
    points: &[api::DockerHistoryPoint],
    cpu: bool,
) -> (Option<f64>, Option<f64>, u64) {
    let mut peak: Option<f64> = None;
    let mut sum = 0.;
    let mut weight = 0_u64;
    for p in points {
        let (average, maximum, measured) = if cpu {
            (p.metrics.cpu_pct, p.peak.cpu_pct, p.cpu_measured_ms)
        } else {
            (
                p.metrics.working_set_bytes,
                p.peak.working_set_bytes,
                p.memory_measured_ms,
            )
        };
        if let (Some(avg), Some(max)) = (average, maximum)
            && measured > 0
        {
            sum += avg * f64::from(measured);
            weight += u64::from(measured);
            peak = Some(peak.map_or(max, |old| old.max(max)));
        }
    }
    (peak, (weight > 0).then(|| sum / weight as f64), weight)
}
