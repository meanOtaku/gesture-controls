/// Turns a stream of small fractional changes into whole units, carrying the remainder forward so nothing is
/// lost or double counted: 0.4 + 0.4 + 0.4 of a unit is one unit with 0.2 left over.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Accumulator {
    remainder: f64,
}

impl Accumulator {
    /// Adds `amount` and returns how many whole `quantum`s are now due (negative for the other direction).
    /// A non-finite amount or quantum is ignored.
    pub fn take(&mut self, amount: f64, quantum: f64) -> i32 {
        if !amount.is_finite() || !quantum.is_finite() || quantum <= 0.0 {
            return 0;
        }
        self.remainder += amount;
        let whole = (self.remainder / quantum).trunc();
        self.remainder -= whole * quantum;
        whole.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
    }

    /// Forgets what is carried, when the interaction that produced it ended.
    pub fn clear(&mut self) {
        self.remainder = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_changes_add_up_to_whole_units_without_loss() {
        let mut acc = Accumulator::default();
        assert_eq!(acc.take(0.4, 1.0), 0);
        assert_eq!(acc.take(0.4, 1.0), 0);
        assert_eq!(acc.take(0.4, 1.0), 1);
        assert_eq!(acc.take(0.8, 1.0), 1); // 0.2 carried + 0.8
        assert_eq!(acc.take(0.0, 1.0), 0);
    }

    #[test]
    fn both_directions_cancel_and_large_amounts_give_many_units() {
        let mut acc = Accumulator::default();
        assert_eq!(acc.take(0.7, 1.0), 0);
        assert_eq!(acc.take(-0.7, 1.0), 0);
        assert_eq!(acc.take(-3.5, 1.0), -3);
        assert_eq!(acc.take(-0.5, 1.0), -1);
        assert_eq!(acc.take(25.0, 6.25), 4);
    }

    #[test]
    fn clearing_drops_the_carried_remainder_and_bad_input_is_ignored() {
        let mut acc = Accumulator::default();
        acc.take(0.9, 1.0);
        acc.clear();
        assert_eq!(acc.take(0.2, 1.0), 0);
        assert_eq!(acc.take(f64::NAN, 1.0), 0);
        assert_eq!(acc.take(1.0, 0.0), 0);
        assert_eq!(acc.take(1.0, f64::INFINITY), 0);
    }
}
