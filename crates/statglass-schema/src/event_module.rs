use crate::{AlertCause, Catalog, EventDetail, Module};

impl EventDetail {
    pub fn module(&self, catalog: &Catalog) -> Option<Module> {
        match self {
            Self::FansRamped { .. } | Self::ThermalState { .. } | Self::PowerSpike { .. } => {
                Some(Module::Power)
            }
            Self::SustainedProcess { .. } => Some(Module::Cpu),
            Self::Alert { cause, .. } => match cause {
                AlertCause::ProcessCpu { .. } => Some(Module::Cpu),
                AlertCause::ThermalState { .. } => Some(Module::Sensors),
                AlertCause::Threshold { metric, .. } => {
                    catalog.get(metric.as_str()).map(|def| def.module)
                }
                AlertCause::HostOffline { .. } | AlertCause::HostBack { .. } => None,
            },
        }
    }
}
