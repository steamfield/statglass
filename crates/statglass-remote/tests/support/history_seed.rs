use std::{path::Path, sync::Arc};

use statglass_engine::HistoryStore;
use statglass_schema::SeriesKey;

pub fn seed_by_retention(dir: &Path, _series: &[SeriesKey], _now_ms: i64) -> Arc<HistoryStore> {
    Arc::new(HistoryStore::open(dir))
}
