//! A change to which Overview cards show; each card patches on its own (D-050).
use super::set;
use serde::Deserialize;
use statglass_schema::settings::OverviewSettings;

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, specta::Type)]
#[serde(default)]
pub struct OverviewPatch {
    #[specta(optional)]
    pub cpu: Option<bool>,
    #[specta(optional)]
    pub gpu: Option<bool>,
    #[specta(optional)]
    pub memory: Option<bool>,
    #[specta(optional)]
    pub power: Option<bool>,
    #[specta(optional)]
    pub network: Option<bool>,
    #[specta(optional)]
    pub disk: Option<bool>,
    #[specta(optional)]
    pub battery: Option<bool>,
    #[specta(optional)]
    pub events: Option<bool>,
    #[specta(optional)]
    pub apps: Option<bool>,
    #[specta(optional)]
    pub folders: Option<bool>,
    #[specta(optional)]
    pub containers: Option<bool>,
    #[specta(optional)]
    pub hosts: Option<bool>,
}

impl OverviewPatch {
    pub fn apply(self, target: &mut OverviewSettings) {
        set(&mut target.cpu, self.cpu);
        set(&mut target.gpu, self.gpu);
        set(&mut target.memory, self.memory);
        set(&mut target.power, self.power);
        set(&mut target.network, self.network);
        set(&mut target.disk, self.disk);
        set(&mut target.battery, self.battery);
        set(&mut target.events, self.events);
        set(&mut target.apps, self.apps);
        set(&mut target.folders, self.folders);
        set(&mut target.containers, self.containers);
        set(&mut target.hosts, self.hosts);
    }
}
