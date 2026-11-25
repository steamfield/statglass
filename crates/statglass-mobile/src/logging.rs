#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
pub(crate) fn init() {
    use std::sync::Once;

    use tracing_oslog::OsLogger;
    use tracing_subscriber::{filter::LevelFilter, prelude::*};

    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // The sink makes its message public. Keep verbose SSH diagnostics out of it.
        // It renders error fields with Display and does not walk their source chains.
        let log = OsLogger::new("app.statglass", "rust").with_filter(LevelFilter::WARN);
        let subscriber = tracing_subscriber::registry().with(log);
        // An embedding process can already have a global subscriber. Leave it in place.
        let _ = tracing::subscriber::set_global_default(subscriber);
    });
}

#[cfg(not(any(target_os = "ios", all(test, target_os = "macos"))))]
pub(crate) fn init() {}

#[cfg(all(test, any(target_os = "ios", target_os = "macos")))]
mod tests {
    use tracing::{Level, dispatcher};
    use tracing_oslog::OsLogger;

    #[test]
    fn logging_uses_one_os_log_layer_for_two_cores() {
        let _first = crate::facade_tests::new_unstarted_core();
        let dispatcher = dispatcher::get_default(Clone::clone);
        let log = dispatcher.downcast_ref::<OsLogger>().expect("OSLog layer");
        assert!(tracing::event_enabled!(Level::ERROR));
        assert!(!tracing::event_enabled!(Level::DEBUG));

        let _second = crate::facade_tests::new_unstarted_core();
        dispatcher::get_default(|current| {
            let current_log = current.downcast_ref::<OsLogger>().expect("OSLog layer");
            assert!(std::ptr::eq(log, current_log));
        });
    }
}
