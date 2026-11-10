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

struct EffectDrain<'a> {
    registry: &'a LiveRegistry,
    active: bool,
}
impl Drop for EffectDrain<'_> {
    fn drop(&mut self) {
        if self.active {
            self.registry.lock().applying_effects = false;
        }
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
        let mut drain = EffectDrain {
            registry: self,
            active: true,
        };
        loop {
            let effect = {
                let mut inner = self.lock();
                let next = inner.effects.pop_front();
                if next.is_none() {
                    inner.applying_effects = false;
                    drain.active = false;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effects_resume_after_a_callback_panics() {
        let registry = LiveRegistry::new();
        registry
            .lock()
            .effects
            .push_back(Box::new(|| panic!("callback failed")));
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                registry.apply_effects();
            }))
            .is_err()
        );
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = ran.clone();
        registry.lock().effects.push_back(Box::new(move || {
            observed.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
        registry.apply_effects();
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
    }
}
