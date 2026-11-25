//! Remote queries (D-117): what `Message::Request` asks and `Message::Reply` answers. A
//! one-way door like the rest of the wire: variants and fields are added, never renamed.
//!
//! A query or answer kind this build does not know decodes as `Unknown`, so a host asked
//! something new answers `Answer::Error { code: Unsupported }` and the session goes on.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use statglass_schema::disk_space::{
    SpaceFile, SpaceReport, SpaceScanStatus, SpaceSubtree, SpaceTarget, SpaceVolume,
};
use statglass_schema::durable_usage::{
    HistoricalUsageReply, HistoricalUsageRequest, UsageProcessReply, UsageProcessRequest,
};
use statglass_schema::usage::{UsageByApp, UsageKey};
use statglass_schema::{Gap, Module, SeriesKey, SeriesSelector, Tier};

use crate::{ErrorCode, WireEvent};

/// Adjacently tagged like [`crate::Message`]: `{"q": "UsageByApp", "a": {...}}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "q", content = "a")]
pub enum Query {
    /// Per-app use over a range, from the host's in-memory usage ring: the last hour.
    UsageByApp {
        from_ms: i64,
        to_ms: i64,
        by: UsageKey,
        limit: u32,
    },
    HistoricalUsage(HistoricalUsageRequest),
    UsageProcesses(UsageProcessRequest),
    /// The host's space report service (D-114), one call per `SpaceService` method.
    SpaceVolumes,
    SpaceStart {
        volume: String,
        include: Vec<String>,
    },
    SpaceStatus,
    SpaceCancel,
    /// Cancels and drops the scan this session started, if it did (the controller's
    /// dashboard closed).
    SpaceClear,
    SpaceReport,
    SpaceSubtree {
        report: u32,
        node: Option<u32>,
    },
    SpaceLargestFiles {
        report: u32,
    },
    SpacePath {
        report: u32,
        target: SpaceTarget,
    },
    History(HistoryQuery),
    NetworkAddresses,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "a", content = "v")]
pub enum Answer {
    UsageByApp(UsageByApp),
    HistoricalUsage(HistoricalUsageReply),
    UsageProcesses(UsageProcessReply),
    SpaceVolumes(Vec<SpaceVolume>),
    SpaceStatus(SpaceScanStatus),
    SpaceReport(Option<SpaceReport>),
    SpaceSubtree(SpaceSubtree),
    SpaceFiles(Vec<SpaceFile>),
    SpacePath(String),
    History(HistoryAnswer),
    NetworkAddresses(HostAddresses),
    /// Done, with nothing to return (`SpaceCancel`, `SpaceClear`).
    Done,
    /// The query failed on the host; `message` is for the user.
    Error {
        code: ErrorCode,
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryQuery {
    pub series: Vec<SeriesSelector>,
    pub from_ms: i64,
    /// `None` means ending now, on the host's clock.
    pub to_ms: Option<i64>,
    pub max_points: u32,
    pub events_for: Option<Module>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistoryAnswer {
    pub tier: Tier,
    pub bucket_ms: i64,
    pub complete_to_ms: i64,
    pub series: Vec<WireHistorySeries>,
    pub gaps: Vec<Gap>,
    pub events: Vec<WireEvent>,
    pub stats: Vec<WireSeriesStats>,
    #[serde(deserialize_with = "history_clamps")]
    pub clamped: Vec<HistoryClamp>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireHistorySeries {
    pub key: SeriesKey,
    pub points: Vec<WireHistoryPoint>,
    pub hold_ms: i64,
}

/// One measured slot, encoded as `(t, avg, min, max)`.
pub type WireHistoryPoint = (i64, f32, f32, f32);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireSeriesStats {
    pub key: SeriesKey,
    pub avg: Option<f32>,
    pub peak: Option<f32>,
    /// Time in the range with a reading, outside the gaps that apply to the metric.
    /// Absent from hosts that predate range totals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured_ms: Option<i64>,
    /// `avg` times the measured seconds: bytes for a bytes-per-second series. `None`
    /// when nothing was measured or the host predates range totals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integral: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum HistoryClamp {
    Points,
    Series,
    Events,
    Bytes,
    Unknown,
}

fn history_clamps<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<HistoryClamp>, D::Error> {
    #[derive(Deserialize)]
    #[serde(transparent)]
    struct Clamp(#[serde(deserialize_with = "lenient")] HistoryClamp);

    Vec::<Clamp>::deserialize(deserializer).map(|clamps| clamps.into_iter().map(|c| c.0).collect())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostAddresses {
    pub interface: Option<String>,
    pub link_mbps: Option<u32>,
    #[serde(default)]
    pub ipv4: Vec<Ipv4Addr>,
    #[serde(default)]
    pub ipv6: Vec<Ipv6Addr>,
    #[serde(deserialize_with = "lenient")]
    pub public_ip: PublicIp,
    pub as_of_ms: i64,
}

impl HostAddresses {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            interface: None,
            link_mbps: None,
            ipv4: Vec::new(),
            ipv6: Vec::new(),
            public_ip: PublicIp::Unavailable {
                reason: reason.into(),
            },
            as_of_ms: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum PublicIp {
    Known {
        // Serde can buffer `detail` before it reads `state`. Text decodes the same
        // way from either the wire or the buffered content.
        #[serde(with = "ip_text")]
        ip: IpAddr,
    },
    Pending,
    Unavailable {
        reason: String,
    },
    Unknown,
}

mod ip_text {
    use serde::{Deserialize, Deserializer, Serializer};
    use std::net::IpAddr;

    pub(super) fn serialize<S: Serializer>(ip: &IpAddr, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(ip)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<IpAddr, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// An adjacently tagged enum with an `Unknown` variant for kinds it cannot decode.
pub(crate) trait Tagged: serde::de::DeserializeOwned {
    fn unknown() -> Self;
}

impl Tagged for Query {
    fn unknown() -> Self {
        Self::Unknown
    }
}

impl Tagged for Answer {
    fn unknown() -> Self {
        Self::Unknown
    }
}

impl Tagged for HistoryClamp {
    fn unknown() -> Self {
        Self::Unknown
    }
}

impl Tagged for PublicIp {
    fn unknown() -> Self {
        Self::Unknown
    }
}

/// Decodes `T`, or `T::unknown()` when it does not decode: a kind this build does not
/// know, or a known kind whose body changed shape. `#[serde(other)]` alone accepts an
/// unknown tag only without content (see [`crate::decode_message`]). The request id sits
/// outside the query, so a call that cannot be read fails alone and the session goes on.
pub(crate) fn lenient<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Tagged,
{
    let value = ciborium::Value::deserialize(d)?;
    Ok(value.deserialized::<T>().unwrap_or_else(|_| T::unknown()))
}
