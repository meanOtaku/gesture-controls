//! Puts a watch stream's own timestamps on the desktop's receive clock.
//!
//! A sample reaches the desktop some time after it was taken, so `received - taken` is the offset between the two clocks
//! plus a delay that is never negative. The smallest value over the last 30 seconds is the best estimate of the offset (the
//! sample that travelled fastest; the window lets a slow drift be followed), and every sample is placed with it.
//!
//! Stamping each sample with its own arrival instead, as before, put all the motion samples of one batch at the same
//! instant (the watch sends them together, several per message), while the trainer spaces them by their real timestamps;
//! a model saw squeezed windows live that it never saw in training. The recorder places pulse samples the same way
//! (`SourceClockMap` in the desktop's telemetry store), so recordings and live windows agree.

use std::collections::VecDeque;

const WINDOW_NS: i128 = 30_000_000_000;
/// A gap this much bigger than the estimate is not a slow delivery but a clock that jumped: start again from it.
const JUMP_NS: i128 = 1_000_000_000;

#[derive(Debug, Default)]
pub(crate) struct ClockMap {
    /// The recent `(received, received - taken)` pairs whose difference could still be the smallest, oldest first, with
    /// differences increasing.
    candidates: VecDeque<(i128, i128)>,
}

impl ClockMap {
    /// `taken_ns` is a sample's own timestamp; `received_ns` is when it reached the desktop.
    pub(crate) fn observe(&mut self, taken_ns: u64, received_ns: u64) {
        let (taken, received) = (i128::from(taken_ns), i128::from(received_ns));
        let delta = received - taken;
        if self
            .offset()
            .is_some_and(|current| delta - current > JUMP_NS)
        {
            self.candidates.clear();
        }
        while self.candidates.back().is_some_and(|&(_, d)| d >= delta) {
            self.candidates.pop_back();
        }
        self.candidates.push_back((received, delta));
        while self
            .candidates
            .front()
            .is_some_and(|&(at, _)| at < received - WINDOW_NS)
        {
            self.candidates.pop_front();
        }
    }

    fn offset(&self) -> Option<i128> {
        self.candidates.front().map(|&(_, delta)| delta)
    }

    /// `taken_ns` on the receive clock, or `None` before anything was observed. Never later than the arrival of any
    /// sample observed in the last 30 seconds, since the offset is the smallest of their differences.
    pub(crate) fn map(&self, taken_ns: u64) -> Option<u64> {
        let at = i128::from(taken_ns) + self.offset()?;
        Some(u64::try_from(at.max(0)).unwrap_or(u64::MAX))
    }

    pub(crate) fn reset(&mut self) {
        self.candidates.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    #[test]
    fn knows_nothing_before_the_first_sample() {
        assert_eq!(ClockMap::default().map(5 * MS), None);
    }

    #[test]
    fn a_batch_delivered_at_once_keeps_its_samples_spacing() {
        let mut clock = ClockMap::default();
        // Five motion samples 20 ms apart, all arriving together 7 ms after the newest was taken.
        for i in 0..5 {
            clock.observe(1_000 * MS + i * 20 * MS, 50_087 * MS);
        }
        let placed: Vec<u64> = (0..5)
            .map(|i| clock.map(1_000 * MS + i * 20 * MS).unwrap())
            .collect();
        assert_eq!(
            placed,
            vec![
                50_007 * MS,
                50_027 * MS,
                50_047 * MS,
                50_067 * MS,
                50_087 * MS
            ]
        );
    }

    #[test]
    fn keeps_the_fastest_delivery_and_follows_a_faster_one_at_once() {
        let mut clock = ClockMap::default();
        clock.observe(100 * MS, 1_110 * MS);
        clock.observe(200 * MS, 1_250 * MS);
        assert_eq!(clock.map(200 * MS), Some(1_210 * MS));
        clock.observe(300 * MS, 1_302 * MS);
        assert_eq!(clock.map(300 * MS), Some(1_302 * MS));
    }

    #[test]
    fn forgets_a_minimum_older_than_the_window() {
        let mut clock = ClockMap::default();
        clock.observe(0, 1_000 * MS);
        clock.observe(31_000 * MS, 32_005 * MS);
        assert_eq!(clock.map(31_000 * MS), Some(32_005 * MS));
    }

    #[test]
    fn starts_again_when_the_watch_clock_jumps_back() {
        let mut clock = ClockMap::default();
        clock.observe(10_000 * MS, 11_000 * MS);
        clock.observe(5_000 * MS, 11_100 * MS);
        assert_eq!(clock.map(5_000 * MS), Some(11_100 * MS));
    }

    #[test]
    fn reset_forgets_the_estimate() {
        let mut clock = ClockMap::default();
        clock.observe(1, 2);
        clock.reset();
        assert_eq!(clock.map(1), None);
    }
}
