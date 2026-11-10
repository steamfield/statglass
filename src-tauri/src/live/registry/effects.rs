//! Ordered delivery of window and recent-demand callbacks outside the registry lock.
use super::*;

/// Captured while holding the registry lock; callbacks run after releasing it.
struct RecentInterest {
    on: bool,
    observer: Option<Arc<dyn Fn(bool) + Send + Sync>>,
    sources: Vec<Arc<dyn RecentFeed>>,
}
impl RecentInterest {
    fn apply(self) {
        if let Some(observer) = self.observer {
            observer(self.on);
        }
        for source in self.sources {
            source.set_recent_interest(self.on);
        }
    }
}

impl Inner {
    pub(super) fn queue_recent_interest(&mut self) {
        let recent = RecentInterest {
            on: self.windows.values().any(|w| w.is_visible() && w.recent),
            observer: self.recent_observer.clone(),
            sources: self.recent_sources.values().cloned().collect(),
        };
        self.effects.push_back(Box::new(move || recent.apply()));
    }
}

impl LiveRegistry {
    /// One caller drains callbacks in mutation order without holding `inner`.
    /// Concurrent and reentrant callers enqueue their effects and return.
    pub(super) fn apply_effects(&self) {
        {
            let mut inner = self.lock();
            if inner.applying_effects {
                return;
            }
            inner.applying_effects = true;
        }
        loop {
            let effect = {
                let mut inner = self.lock();
                let next = inner.effects.pop_front();
                if next.is_none() {
                    inner.applying_effects = false;
                }
                next
            };
            let Some(effect) = effect else {
                return;
            };
            effect();
        }
    }
}
