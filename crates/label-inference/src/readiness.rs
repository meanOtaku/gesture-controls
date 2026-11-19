//! Whether a model can catch a pinch right now, for the user to see: after the wrist moved, or a stream stalled, a pinch
//! made too soon is lost, and nothing else shows it.
//!
//! Measured on the 100 Hz pinch CNN with real everyday motion spliced in before held-out pinches
//! (`docs/research/artifacts/readiness-2026-11/`): what decides it is how long the wrist has been calm. Calm under 0.5 s,
//! 53-77% of pinches were caught; 0.5-1 s, 84-93%; 1 s or more, 94-97%, as many as with no motion at all, even after 14 s
//! of heavy motion. So a model is:
//!
//! * [`Readiness::NoSignal`] while it cannot score at all: a stream has stopped, the buffer does not yet hold its history,
//!   or a gap in a stream lies inside its history (a CNN then has no inputs for 11 s), with how long until that clears;
//! * [`Readiness::Moving`] while the wrist is turning fast (the CNN's own rule, [`MOVING_GYRO`] over [`MOVING_RMS_NS`]);
//! * [`Readiness::Settling`] once it stops, until it has been calm [`READY_CALM_MS`];
//! * [`Readiness::Ready`] after that.
//!
//! A model of the pulse alone reads no motion: it is ready whenever it can score.

/// A gyroscope RMS above this, in rad/s, over [`MOVING_RMS_NS`], is the wrist turning fast (`cnn_input.MOVING_GYRO`).
pub const MOVING_GYRO: f64 = 1.0;
/// The window that RMS is taken over.
pub const MOVING_RMS_NS: u64 = 300_000_000;
/// How long the wrist must have been calm for a pinch to be caught as often as with no motion before it.
pub const READY_CALM_MS: u64 = 1_000;
/// Calm for less than this is still moving, as the user sees it.
pub const MOVING_NOW_MS: u64 = 300;
/// With [`MotionWarning::IgnoreShortJolts`], fast turning counts as the wrist moving only if it lasts longer than this.
/// A finger snap or a tap is one jolt: 95% of 268 snaps stayed above [`MOVING_GYRO`] for 0.4 s or less, and a pinch made
/// 0.25 s after one is caught as often as with no snap (`docs/research/artifacts/snap-readiness-2026-11`).
pub const SHORT_JOLT_MS: u64 = 400;

/// What the readiness light counts as the wrist moving (a setting). It changes only what is shown: never the models'
/// inputs, which leave fast turning out of their scaling by the same rule whatever this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MotionWarning {
    /// Any fast turning, however short (a snap included).
    #[default]
    AnyFastTurn,
    /// Fast turning that lasts longer than [`SHORT_JOLT_MS`]: arm movement, not a snap or a tap.
    IgnoreShortJolts,
    /// Never: the light only says whether the streams can be scored.
    Off,
}

impl MotionWarning {
    /// How long fast turning must last to count, or `None` when it never does.
    pub fn min_moving_ns(self) -> Option<u64> {
        match self {
            Self::AnyFastTurn => Some(0),
            Self::IgnoreShortJolts => Some(SHORT_JOLT_MS * 1_000_000),
            Self::Off => None,
        }
    }
}

/// Why a model cannot score at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoSignal {
    /// No samples of a stream it reads have arrived (the watch is not streaming them).
    Waiting,
    /// A stream it reads has stopped arriving.
    Stale,
    /// The buffer does not yet reach back as far as its history (just connected, or just loaded).
    WarmingUp,
    /// A stream it reads skipped more than its largest gap inside its history.
    Gap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    /// The wrist is turning fast; `ready_in_ms` is how long until ready if it stopped now.
    Moving {
        ready_in_ms: u64,
    },
    /// The wrist stopped; ready in `ready_in_ms` if it stays calm.
    Settling {
        ready_in_ms: u64,
    },
    /// It cannot score; `ready_in_ms` is how long until that clears by itself, when that can be known.
    NoSignal {
        why: NoSignal,
        ready_in_ms: Option<u64>,
    },
}

impl Readiness {
    /// The state's name, as the app shows and compares it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Moving { .. } => "moving",
            Self::Settling { .. } => "settling",
            Self::NoSignal {
                why: NoSignal::Waiting,
                ..
            } => "waiting",
            Self::NoSignal {
                why: NoSignal::Stale,
                ..
            } => "stale",
            Self::NoSignal {
                why: NoSignal::WarmingUp,
                ..
            } => "warmingUp",
            Self::NoSignal {
                why: NoSignal::Gap, ..
            } => "gap",
        }
    }

    /// How long until ready, when that can be known (none for Ready, or a stream that stopped).
    pub fn ready_in_ms(self) -> Option<u64> {
        match self {
            Self::Ready => None,
            Self::Moving { ready_in_ms } | Self::Settling { ready_in_ms } => Some(ready_in_ms),
            Self::NoSignal { ready_in_ms, .. } => ready_in_ms,
        }
    }
}

/// How long the wrist has been calm at `now` (the newest sample's time), from gyroscope samples `(time, [x, y, z])` in time
/// order: since the last moment the RMS over the [`MOVING_RMS_NS`] ending at a sample was above [`MOVING_GYRO`]. At least
/// `horizon_ns` when nothing in the samples was moving.
pub fn calm_ns(samples: &[(u64, [f64; 3])], horizon_ns: u64) -> u64 {
    calm_ns_ignoring(samples, horizon_ns, 0)
}

