//! Counter math the cumulative-counter collectors share on every platform: spans
//! between continuous-clock readings, wrap- and reset-aware deltas, per-second rates,
//! the disk I/O rate set, and `*_total` sums (D-092).

/// A `*_total` series being summed over one sample's parts (`net.rx_total`,
/// `disk.read_total`, D-092): the parts are the series the collector reports on that
/// sample, and the total is a gap when any of them is.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct PartSum {
    sum: f64,
    gap: bool,
}

impl PartSum {
    /// Adds one reported part's value for this sample; `None` is that part's gap.
    pub(crate) fn add(&mut self, part: Option<f32>) {
        match part {
            Some(v) => self.sum += f64::from(v),
            None => self.gap = true,
        }
    }

    /// The total, `None` when any part was a gap.
    pub(crate) fn total(self) -> Option<f32> {
        (!self.gap).then_some(self.sum as f32)
    }
}

/// Seconds between two continuous-clock readings, `None` without a previous one
/// (`prev_ns == 0`) or when the clock did not advance.
pub(crate) fn span_secs(prev_ns: u64, now_ns: u64) -> Option<f64> {
    secs_since((prev_ns > 0).then_some(prev_ns), now_ns)
}

/// Seconds from the previous continuous-clock reading to `now_ns`, `None` without one or
/// when the clock did not advance. Unlike [`span_secs`], a reading at 0 is a real one.
pub(crate) fn secs_since(prev_ns: Option<u64>, now_ns: u64) -> Option<f64> {
    prev_ns
        .filter(|&prev| now_ns > prev)
        .map(|prev| (now_ns - prev) as f64 / 1e9)
}

/// Whole milliseconds from the previous continuous-clock reading to `now_ns`: 0 without
/// one or when the clock did not advance.
pub(crate) fn span_ms(prev_ns: Option<u64>, now_ns: u64) -> u64 {
    prev_ns.map_or(0, |prev| now_ns.saturating_sub(prev) / 1_000_000)
}

/// How wide a cumulative counter may be, which decides what a decrease means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CounterWidth {
    /// May be kept in 32 bits (macOS hands unprivileged callers truncated byte
    /// counters, D-089): a decrease from a value that fits in 32 bits is a wrap, any
    /// other decrease a reset.
    Bits32,
    /// 64-bit: never wraps in practice, so every decrease is a reset.
    Bits64,
}

/// The increase from `prev` to `cur`. `None` means a reset: the source restarted and
/// this interval's increase is unknown.
pub(crate) fn counter_delta(prev: u64, cur: u64, width: CounterWidth) -> Option<u64> {
    if cur >= prev {
        Some(cur - prev)
    } else if width == CounterWidth::Bits32 && prev <= u64::from(u32::MAX) {
        Some(cur + (1u64 << 32) - prev)
    } else {
        None
    }
}

/// Per-second rate between two readings of a 64-bit counter; `None` on a reset or a
/// span that is not positive.
pub(crate) fn rate(prev: u64, cur: u64, secs: f64) -> Option<f32> {
    if secs <= 0.0 {
        return None;
    }
    let delta = counter_delta(prev, cur, CounterWidth::Bits64)?;
    Some((delta as f64 / secs) as f32)
}

