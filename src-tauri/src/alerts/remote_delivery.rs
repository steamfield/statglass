//! Delivery of alert events synced from Linux agent hosts (plan/rfc-remote-alerts.md
//! 5.4, 5.5): a per-host floor so each alert is delivered once, staleness judged on this
//! Mac's clock, and one grouped catch-up message for alerts older than 10 minutes.
