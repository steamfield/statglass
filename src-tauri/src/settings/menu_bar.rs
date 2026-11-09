//! A change to the menu bar (D-102).
use super::set;
use serde::Deserialize;
use statglass_schema::settings::{ItemMode, MenuBarSettings};

/// A change to the menu bar (D-102). Each field of each group patches on its own, so one
/// switch never overwrites another window's change to a different one (D-050).
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, specta::Type)]
#[serde(default)]
pub struct MenuBarPatch {
    #[specta(optional)]
    pub bars: Option<BarsPatch>,
    #[specta(optional)]
    pub readouts: Option<ReadoutsPatch>,
    #[specta(optional)]
    pub items: Option<ItemsPatch>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, specta::Type)]
#[serde(default)]
pub struct BarsPatch {
    #[specta(optional)]
    pub cpu: Option<bool>,
    #[specta(optional)]
    pub gpu: Option<bool>,
    #[specta(optional)]
    pub memory: Option<bool>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, specta::Type)]
#[serde(default)]
pub struct ReadoutsPatch {
    #[specta(optional)]
    pub cpu: Option<bool>,
    #[specta(optional)]
    pub gpu: Option<bool>,
    #[specta(optional)]
    pub memory: Option<bool>,
    #[specta(optional)]
    pub temperature: Option<bool>,
    #[specta(optional)]
    pub power: Option<bool>,
    #[specta(optional)]
    pub network: Option<bool>,
    #[specta(optional)]
    pub disk: Option<bool>,
    #[specta(optional)]
    pub battery: Option<bool>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, specta::Type)]
#[serde(default)]
pub struct ItemsPatch {
    #[specta(optional)]
    pub cpu: Option<ItemMode>,
    #[specta(optional)]
    pub gpu: Option<ItemMode>,
    #[specta(optional)]
    pub memory: Option<ItemMode>,
    #[specta(optional)]
    pub power: Option<ItemMode>,
    #[specta(optional)]
    pub network: Option<ItemMode>,
    #[specta(optional)]
    pub disk: Option<ItemMode>,
    #[specta(optional)]
    pub battery: Option<ItemMode>,
}

impl MenuBarPatch {
    pub fn apply(self, target: &mut MenuBarSettings) {
        if let Some(b) = self.bars {
            set(&mut target.bars.cpu, b.cpu);
            set(&mut target.bars.gpu, b.gpu);
            set(&mut target.bars.memory, b.memory);
        }
        if let Some(r) = self.readouts {
            let o = &mut target.readouts;
            set(&mut o.cpu, r.cpu);
            set(&mut o.gpu, r.gpu);
            set(&mut o.memory, r.memory);
            set(&mut o.temperature, r.temperature);
            set(&mut o.power, r.power);
            set(&mut o.network, r.network);
            set(&mut o.disk, r.disk);
            set(&mut o.battery, r.battery);
        }
        if let Some(i) = self.items {
            let o = &mut target.items;
            set(&mut o.cpu, i.cpu);
            set(&mut o.gpu, i.gpu);
            set(&mut o.memory, i.memory);
            set(&mut o.power, i.power);
            set(&mut o.network, i.network);
            set(&mut o.disk, i.disk);
            set(&mut o.battery, i.battery);
        }
    }
}
