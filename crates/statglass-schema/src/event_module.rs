use crate::{AlertCause, Catalog, EventDetail, Module};

impl Module {
    /// History events for sensors share the Power & Sensors page.
    pub const fn event_module(self) -> Self {
        match self {
            Self::Sensors => Self::Power,
            module => module,
        }
    }
}

impl EventDetail {
    /// A kind whose module can be read from the event row's tag alone.
    pub fn fixed_module(kind: &str) -> Option<Module> {
        match kind {
            "fans_ramped" | "thermal_state" => Some(Module::Sensors.event_module()),
            "power_spike" => Some(Module::Power),
            "sustained_process" => Some(Module::Cpu),
            _ => None,
        }
    }

    pub fn module(&self, catalog: &Catalog) -> Option<Module> {
        let Self::Alert { cause, .. } = self else {
            return Self::fixed_module(self.kind());
        };
        let module = match cause {
            AlertCause::ProcessCpu { .. } => Some(Module::Cpu),
            AlertCause::ThermalState { .. } => Some(Module::Sensors),
            AlertCause::Threshold { metric, .. } => {
                catalog.get(metric.as_str()).map(|def| def.module)
            }
            AlertCause::HostOffline { .. } | AlertCause::HostBack { .. } => None,
        };
        module.map(Module::event_module)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Cmp, HostId, Labels, MetricId, ThermalState};
    use uuid::Uuid;

    #[test]
    fn history_alerts_follow_their_module() {
        let catalog = Catalog::builtin();
        let thermal = EventDetail::ThermalState {
            from: None,
            to: ThermalState::Serious,
        };
        assert_eq!(thermal.module(&catalog), Some(Module::Power));
        for (cause, module) in [
            (
                AlertCause::ThermalState {
                    state: ThermalState::Serious,
                },
                thermal.module(&catalog),
            ),
            (
                AlertCause::Threshold {
                    metric: MetricId::from_static("thermal.state"),
                    labels: Labels::new(),
                    value: 2.0,
                    op: Cmp::Gt,
                    threshold: 1.0,
                    for_secs: 1,
                },
                Some(Module::Power),
            ),
            (
                AlertCause::ProcessCpu {
                    process: "build".into(),
                    cpu_pct: 99.0,
                },
                Some(Module::Cpu),
            ),
            (
                AlertCause::HostOffline {
                    host: HostId(Uuid::nil()),
                    name: "build box".into(),
                },
                None,
            ),
        ] {
            let event = EventDetail::Alert {
                rule_id: Uuid::nil(),
                rule_name: "Fixture".into(),
                cause,
            };
            assert_eq!(event.module(&catalog), module, "{event:?}");
        }
    }
}
