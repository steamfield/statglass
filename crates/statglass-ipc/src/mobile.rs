//! What the iPhone app and its Rust core (`statglass-mobile`) say to each other: the
//! hosts the core runs sessions for, the calls the app makes, the hosts it reads back and
//! the events it is told about. They live here, not in the facade, so the desktop's one
//! specta exporter writes them into the shared TypeScript types (`src-tauri/src/facts.rs`
//! registers them; no desktop command uses them).

use serde::{Deserialize, Serialize};
use statglass_engine::ProcessView;
use statglass_schema::{
    Event, Gap, HostId, HostRecord, JsSafeInt, Module, OsKind, SeriesKey, SeriesSelector, Tier,
};

use crate::error::CommandError;
use crate::history::HistorySeries;
use crate::status::{RemoteConnection, RemoteRoute};
use crate::vitals::HostVitals;

/// What the core starts with. The app's data directory comes from Swift, which owns the
/// file protection.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MobileConfig {
    pub hosts: Vec<MobileHost>,
    pub data: DataPolicy,
}

/// The phone's choices about mobile data, from its settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DataPolicy {
    pub live_on_cellular: bool,
}

/// A host the phone reaches over SSH, as pairing (phase 7) or the debug screen gives it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MobileHost {
    pub id: HostId,
    /// The name shown until the host introduces itself.
    pub name: String,
    pub user: String,
    /// `None`: 22.
    pub port: Option<u16>,
    /// Dial targets in preference order, at most four (`statglass_session::MAX_TARGETS`).
    pub targets: Vec<MobileTarget>,
    /// The host keys pairing pinned; at least one.
    pub host_keys: Vec<MobileHostKey>,
    pub command: MobileCommand,
    #[serde(default)]
    pub removed_by_controller: bool,
}

/// One way to reach a host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MobileTarget {
    pub route: RemoteRoute,
    /// A DNS name, `.local` name or address literal; resolved by the system resolver.
    pub host: String,
}

/// A pinned host key, as `ssh-keygen -l` prints it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MobileHostKey {
    /// For example `ssh-ed25519`.
    pub algorithm: String,
    /// `SHA256:` followed by the unpadded base64 fingerprint.
    pub sha256: String,
}

/// What the session asks the host to run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MobileCommand {
    /// A paired, forced-command key: the session sends the bare `serve` token.
    Restricted,
    /// A full key on a Mac: the bundled helper at `path` (empty: the per-user install).
    MacHelper { path: String },
    /// A full key on a Linux host running the headless agent.
    Agent {
        bin: String,
        system: bool,
        socket: Option<String>,
    },
}

