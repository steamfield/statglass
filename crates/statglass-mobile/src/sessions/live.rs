use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use statglass_engine::{LiveHub, Source};
use statglass_ipc::error::CommandError;
use statglass_ipc::live::{
    LiveFeed, LiveMsg, LiveRegistry, LiveRequest, LiveSink, SubscriptionInfo,
};
use statglass_ipc::mobile::MobileLiveRequest;
use statglass_schema::{Capabilities, HostId, lock::LockExt};

use crate::ffi::CoreEvents;

use super::{callback, host::HostEntry, internal, invalid};

impl LiveFeed for HostEntry {
    fn host(&self) -> HostId {
        self.config.id
    }

    fn is_local(&self) -> bool {
        false
    }

    fn hub(&self) -> &LiveHub {
        &self.hub
    }

    fn capabilities(&self) -> Capabilities {
        self.source.capabilities()
    }

    fn set_process_interest(&self, period_ms: Option<u32>) {
        if let Some(handle) = self.handle.lock_ok().as_ref() {
            handle.control().set_process_interest(period_ms);
        }
    }

    fn set_network_process_interest(&self, interested: bool) {
        if let Some(handle) = self.handle.lock_ok().as_ref() {
            handle.control().set_network_process_interest(interested);
        }
    }

    fn set_gpu_process_interest(&self, interested: bool) {
        if let Some(handle) = self.handle.lock_ok().as_ref() {
            handle.control().set_gpu_process_interest(interested);
        }
    }

    fn set_port_process_interest(&self, interested: bool) {
        if let Some(handle) = self.handle.lock_ok().as_ref() {
            handle.control().set_port_process_interest(interested);
        }
    }

    fn set_detail_interest(&self, interested: bool) {
        if let Some(handle) = self.handle.lock_ok().as_ref() {
            handle.control().set_detail_interest(interested);
        }
    }
}

#[derive(Default)]
pub(super) struct Live {
    registry: LiveRegistry,
    streams: Mutex<Streams>,
}

#[derive(Default)]
struct Streams {
    active: HashMap<u32, Stream>,
    next: u64,
}

struct Stream {
    host: HostId,
    // A fresh label prevents cleanup from an ended stream closing a reused id.
    label: String,
    order: u64,
    open: bool,
    sending: bool,
}

impl Live {
    pub(super) fn register(&self, entry: Arc<HostEntry>) {
        self.registry.replace_host(entry);
    }

    pub(super) fn remove_host(&self, host: HostId) {
        let mut streams = self.streams.lock_ok();
        self.registry.remove_host(host);
        streams.active.retain(|_, stream| {
            if stream.host == host && stream.open {
                stream.open = false;
                self.registry.window_closed(&stream.label);
            }
            stream.open || stream.sending
        });
    }

    pub(super) fn open_host(&self) -> Option<HostId> {
        self.streams
            .lock_ok()
            .active
            .values()
            .filter(|s| s.open)
            .max_by_key(|s| s.order)
            .map(|s| s.host)
    }

    pub(super) fn subscribe(
        self: &Arc<Self>,
        entry: Arc<HostEntry>,
        request: MobileLiveRequest,
        events: Arc<dyn CoreEvents>,
    ) -> Result<SubscriptionInfo, CommandError> {
        let stream = request.stream;
        let label = {
            let mut streams = self.streams.lock_ok();
            if streams.active.contains_key(&stream) {
                return Err(invalid(format!("live stream {stream} is still in use")));
            }
            let order = streams.next;
            streams.next += 1;
            let label = format!("mobile-{order}");
            streams.active.insert(
                stream,
                Stream {
                    host: request.host,
                    label: label.clone(),
                    order,
                    open: true,
                    sending: false,
                },
            );
            self.registry.window_visible(&label, true);
            label
        };
        let sink = Arc::new(EventSink {
            stream,
            label: label.clone(),
            live: Arc::downgrade(self),
            events,
        });
        let options = LiveRequest {
            backfill_ms: request
                .backfill_ms
                .unwrap_or(statglass_ipc::live::DEFAULT_BACKFILL_MS),
            series: request.series,
            min_period_ms: request.min_period_ms.unwrap_or_default(),
        };
        let result = self
            .registry
            .subscribe(&label, entry.clone(), sink, options);
        let mut streams = self.streams.lock_ok();
        let still_open = streams
            .active
            .get(&stream)
            .is_some_and(|s| s.label == label && s.open);
        if let Some(info) = result
            && still_open
        {
            return Ok(info);
        }
        // Unsubscribe can win before the registry begins setup. Close even if
        // the original slot is gone, because setup can have recreated its label.
        self.registry.window_closed(&label);
        if still_open {
            self.close(&mut streams, stream);
        }
        if !entry.is_active() {
            return Err(CommandError::UnknownHost { host: request.host });
        }
        Err(internal(format!(
            "live stream {stream} closed during subscription"
        )))
    }

    pub(super) fn unsubscribe(&self, stream: u32) {
        let mut streams = self.streams.lock_ok();
        self.close(&mut streams, stream);
    }

    fn close(&self, streams: &mut Streams, stream: u32) {
        if let Some(slot) = streams.active.get_mut(&stream) {
            if slot.open {
                self.registry.window_closed(&slot.label);
                slot.open = false;
            }
            if !slot.sending {
                streams.active.remove(&stream);
            }
        }
    }

    fn begin_send(&self, stream: u32, label: &str) -> bool {
        let mut streams = self.streams.lock_ok();
        let Some(slot) = streams
            .active
            .get_mut(&stream)
            .filter(|s| s.label == label && s.open)
        else {
            return false;
        };
        // Keep the ID reserved until the foreign callback returns, including
        // when unsubscribe or host removal closes its window in the meantime.
        slot.sending = true;
        true
    }

    fn finish_send(&self, stream: u32, delivered: bool) -> bool {
        let mut streams = self.streams.lock_ok();
        let Some(slot) = streams.active.get_mut(&stream) else {
            return false;
        };
        slot.sending = false;
        if delivered && slot.open {
            return true;
        }
        self.close(&mut streams, stream);
        false
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        for stream in self.streams.lock_ok().active.values() {
            self.registry.window_closed(&stream.label);
        }
    }
}

struct EventSink {
    stream: u32,
    label: String,
    live: Weak<Live>,
    events: Arc<dyn CoreEvents>,
}

impl LiveSink for EventSink {
    fn id(&self) -> u32 {
        self.stream
    }

    fn send(&self, message: LiveMsg) -> bool {
        let Some(live) = self.live.upgrade() else {
            return false;
        };
        if !live.begin_send(self.stream, &self.label) {
            return false;
        }
        let delivered = match serde_json::to_string(&message) {
            Ok(json) => callback("live", || self.events.live(self.stream, json)).unwrap_or(false),
            Err(error) => {
                tracing::error!(%error, stream = self.stream, "serializing a mobile live message");
                false
            }
        };
        live.finish_send(self.stream, delivered)
    }
}
