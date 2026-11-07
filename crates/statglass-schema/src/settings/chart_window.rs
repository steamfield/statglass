use serde::{Deserialize, Serialize};

/// The dashboard chart window. Longer and fixed ranges read retained history.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    specta::Type,
)]
pub enum ChartWindow {
    #[serde(rename = "5m")]
    M5,
    #[default]
    #[serde(rename = "15m")]
    M15,
    #[serde(rename = "30m")]
    M30,
    #[serde(rename = "1h")]
    H1,
    /// A rolling duration in milliseconds.
    #[serde(rename = "relative")]
    Relative(#[specta(type = crate::JsSafeInt)] i64),
    /// A fixed interval in Unix milliseconds.
    #[serde(rename = "absolute")]
    Absolute {
        #[specta(type = crate::JsSafeInt)]
        from_ms: i64,
        #[specta(type = crate::JsSafeInt)]
        to_ms: i64,
    },
}

impl ChartWindow {
    /// The fixed choices, shortest first.
    pub const PRESETS: [Self; 4] = [Self::M5, Self::M15, Self::M30, Self::H1];

    /// A fixed choice's duration in ms; `None` for a rolling or fixed range, whose
    /// duration is their own.
    pub const fn preset_ms(self) -> Option<i64> {
        match self {
            Self::M5 => Some(5 * 60_000),
            Self::M15 => Some(15 * 60_000),
            Self::M30 => Some(30 * 60_000),
            Self::H1 => Some(60 * 60_000),
            Self::Relative(_) | Self::Absolute { .. } => None,
        }
    }

    pub fn valid(self) -> bool {
        let duration = match self {
            Self::Relative(ms) => ms,
            Self::Absolute { from_ms, to_ms } => {
                if from_ms < 0 || to_ms > 9_007_199_254_740_991 {
                    return false;
                }
                to_ms.saturating_sub(from_ms)
            }
            _ => return true,
        };
        (60_000..=90 * 86_400_000).contains(&duration)
    }
}

#[cfg(test)]
mod tests {
    use super::ChartWindow;

    #[test]
    fn presets_are_shortest_first_with_the_default_among_them() {
        let ms: Vec<_> = ChartWindow::PRESETS
            .iter()
            .map(|w| w.preset_ms().unwrap())
            .collect();
        assert_eq!(ms, [300_000, 900_000, 1_800_000, 3_600_000]);
        assert!(ChartWindow::PRESETS.contains(&ChartWindow::default()));
        assert_eq!(ChartWindow::Relative(300_000).preset_ms(), None);
    }
}