/// The eight per-disk values in `statglass_schema::disk_io::DEVICE_METRICS` order from
/// the six cumulative counters (read bytes, write bytes, read ops, write ops, read time,
/// write time), each `None` when unknown. Read and write pair independently: an
/// unsupported timing counter never masks known operations/s, and a timing pair needs
/// both of its counters valid and, when time moved, at least one completed request, so
/// an invalid pair never fabricates request time. `time_units_per_ms` is the platform's
/// time-counter unit (1e6 for nanoseconds, 1 for milliseconds); time is reported in ms
/// per second.
pub(crate) fn counter_rates(
    prev: [Option<u64>; 6],
    cur: [Option<u64>; 6],
    secs: Option<f64>,
    time_units_per_ms: f32,
) -> [Option<f32>; 8] {
    let Some(secs) = secs else {
        return [None; 8];
    };
    let v: [Option<f32>; 6] = std::array::from_fn(|i| rate(prev[i]?, cur[i]?, secs));
    let mut out = [v[0], v[1], v[2], v[3], None, None, None, None];
    for side in 0..2 {
        if let (Some(ops), Some(t)) = (v[2 + side], v[4 + side])
            && (ops > 0. || t == 0.)
        {
            out[4 + side] = Some(ops);
            out[6 + side] = Some(t / time_units_per_ms);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_sum_is_a_gap_when_any_part_is() {
        let mut s = PartSum::default();
        s.add(Some(1.5));
        s.add(Some(2.5));
        assert_eq!(s.total(), Some(4.0));
        s.add(None);
        s.add(Some(1.0));
        assert_eq!(s.total(), None);
        assert_eq!(PartSum::default().total(), Some(0.0));
    }

    #[test]
    fn span_needs_a_baseline_and_a_clock_that_advanced() {
        assert_eq!(span_secs(1_000_000_000, 3_000_000_000), Some(2.0));
        assert_eq!(span_secs(0, 5), None);
        assert_eq!(span_secs(5, 5), None);
        assert_eq!(span_secs(7, 5), None);
    }

    #[test]
    fn a_previous_reading_at_zero_still_counts() {
        assert_eq!(secs_since(Some(0), 2_000_000_000), Some(2.0));
        assert_eq!(secs_since(None, 5), None);
        assert_eq!(secs_since(Some(5), 5), None);
        assert_eq!(secs_since(Some(7), 5), None);
        assert_eq!(span_ms(Some(0), 2_500_000_000), 2_500);
        assert_eq!(span_ms(None, 5_000_000), 0);
        assert_eq!(span_ms(Some(7_000_000), 5_000_000), 0);
    }

    #[test]
    fn rate_is_none_on_a_reset_or_a_span_that_is_not_positive() {
        assert_eq!(rate(100, 300, 2.0), Some(100.0));
        assert_eq!(rate(100, 100, 1.0), Some(0.0));
        assert_eq!(rate(300, 100, 1.0), None);
        assert_eq!(rate(100, 300, 0.0), None);
        assert_eq!(rate(100, 300, -1.0), None);
        // A 64-bit counter just below 2^32 that decreases is a reset, not a wrap.
        assert_eq!(rate(u64::from(u32::MAX) - 9, 5, 1.0), None);
    }

    #[test]
    fn a_32_bit_counter_wraps_and_a_64_bit_one_resets() {
        let near_wrap = u64::from(u32::MAX) - 9;
        assert_eq!(counter_delta(100, 150, CounterWidth::Bits32), Some(50));
        assert_eq!(counter_delta(near_wrap, 5, CounterWidth::Bits32), Some(15));
        assert_eq!(
            counter_delta(u64::from(u32::MAX), 0, CounterWidth::Bits32),
            Some(1)
        );
        // Above 32 bits the counter is not truncated, so a decrease is a reset.
        assert_eq!(counter_delta(1 << 40, 5, CounterWidth::Bits32), None);
        assert_eq!(counter_delta(100, 150, CounterWidth::Bits64), Some(50));
        assert_eq!(counter_delta(near_wrap, 5, CounterWidth::Bits64), None);
        assert_eq!(counter_delta(7, 7, CounterWidth::Bits64), Some(0));
    }

    #[test]
    fn nanosecond_request_pairs_handle_idle_unsupported_reset_and_one_sided_failure() {
        let ns = |prev, cur, secs| counter_rates(prev, cur, Some(secs), 1e6);
        let baseline = [Some(100); 6];
        let current = [
            Some(300),
            Some(200),
            Some(110),
            Some(100),
            Some(10_000_100),
            Some(100),
        ];
        let rates = ns(baseline, current, 2.);
        assert_eq!(
            rates,
            [
                Some(100.),
                Some(50.),
                Some(5.),
                Some(0.),
                Some(5.),
                Some(0.),
                Some(5.),
                Some(0.)
            ]
        );
        assert_eq!(
            statglass_schema::disk_io::request_ms(rates[6].map(f64::from), rates[4].map(f64::from)),
            Some(1.)
        );
        assert_eq!(
            statglass_schema::disk_io::request_ms(rates[7].map(f64::from), rates[5].map(f64::from)),
            None
        );
        let mut missing = current;
        missing[4] = None;
        let missing_rates = ns(baseline, missing, 2.);
        assert_eq!(
            (missing_rates[2], missing_rates[4], missing_rates[6]),
            (Some(5.), None, None)
        );
        assert_eq!(missing_rates[5], Some(0.));
        let mut reset = current;
        reset[4] = Some(1);
        assert_eq!(ns(baseline, reset, 2.)[4], None);
        reset[2] = Some(1);
        reset[4] = current[4];
        assert_eq!(ns(baseline, reset, 2.)[6], None);
        assert_eq!(ns([None; 6], current, 2.), [None; 8]);
        assert_eq!(ns(baseline, current, 0.), [None; 8]);
        assert_eq!(ns(current, current, 1.)[4..], [Some(0.); 4]);
    }

    #[test]
    fn millisecond_timing_pairs_need_completed_requests() {
        let ms = |prev: [u64; 6], cur: [u64; 6], secs| {
            counter_rates(prev.map(Some), cur.map(Some), secs, 1.)
        };
        let p = [0, 0, 10, 10, 100, 100];
        // Reads: 2 ops, 5 ms. Writes: time moved with no completion, so no pair.
        let c = [512, 0, 12, 10, 105, 103];
        assert_eq!(
            ms(p, c, Some(1.)),
            [
                Some(512.),
                Some(0.),
                Some(2.),
                Some(0.),
                Some(2.),
                None,
                Some(5.),
                None
            ]
        );
        // Idle: zero ops and zero time is a valid zero pair.
        assert_eq!(ms(p, p, Some(1.))[4..], [Some(0.); 4]);
        assert_eq!(ms(p, c, None), [None; 8]);
        // A read-side reset leaves the write side.
        let reset = [0, 0, 1, 11, 1, 101];
        let r = ms(p, reset, Some(1.));
        assert_eq!(
            (r[2], r[3], r[4], r[5], r[7]),
            (None, Some(1.), None, Some(1.), Some(1.))
        );
    }
}
