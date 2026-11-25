use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use statglass_engine::{LiveHub, Source};
use statglass_ipc::error::CommandError;
use statglass_ipc::live::{
    LiveFeed, LiveMsg, LiveRegistry, LiveRequest, LiveSink, SubscriptionInfo,
};
use statglass_ipc::mobile::MobileLiveRequest;
use statglass_schema::{Capabilities, HostId, lock::LockExt};
use tokio::{runtime::Handle, sync::watch};

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
    order: u64,
    generation: u64,
    request: LiveRequest,
    sink: Arc<EventSink>,
    open: bool,
    established: bool,
    sending: watch::Sender<bool>,
}

impl Live {
    pub(super) fn register(self: &Arc<Self>, entry: Arc<HostEntry>, runtime: &Handle) {
        let mut streams = self.streams.lock_ok();
        self.registry.replace_host(entry.clone());
        for slot in streams
            .active
            .values_mut()
            .filter(|slot| slot.host == entry.config.id && slot.open && slot.established)
        {
            self.registry.window_closed(&slot.sink.label);
            slot.generation += 1;
            slot.sink = Arc::new(EventSink {
                label: format!("mobile-{}-{}", slot.order, slot.generation),
                ..(*slot.sink).clone()
            });
            self.registry.window_visible(&slot.sink.label, true);
            let (entry, sink, request) = (entry.clone(), slot.sink.clone(), slot.request.clone());
            let mut sending = slot.sending.subscribe();
            let live = Arc::downgrade(self);
            runtime.spawn(async move {
                // An old callback can still be returning after its feed was
                // replaced. Keep that delivery ahead of the new feed's setup.
                let ready = sending.wait_for(|sending| !*sending).await.is_ok();
                if ready && let Some(live) = live.upgrade() {
                    live.attach(entry, sink, request);
                }
            });
        }
    }

    pub(super) fn remove_host(&self, host: HostId) {
        let mut streams = self.streams.lock_ok();
        self.registry.remove_host(host);
        streams.active.retain(|_, stream| {
            if stream.host == host && stream.open {
                stream.open = false;
                self.registry.window_closed(&stream.sink.label);
            }
            stream.open || *stream.sending.borrow()
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
        let options = LiveRequest {
            backfill_ms: request
                .backfill_ms
                .unwrap_or(statglass_ipc::live::DEFAULT_BACKFILL_MS),
            series: request.series,
            min_period_ms: request.min_period_ms.unwrap_or_default(),
        };
        let sink = {
            let mut streams = self.streams.lock_ok();
            if streams.active.contains_key(&stream) {
                return Err(invalid(format!("live stream {stream} is still in use")));
            }
            let order = streams.next;
            streams.next += 1;
            let sink = Arc::new(EventSink {
                stream,
                label: format!("mobile-{order}-0"),
                live: Arc::downgrade(self),
                events,
            });
            streams.active.insert(
                stream,
                Stream {
                    host: request.host,
                    order,
                    generation: 0,
                    request: options.clone(),
                    sink: sink.clone(),
                    open: true,
                    established: false,
                    sending: watch::Sender::new(false),
                },
            );
            self.registry.window_visible(&sink.label, true);
            sink
        };
        if let Some(info) = self.attach(entry.clone(), sink, options) {
            return Ok(info);
        }
        if !entry.is_active() {
            return Err(CommandError::UnknownHost { host: request.host });
        }
        Err(internal(format!(
            "live stream {stream} closed during subscription"
        )))
    }

    fn attach(
        &self,
        entry: Arc<HostEntry>,
        sink: Arc<EventSink>,
        request: LiveRequest,
    ) -> Option<SubscriptionInfo> {
        let result = entry
            .is_active()
            .then(|| {
                self.registry
                    .subscribe(&sink.label, entry.clone(), sink.clone(), request)
            })
            .flatten();
        let mut streams = self.streams.lock_ok();
        if let Some(slot) = streams
            .active
            .get_mut(&sink.stream)
            .filter(|s| s.sink.label == sink.label && s.open)
        {
            if result.is_some() && entry.is_active() {
                slot.established = true;
                return result;
            }
            if entry.is_active() || !slot.established {
                self.close(&mut streams, sink.stream);
            }
        } else {
            // Setup may have recreated a window closed by an unsubscribe.
            self.registry.window_closed(&sink.label);
        }
        None
    }

    pub(super) fn unsubscribe(&self, stream: u32) {
        let mut streams = self.streams.lock_ok();
        self.close(&mut streams, stream);
    }

    fn close(&self, streams: &mut Streams, stream: u32) {
        if let Some(slot) = streams.active.get_mut(&stream) {
            if slot.open {
                self.registry.window_closed(&slot.sink.label);
                slot.open = false;
            }
            if !*slot.sending.borrow() {
                streams.active.remove(&stream);
            }
        }
    }

    fn begin_send(&self, stream: u32, label: &str) -> bool {
        let mut streams = self.streams.lock_ok();
        let Some(slot) = streams
            .active
            .get_mut(&stream)
            .filter(|s| s.sink.label == label && s.open)
        else {
            return false;
        };
        // Keep the ID reserved until the foreign callback returns, including
        // when unsubscribe or host removal closes its window in the meantime.
        slot.sending.send_replace(true);
        true
    }

    fn finish_send(&self, stream: u32, label: &str, delivered: bool) -> bool {
        let mut streams = self.streams.lock_ok();
        let Some(slot) = streams.active.get_mut(&stream) else {
            return false;
        };
        slot.sending.send_replace(false);
        if delivered && slot.open {
            return slot.sink.label == label;
        }
        self.close(&mut streams, stream);
        false
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        for stream in self.streams.lock_ok().active.values() {
            self.registry.window_closed(&stream.sink.label);
        }
    }
}

#[derive(Clone)]
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
        live.finish_send(self.stream, &self.label, delivered)
    }
}
