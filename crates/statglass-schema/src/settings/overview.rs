//! Which cards the dashboard's Overview shows. A card the host can't fill (no battery,
//! no remote hosts, Docker monitoring off) stays hidden whatever this says.
use serde::{Deserialize, Serialize};

/// Every card is shown unless the user turned it off. A missing field takes its default,
/// so a settings file from before this existed shows them all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct OverviewSettings {
    pub cpu: bool,
    pub gpu: bool,
    pub memory: bool,
    pub power: bool,
    pub network: bool,
    pub disk: bool,
    pub battery: bool,
    pub events: bool,
    pub apps: bool,
    pub folders: bool,
    pub containers: bool,
    pub hosts: bool,
}

impl Default for OverviewSettings {
    fn default() -> Self {
        Self {
            cpu: true,
            gpu: true,
            memory: true,
            power: true,
            network: true,
            disk: true,
            battery: true,
            events: true,
            apps: true,
            folders: true,
            containers: true,
            hosts: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_cards_are_shown() {
        let s: OverviewSettings = serde_json::from_str(r#"{"apps":false}"#).unwrap();
        assert!(!s.apps);
        assert!(s.cpu && s.hosts);
    }
}