/// [`calm_ns`], counting only fast turning that lasted longer than `min_moving_ns` (from the first to the last sample of
/// a run whose RMS is above [`MOVING_GYRO`]); with 0, any.
pub fn calm_ns_ignoring(samples: &[(u64, [f64; 3])], horizon_ns: u64, min_moving_ns: u64) -> u64 {
    let Some(&(now, _)) = samples.last() else {
        return horizon_ns;
    };
    let mut total = Vec::with_capacity(samples.len() + 1);
    total.push(0.0);
    for (_, g) in samples {
        total.push(total.last().unwrap() + g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    }
    let mut begin = 0;
    let mut last_moving = None;
    // The run of moving samples under way: when it began and its latest sample.
    let mut run: Option<(u64, u64)> = None;
    let counts = |(first, last): (u64, u64)| last.saturating_sub(first) >= min_moving_ns;
    for (end, &(at, _)) in samples.iter().enumerate() {
        while samples[begin].0 + MOVING_RMS_NS < at {
            begin += 1;
        }
        let count = (end + 1 - begin) as f64;
        if (total[end + 1] - total[begin]) / count > MOVING_GYRO * MOVING_GYRO {
            run = Some((run.map_or(at, |(first, _)| first), at));
        } else if let Some(ended) = run.take()
            && counts(ended)
        {
            last_moving = Some(ended.1);
        }
    }
    if let Some(open) = run
        && counts(open)
    {
        last_moving = Some(open.1);
    }
    last_moving.map_or(horizon_ns.max(now.saturating_sub(samples[0].0)), |at| {
        now - at
    })
}

/// From how long the wrist has been calm, whether a motion model is ready (it can score: the caller checked).
pub fn from_calm(calm_ns: u64) -> Readiness {
    let calm_ms = calm_ns / 1_000_000;
    if calm_ms >= READY_CALM_MS {
        Readiness::Ready
    } else if calm_ms < MOVING_NOW_MS {
        Readiness::Moving {
            ready_in_ms: READY_CALM_MS - calm_ms,
        }
    } else {
        Readiness::Settling {
            ready_in_ms: READY_CALM_MS - calm_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    fn trace(moving_until_ms: u64, end_ms: u64) -> Vec<(u64, [f64; 3])> {
        (0..=end_ms / 10)
            .map(|k| {
                let at = k * 10;
                (
                    at * MS,
                    if at < moving_until_ms {
                        [3.0, 0.0, 0.0]
                    } else {
                        [0.02, 0.01, 0.0]
                    },
                )
            })
            .collect()
    }

    #[test]
    fn calm_is_measured_from_when_the_fast_turning_left_the_rms_window() {
        // Turning at 3 rad/s until 2 s: the 0.3 s RMS stays above 1 rad/s until about 2.27 s.
        let calm = calm_ns(&trace(2_000, 3_000), 0) / MS;
        assert!((700..=760).contains(&calm), "{calm}");
        assert_eq!(calm_ns(&trace(0, 3_000), 5_000 * MS) / MS, 5_000);
    }

    /// Turning at 3 rad/s from `at_ms` for `lasting_ms`, calm around it.
    fn jolt(at_ms: u64, lasting_ms: u64, end_ms: u64) -> Vec<(u64, [f64; 3])> {
        (0..=end_ms / 10)
            .map(|k| {
                let t = k * 10;
                let turning = t >= at_ms && t < at_ms + lasting_ms;
                (
                    t * MS,
                    if turning {
                        [3.0, 0.0, 0.0]
                    } else {
                        [0.02, 0.01, 0.0]
                    },
                )
            })
            .collect()
    }

    #[test]
    fn a_jolt_as_short_as_a_snap_counts_only_when_every_fast_turn_does() {
        // A 0.1 s jolt at 1 s keeps the 0.3 s RMS above 1 rad/s for about 0.3 s, as a snap does.
        let snap = jolt(1_000, 100, 1_600);
        let any = calm_ns_ignoring(&snap, 0, 0) / MS;
        assert!(any < MOVING_NOW_MS, "{any}");
        assert_eq!(calm_ns_ignoring(&snap, 0, 0), calm_ns(&snap, 0));
        let ignoring = calm_ns_ignoring(&snap, 2_000 * MS, SHORT_JOLT_MS * MS) / MS;
        assert_eq!(ignoring, 2_000, "a snap is not the wrist moving");
        // Arm movement, a second of it, still is.
        let arm = jolt(500, 1_000, 1_800);
        assert!(calm_ns_ignoring(&arm, 2_000 * MS, SHORT_JOLT_MS * MS) / MS < MOVING_NOW_MS);
        assert_eq!(MotionWarning::default(), MotionWarning::AnyFastTurn);
        assert_eq!(MotionWarning::Off.min_moving_ns(), None);
    }

    #[test]
    fn a_second_of_calm_is_ready() {
        assert_eq!(from_calm(1_200 * MS), Readiness::Ready);
        assert_eq!(
            from_calm(600 * MS),
            Readiness::Settling { ready_in_ms: 400 }
        );
        assert_eq!(from_calm(100 * MS), Readiness::Moving { ready_in_ms: 900 });
        assert_eq!(from_calm(100 * MS).name(), "moving");
    }
}
