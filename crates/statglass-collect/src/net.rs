//! The network sample both platform collectors emit from cumulative interface counters:
//! `net.rx`/`net.tx` per interface, `net.rx_total`/`net.tx_total` (D-092), the
//! `net.link_rate` the platform read, and the exact [`IfaceNet`] counter deltas (D-089).
//! The platform decides which interfaces exist, which count toward the totals, and how
//! wide its counters are.

use statglass_schema::SeriesKey;

use crate::counters::{CounterWidth, PartSum, counter_delta, span_secs};
use crate::{IfaceNet, Interval, SampleBuf};

/// Rates above this are a counter glitch, not traffic (about 400 Gbit/s).
pub(crate) const MAX_PLAUSIBLE_BPS: f64 = 50e9;

/// Cumulative rx bytes, tx bytes, rx packets, tx packets of one interface, or the
/// deltas between two readings.
pub(crate) type NetCounters = [u64; 4];

/// One reported interface on one sample.
pub(crate) struct NetIface<'a> {
    pub(crate) rx: &'a SeriesKey,
    pub(crate) tx: &'a SeriesKey,
    /// The previous sample's counters; [`emit`] replaces them with `cur`.
    pub(crate) prev: &'a mut Option<NetCounters>,
    /// This sample's counters, `None` when the interface is gone or unreadable: a
    /// reported part with no value.
    pub(crate) cur: Option<NetCounters>,
    /// Whether the interface counts toward the totals and [`IfaceNet`].
    pub(crate) counted: bool,
    /// `net.link_rate` in bits/s, when the platform read one this sample.
    pub(crate) link: Option<(&'a SeriesKey, f32)>,
}

/// The deltas since `prev`, `None` if any counter reset.
fn since(prev: &NetCounters, cur: &NetCounters, width: CounterWidth) -> Option<NetCounters> {
    Some([
        counter_delta(prev[0], cur[0], width)?,
        counter_delta(prev[1], cur[1], width)?,
        counter_delta(prev[2], cur[2], width)?,
        counter_delta(prev[3], cur[3], width)?,
    ])
}

/// Pushes one sample's rates, totals and link rates for `ifaces`, read at `now_ns`
/// (continuous ns) after a previous sample at `prev_ns` (0 for none). `totals` are the
/// `net.rx_total` and `net.tx_total` keys, emitted when any interface is counted.
///
/// The [`IfaceNet`] deltas cover the counted interfaces with a valid delta this sample.
/// An interface that reset or just appeared adds nothing: its bytes in this interval
/// are unknown, the same as the rate series' missing value. These are counter facts the
/// per-app remainder splits (D-089): an interface with no delta has no bytes to
/// attribute, so unlike `net.rx_total` the sum keeps the other interfaces' bytes instead
/// of turning into a gap (D-092).
pub(crate) fn emit<'a>(
    ifaces: impl Iterator<Item = NetIface<'a>>,
    totals: [&SeriesKey; 2],
    width: CounterWidth,
    prev_ns: u64,
    now_ns: u64,
    out: &mut SampleBuf,
) {
    let secs = span_secs(prev_ns, now_ns);
    let mut sum: NetCounters = [0; 4];
    let mut summed = false;
    let mut any_counted = false;
    let mut rx_total = PartSum::default();
    let mut tx_total = PartSum::default();
    for iface in ifaces {
        let mut rates = [None, None];
        if let (Some(prev), Some(cur), Some(secs)) = (*iface.prev, iface.cur, secs) {
            for (i, rate) in rates.iter_mut().enumerate() {
                *rate = counter_delta(prev[i], cur[i], width)
                    .map(|d| d as f64 / secs)
                    .filter(|r| *r <= MAX_PLAUSIBLE_BPS)
                    .map(|r| r as f32);
            }
            let plausible = |d: &NetCounters| (d[0].max(d[1]) as f64 / secs) <= MAX_PLAUSIBLE_BPS;
            if iface.counted
                && let Some(d) = since(&prev, &cur, width).filter(plausible)
            {
                for (s, d) in sum.iter_mut().zip(d) {
                    *s = s.saturating_add(d);
                }
                summed = true;
            }
        }
        let [rx, tx] = rates;
        if let Some(r) = rx {
            out.push(iface.rx, r);
        }
        if let Some(r) = tx {
            out.push(iface.tx, r);
        }
        if iface.counted {
            any_counted = true;
            rx_total.add(rx);
            tx_total.add(tx);
        }
        if let Some((key, bps)) = iface.link {
            out.push(key, bps);
        }
        *iface.prev = iface.cur;
    }
    if any_counted {
        let [rx_key, tx_key] = totals;
        if let Some(v) = rx_total.total() {
            out.push(rx_key, v);
        }
        if let Some(v) = tx_total.total() {
            out.push(tx_key, v);
        }
    }
    if summed {
        out.set_iface_net(IfaceNet {
            interval: Interval { prev_ns, now_ns },
            rx_bytes: sum[0],
            tx_bytes: sum[1],
            rx_packets: sum[2],
            tx_packets: sum[3],
        });
    }
}

