//! Rule sentences and notification text for alerts.

use statglass_schema::settings::UnitSettings;
use statglass_schema::{AlertRule, Event};

/// A notification's title and body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlertText {
    pub title: String,
    pub body: String,
}

/// A custom rule as one sentence: the metric's label, the series in parentheses when
/// the rule watches one ([`statglass_schema::series_name`]), "above" or "below", the
/// threshold in the user's units, and " for <duration>" unless `for_secs` is 0:
/// "Memory pressure above 80% for 2 min", "Free disk space (/) below 20 GB".
pub fn rule_summary(_rule: &AlertRule, _units: &UnitSettings) -> String {
    String::new()
}

/// Title and body of the notification for an `alert` event, `None` for any other
/// event. A threshold alert is titled with the rule name, its body reads
/// "<label> <value> · <comparison> <threshold> for <duration>".
pub fn alert_text(_event: &Event, _units: &UnitSettings) -> Option<AlertText> {
    None
}

/// The one-off confirmation for rules just switched on, `None` for none.
pub fn alerts_on_text(_rules: &[AlertRule], _units: &UnitSettings) -> Option<AlertText> {
    None
}
