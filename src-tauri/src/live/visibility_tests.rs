#[cfg(test)]
mod tests {
    use crate::live::LiveRegistry;
    use statglass_schema::lock::LockExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn live_visibility_events_only_reach_the_window_that_changed() {
        let registry = LiveRegistry::new();
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        registry.set_visibility_emitter(move |label, event| {
            received.lock_ok().push((label.to_string(), event.visible));
        });
        assert!(!registry.is_visible("dashboard"));
        registry.window_visible("dashboard", false);
        registry.window_visible("dashboard", true);
        registry.window_visible("dashboard", true);
        registry.window_visible("popover", true);
        registry.window_visible("dashboard", false);
        assert_eq!(
            *events.lock_ok(),
            vec![
                ("dashboard".into(), true),
                ("popover".into(), true),
                ("dashboard".into(), false),
            ]
        );
        assert!(!registry.is_visible("dashboard"));
        assert!(registry.is_visible("popover"));
        assert!(!registry.is_visible("onboarding"));
    }
}