/// One call from the app. `call(method, args_json)` receives the tag and the content
/// separately; the facade reassembles them into this. Each variant names its result.
#[derive(Clone, Debug, PartialEq, Deserialize, specta::Type)]
#[serde(tag = "method", content = "args", rename_all = "snake_case")]
pub enum MobileCall {
    /// `BuildInfo`: the core's version and protocol range (also `version()`).
    BuildInfo,
    /// `null`. Replaces the hosts the core runs sessions for.
    SetHosts { hosts: Vec<MobileHost> },
    /// `null`. Applies the data policy to every source.
    SetDataPolicy(DataPolicy),
    /// `string`: the `authorized_keys` line for this phone's key.
    AuthorizedKeyLine { comment: String },
    /// `PairingPreview`.
    PreviewPairing { text: String },
    /// `PairedHost`.
    Pair {
        text: String,
        device_name: String,
        model: String,
    },
    /// `null`. Removes a paired host.
    RemoveHost { host: HostId },
    /// `PairingState`.
    PairingState,
    /// `BundleReconcile`.
    DecodeBundle { text: String },
    /// `null`. Persists the selected hosts.
    AddHandoverHosts { hosts: Vec<OfferedHost> },
    /// `null`. Replaces screen demand for all hosts.
    SetDemand { demand: Vec<HostDemand> },
    /// `HostRecord[]`, in the order the hosts were set.
    ListHosts,
    /// `MobileRemoteHost[]`, same order.
    ListRemoteHosts,
    /// `HostRecord`.
    GetHost { host: HostId },
    /// `Capabilities`.
    GetCapabilities { host: HostId },
    /// `HostVitals`.
    HostVitals { host: HostId },
    /// `null`. Dials a host now.
    RetryRemoteHost { host: HostId },
    /// `SubscriptionInfo`. Messages arrive through `CoreEvents::live` tagged `stream`.
    SubscribeLive(MobileLiveRequest),
    /// `null`. Ends a stream; unknown streams are ignored.
    UnsubscribeLive { stream: u32 },
    /// `HostHistoryPage`.
    HostHistory(HostHistoryRequest),
    /// `HostAddressesInfo`.
    NetworkAddresses { host: HostId },
    /// `null`. Replaces a stream's process interest.
    SetProcessInterest {
        host: HostId,
        interested: bool,
        view: Option<ProcessView>,
        stream: Option<u32>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct PairingPreview {
    pub host_id: HostId,
    pub name: String,
    pub os: String,
    pub user: String,
    pub targets: Vec<MobileTarget>,
    pub code: String,
    #[specta(type = JsSafeInt)]
    pub expires_ms: i64,
    pub can_hand_over: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct PairedHost {
    pub id: HostId,
    pub name: String,
    pub offered: Vec<OfferedHost>,
    pub unavailable: Vec<UnavailableHostInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct OfferedHost {
    pub id: HostId,
    pub name: String,
    pub os: String,
    pub user: String,
    pub port: Option<u16>,
    pub targets: Vec<MobileTarget>,
    pub host_keys: Vec<MobileHostKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct UnavailableHostInfo {
    pub id: HostId,
    pub name: String,
    pub reason: HandoverReasonInfo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum HandoverReasonInfo {
    ProxyJump,
    ProxyCommand,
    LanLiteral,
    NoHostKey,
    Unresolvable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct BundleReconcile {
    pub from: HostId,
    pub new: Vec<OfferedHost>,
    pub removed: Vec<HostId>,
    pub changed: Vec<HostId>,
    pub unavailable: Vec<UnavailableHostInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct PairingState {
    pub hosts: u32,
    /// The phone was restored and needs to pair again.
    pub key_changed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, specta::Type)]
pub struct HostDemand {
    pub host: HostId,
    pub level: DemandLevel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DemandLevel {
    /// A host summary every five seconds.
    Compact,
    /// A live frame every tick.
    Full,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, specta::Type)]
pub struct HostHistoryRequest {
    pub host: HostId,
    pub series: Vec<SeriesSelector>,
    #[specta(type = JsSafeInt)]
    pub from_ms: i64,
    /// `None` means ending now on the host.
    #[specta(type = Option<JsSafeInt>)]
    pub to_ms: Option<i64>,
    pub max_points: u32,
    pub events_for: Option<Module>,
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct HostHistoryPage {
    pub tier: Tier,
    #[specta(type = JsSafeInt)]
    pub bucket_ms: i64,
    #[specta(type = JsSafeInt)]
    pub complete_to_ms: i64,
    pub series: Vec<HistorySeries>,
    pub gaps: Vec<Gap>,
    pub events: Vec<Event>,
    pub stats: Vec<SeriesHistoryStats>,
    pub clamped: Vec<HistoryClamp>,
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct SeriesHistoryStats {
    pub key: SeriesKey,
    pub avg: Option<f32>,
    pub peak: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum HistoryClamp {
    Points,
    Series,
    Events,
    Bytes,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct HostAddressesInfo {
    pub interface: Option<String>,
    pub link_mbps: Option<u32>,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub public_ip: PublicIpInfo,
    #[specta(type = JsSafeInt)]
    pub as_of_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum PublicIpInfo {
    Known { ip: String },
    Pending,
    Unavailable { reason: String },
    Unknown,
}

/// A live stream the app opens. The app picks `stream`, unique among its open streams,
/// so it can route messages before the call returns.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, specta::Type)]
pub struct MobileLiveRequest {
    pub host: HostId,
    pub stream: u32,
    /// Ring history to send first, ms; `None`: the desktop default (60 s).
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub backfill_ms: Option<i64>,
    /// Only these series; `None`: every series.
    pub series: Option<Vec<statglass_schema::SeriesSelector>>,
    /// At most one frame per this many ms; `None`: every tick.
    pub min_period_ms: Option<u32>,
}

/// A remote host's state as the phone shows it: the platform-neutral part of the
/// desktop's `RemoteHostStatus`, with nothing about remote runs or agent updates.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct MobileRemoteHost {
    pub id: HostId,
    pub name: String,
    pub os: OsKind,
    pub targets: Vec<MobileTarget>,
    pub connection: RemoteConnection,
    pub open_error: Option<CommandError>,
    /// The live data level the core applies after evaluating data policy.
    pub demand: Option<DemandLevel>,
    /// Host clock, ms.
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub last_seen_ms: Option<i64>,
    /// End of the newest mirrored bucket on disk (host clock).
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub synced_through_ms: Option<i64>,
    /// The phone's wall-clock time of the next automatic attempt.
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub next_attempt_ms: Option<i64>,
    pub attempt: u32,
    pub dialing: bool,
    pub waiting_for_network: bool,
    #[specta(type = Option<statglass_schema::JsSafeInt>)]
    pub clock_offset_ms: Option<i64>,
    pub vitals: HostVitals,
    /// The host's `Hello.app_version`, kept after it disconnects.
    pub agent_version: Option<String>,
    /// The id the host answered with when it is not the paired one.
    pub identity_changed: Option<HostId>,
}

/// Something the core tells the app outside a live stream, through `CoreEvents::event`.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MobileEvent {
    /// Every host record, in order, when one changes.
    HostsChanged { hosts: Vec<HostRecord> },
    /// A remote host's status changed; read `list_remote_hosts` again.
    RemoteHostsChanged,
}