#[cfg(test)]
mod tests {
    use statglass_schema::{Labels, MetricId};

    use super::*;

    #[test]
    fn deltas_wrap_per_counter_and_reset_as_a_whole() {
        let prev = [u64::from(u32::MAX) - 1023, 10, 100, 5];
        assert_eq!(
            since(&prev, &[1024, 2058, 160, 9], CounterWidth::Bits32),
            Some([2048, 2048, 60, 4]),
            "a 32-bit byte wrap"
        );
        assert_eq!(
            since(&prev, &[1024, 2058, 160, 9], CounterWidth::Bits64),
            None
        );
        assert_eq!(
            since(&[1 << 40, 0, 0, 0], &[0; 4], CounterWidth::Bits32),
            None
        );
    }

    const SEC: u64 = 1_000_000_000;

    struct Iface {
        rx: SeriesKey,
        tx: SeriesKey,
        prev: Option<NetCounters>,
        counted: bool,
    }

    fn iface(name: &str, counted: bool) -> Iface {
        let key = |id| SeriesKey::new(MetricId::from_static(id), Labels::single("iface", name));
        Iface {
            rx: key("net.rx"),
            tx: key("net.tx"),
            prev: None,
            counted,
        }
    }

    fn run(
        ifaces: &mut [Iface],
        cur: &[Option<NetCounters>],
        prev_ns: u64,
        now_ns: u64,
    ) -> SampleBuf {
        let bare = |id| SeriesKey::bare(MetricId::from_static(id));
        let (rx_total, tx_total) = (bare("net.rx_total"), bare("net.tx_total"));
        let mut out = SampleBuf::new();
        let parts = ifaces.iter_mut().zip(cur).map(|(i, &cur)| NetIface {
            rx: &i.rx,
            tx: &i.tx,
            prev: &mut i.prev,
            cur,
            counted: i.counted,
            link: None,
        });
        emit(
            parts,
            [&rx_total, &tx_total],
            CounterWidth::Bits64,
            prev_ns,
            now_ns,
            &mut out,
        );
        out
    }

    fn total(buf: &SampleBuf, id: &'static str) -> Option<f32> {
        buf.get(&SeriesKey::bare(MetricId::from_static(id)))
    }

    #[test]
    fn uncounted_interfaces_have_rates_but_stay_out_of_the_totals() {
        let mut ifaces = [iface("eth0", true), iface("tailscale0", false)];
        let first = run(
            &mut ifaces,
            &[Some([1_000, 100, 10, 1]), Some([0; 4])],
            0,
            SEC,
        );
        assert_eq!(total(&first, "net.rx_total"), None, "no baseline: a gap");
        assert!(first.iface_net().is_none());
        let buf = run(
            &mut ifaces,
            &[Some([3_000, 300, 30, 3]), Some([4_000, 0, 4, 0])],
            SEC,
            3 * SEC,
        );
        assert_eq!(buf.get(&ifaces[1].rx), Some(2_000.0));
        assert_eq!(total(&buf, "net.rx_total"), Some(1_000.0));
        assert_eq!(total(&buf, "net.tx_total"), Some(100.0));
        let net = buf.iface_net().unwrap();
        assert_eq!((net.rx_bytes, net.tx_packets), (2_000, 2));
        assert_eq!((net.interval.prev_ns, net.interval.now_ns), (SEC, 3 * SEC));
    }

    #[test]
    fn an_implausible_rate_is_dropped_and_a_vanished_interface_is_a_gap() {
        let mut ifaces = [iface("eth0", true)];
        run(&mut ifaces, &[Some([0; 4])], 0, SEC);
        let spike = run(&mut ifaces, &[Some([1 << 40, 0, 0, 0])], SEC, 2 * SEC);
        assert_eq!(spike.get(&ifaces[0].rx), None);
        assert_eq!(spike.get(&ifaces[0].tx), Some(0.0));
        assert!(
            spike.iface_net().is_none(),
            "the implausible delta is not summed"
        );
        let gone = run(&mut ifaces, &[None], 2 * SEC, 3 * SEC);
        assert_eq!(total(&gone, "net.tx_total"), None);
        assert_eq!(ifaces[0].prev, None);
    }

    #[test]
    fn no_counted_interface_means_no_totals() {
        let mut ifaces = [iface("tun0", false)];
        run(&mut ifaces, &[Some([0; 4])], 0, SEC);
        let buf = run(&mut ifaces, &[Some([10; 4])], SEC, 2 * SEC);
        assert_eq!(total(&buf, "net.rx_total"), None);
        assert_eq!(buf.get(&ifaces[0].rx), Some(10.0));
    }
}
