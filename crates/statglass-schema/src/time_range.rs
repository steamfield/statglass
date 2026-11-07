//! The half-open `[from_ms, to_ms)` range a history query asks for, checked once.
//!
//! Not exported through specta: the frontend's `TimeRange` (`@core/brush`) is a
//! different, view-side type.

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// A non-empty `[from_ms, to_ms)` range no longer than the limit it was checked against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimeRange {
    from_ms: i64,
    to_ms: i64,
}

/// Why a range was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RangeError {
    /// `from_ms` is not before `to_ms`: the range is empty or runs backwards.
    #[error("the range is empty: its start ({from_ms}) is not before its end ({to_ms})")]
    Empty { from_ms: i64, to_ms: i64 },
    /// The range spans more than `max_ms`.
    #[error("the range is longer than {}", Span(*max_ms))]
    TooLong { span_ms: i64, max_ms: i64 },
}

impl TimeRange {
    /// `[from_ms, to_ms)` when `from_ms < to_ms` and it spans at most `max_ms`. Pass
    /// `i64::MAX` for no limit.
    pub const fn new(from_ms: i64, to_ms: i64, max_ms: i64) -> Result<Self, RangeError> {
        if from_ms >= to_ms {
            return Err(RangeError::Empty { from_ms, to_ms });
        }
        let span_ms = to_ms.saturating_sub(from_ms);
        if span_ms > max_ms {
            return Err(RangeError::TooLong { span_ms, max_ms });
        }
        Ok(Self { from_ms, to_ms })
    }

    pub const fn from_ms(self) -> i64 {
        self.from_ms
    }

    pub const fn to_ms(self) -> i64 {
        self.to_ms
    }
}

/// A limit in words: whole days or hours when it is one, milliseconds otherwise.
struct Span(i64);

impl std::fmt::Display for Span {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let ms = self.0;
        let (n, unit) = if ms > 0 && ms % DAY_MS == 0 {
            (ms / DAY_MS, "day")
        } else if ms > 0 && ms % HOUR_MS == 0 {
            (ms / HOUR_MS, "hour")
        } else {
            return write!(f, "{ms} ms");
        };
        write!(f, "{n} {unit}{}", if n == 1 { "" } else { "s" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_forward_range_up_to_the_limit() {
        let r = TimeRange::new(10, 20, 10).unwrap();
        assert_eq!((r.from_ms(), r.to_ms()), (10, 20));
        assert!(TimeRange::new(i64::MIN, i64::MAX, i64::MAX).is_ok());
    }

    #[test]
    fn refuses_empty_and_backwards_ranges() {
        assert_eq!(
            TimeRange::new(5, 5, i64::MAX),
            Err(RangeError::Empty {
                from_ms: 5,
                to_ms: 5
            })
        );
        assert!(matches!(
            TimeRange::new(6, 5, i64::MAX),
            Err(RangeError::Empty { .. })
        ));
    }

    #[test]
    fn refuses_a_range_past_the_limit() {
        assert_eq!(
            TimeRange::new(0, 11, 10),
            Err(RangeError::TooLong {
                span_ms: 11,
                max_ms: 10
            })
        );
    }

    #[test]
    fn names_the_limit_in_whole_units() {
        let too_long = |max_ms| TimeRange::new(0, i64::MAX, max_ms).unwrap_err().to_string();
        assert_eq!(too_long(90 * DAY_MS), "the range is longer than 90 days");
        assert_eq!(too_long(DAY_MS), "the range is longer than 1 day");
        assert_eq!(too_long(HOUR_MS), "the range is longer than 1 hour");
        assert_eq!(too_long(1_500), "the range is longer than 1500 ms");
        assert_eq!(
            TimeRange::new(3, 2, 10).unwrap_err().to_string(),
            "the range is empty: its start (3) is not before its end (2)"
        );
    }
}
