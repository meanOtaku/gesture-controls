use serde::{Deserialize, Serialize};

use crate::recipe::Hold;

/// Which of the built-in, rule-based wrist gestures are switched on. Turning one off means nothing recognises it, so a
/// recipe that uses it never fires; the usual reason is that a trained model now handles that gesture instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HeuristicGestures {
    pub shake: bool,
    pub swipe: bool,
    pub tap: bool,
    pub roll: bool,
    pub pitch: bool,
}

impl Default for HeuristicGestures {
    fn default() -> Self {
        Self {
            shake: true,
            swipe: true,
            tap: true,
            roll: true,
            pitch: true,
        }
    }
}

impl HeuristicGestures {
    /// Whether a recipe step using `hold` can ever be recognised. The STEM button is not a heuristic
    /// wrist gesture, so it is never switched off here.
    pub fn allows(&self, hold: Hold) -> bool {
        match hold {
            Hold::StemButton => true,
            Hold::Shake => self.shake,
            Hold::SwipeLeft | Hold::SwipeRight | Hold::SwipeUp | Hold::SwipeDown => self.swipe,
            Hold::Tap | Hold::DoubleTap => self.tap,
            Hold::RollClockwise | Hold::RollCounterClockwise => self.roll,
            Hold::PitchUp | Hold::PitchDown => self.pitch,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_is_on_by_default_and_each_switch_covers_its_own_steps() {
        let all = HeuristicGestures::default();
        for hold in [
            Hold::Shake,
            Hold::SwipeLeft,
            Hold::DoubleTap,
            Hold::RollClockwise,
            Hold::PitchDown,
        ] {
            assert!(all.allows(hold));
        }
        let no_swipes = HeuristicGestures {
            swipe: false,
            ..all
        };
        assert!(!no_swipes.allows(Hold::SwipeUp) && !no_swipes.allows(Hold::SwipeRight));
        assert!(no_swipes.allows(Hold::Tap) && no_swipes.allows(Hold::Shake));
        let none = HeuristicGestures {
            shake: false,
            swipe: false,
            tap: false,
            roll: false,
            pitch: false,
        };
        assert!(
            !none.allows(Hold::DoubleTap)
                && !none.allows(Hold::RollCounterClockwise)
                && !none.allows(Hold::PitchUp)
        );
        // A pinch and the STEM button are not wrist heuristics.
        assert!(none.allows(Hold::StemButton));
    }

    #[test]
    fn a_missing_or_partial_setting_means_on() {
        let partial: HeuristicGestures = serde_json::from_str("{\"tap\": false}").unwrap();
        assert!(!partial.tap && partial.shake && partial.swipe && partial.roll && partial.pitch);
        let empty: HeuristicGestures = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, HeuristicGestures::default());
    }
}
