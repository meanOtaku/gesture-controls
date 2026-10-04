//! The shared core of the one-shot wrist movements (roll and pitch): a quick turn of at least a set angle about one
//! axis of the watch, within a short window, with little movement about the others.

use std::collections::VecDeque;

use crate::recipe::Axis;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FlickConfig {
    /// The watch axis the turn must be about.
    pub axis: Axis,
    /// How far it must turn, in degrees.
    pub min_angle_degrees: f64,
    /// ...within this long, in nanoseconds.
    pub window_ns: u64,
    /// The movement about other axes may be at most this fraction of the turn.
    pub max_off_axis_ratio: f64,
    /// After a flick, ignore further turning for this long (the turn back, mostly), in nanoseconds.
    pub lockout_ns: u64,
}

/// One step's rotation: its part about `axis` and the rest, in degrees.
fn step(previous: [f64; 4], current: [f64; 4], axis: Axis) -> (f64, f64) {
    // relative = conjugate(previous) * current
    let [pw, pi, pj, pk] = previous;
    let [cw, ci, cj, ck] = current;
    let w = pw * cw + pi * ci + pj * cj + pk * ck;
    let i = pw * ci - pi * cw - pj * ck + pk * cj;
    let j = pw * cj + pi * ck - pj * cw - pk * ci;
    let k = pw * ck - pi * cj + pj * ci - pk * cw;
    let component = match axis {
        Axis::Roll => i,
        Axis::Pitch => j,
        Axis::Yaw => k,
    };
    let wrap = |degrees: f64| (degrees + 540.0).rem_euclid(360.0) - 180.0;
    let twist = wrap(2.0 * component.atan2(w).to_degrees());
    let total = wrap(2.0 * (j * j + k * k + i * i).sqrt().atan2(w.abs()).to_degrees()).abs();
    let off_axis = (total * total - twist * twist).max(0.0).sqrt();
    (twist, off_axis)
}

#[derive(Debug)]
pub(crate) struct FlickDetector {
    config: FlickConfig,
    previous: Option<(u64, [f64; 4])>,
    /// `(time, cumulative twist, cumulative off-axis movement)` over the recent window.
    history: VecDeque<(u64, f64, f64)>,
    twist: f64,
    off_axis: f64,
    locked_until_ns: u64,
}

impl FlickDetector {
    pub fn new(config: FlickConfig) -> Self {
        Self {
            config,
            previous: None,
            history: VecDeque::new(),
            twist: 0.0,
            off_axis: 0.0,
            locked_until_ns: 0,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    /// Feeds one orientation `[w, x, y, z]`. Returns the signed net turn in degrees once, when a flick is recognised.
    pub fn observe(&mut self, at_ns: u64, orientation: [f64; 4]) -> Option<f64> {
        let norm = orientation.iter().map(|c| c * c).sum::<f64>().sqrt();
        if !orientation.iter().all(|c| c.is_finite()) || norm < 1e-9 {
            return None;
        }
        let unit = orientation.map(|c| c / norm);
        let Some((previous_ns, previous)) = self.previous else {
            self.previous = Some((at_ns, unit));
            self.history.push_back((at_ns, 0.0, 0.0));
            return None;
        };
        if at_ns <= previous_ns {
            return None;
        }
        let (twist, off_axis) = step(previous, unit, self.config.axis);
        self.previous = Some((at_ns, unit));
        self.twist += twist;
        self.off_axis += off_axis;
        self.history.push_back((at_ns, self.twist, self.off_axis));
        while self
            .history
            .front()
            .is_some_and(|(then, ..)| at_ns.saturating_sub(*then) > self.config.window_ns)
        {
            self.history.pop_front();
        }
        if at_ns < self.locked_until_ns {
            // Turning while locked out (the hand coming back) must not be counted once the lockout ends.
            self.history.clear();
            self.history.push_back((at_ns, self.twist, self.off_axis));
            return None;
        }
        // The biggest net turn from any moment in the window to now.
        let (start_twist, start_off_axis) =
            self.history
                .iter()
                .map(|&(_, t, o)| (t, o))
                .max_by(|a, b| {
                    (self.twist - a.0)
                        .abs()
                        .total_cmp(&(self.twist - b.0).abs())
                })?;
        let net = self.twist - start_twist;
        let off = self.off_axis - start_off_axis;
        if net.abs() >= self.config.min_angle_degrees
            && off <= self.config.max_off_axis_ratio * net.abs()
        {
            self.history.clear();
            self.history.push_back((at_ns, self.twist, self.off_axis));
            self.locked_until_ns = at_ns + self.config.lockout_ns;
            return Some(net);
        }
        None
    }
}
