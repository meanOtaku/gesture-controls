//! A "latest value wins" mailbox between a fast producer and a slow writer.
//!
//! Wrist rotation produces an *absolute* volume target on every orientation sample (up to
//! 200 Hz), and applying one means a blocking native call (on macOS an `osascript` process,
//! measured at 130-190 ms). Making the producer wait for each call blocked the watch event
//! loop, which also carries PPG inference, the button release and every disconnect, for most
//! of the time the wrist was moving. Since each target supersedes the last, the producer can
//! instead drop its newest target here and carry on; the writer always takes the most recent
//! one, and intermediate targets are skipped rather than queued.
//!
//! Each target is tagged with the *epoch* of the interaction that produced it, so a write
//! that was waiting when the interaction ended (or a new one began) is recognizably stale.
//! The mailbox itself only carries values; deciding what is stale is the caller's job.

use std::sync::{Condvar, Mutex};

/// One pending volume write.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PendingWrite {
    pub target_percent: f32,
    pub epoch: u64,
}

#[derive(Default)]
pub(crate) struct LatestWriteSlot {
    pending: Mutex<Option<PendingWrite>>,
    wake: Condvar,
}

impl LatestWriteSlot {
    /// Replaces any pending write with `write`, waking the writer only when something
    /// actually changed (a stream of identical targets must not wake it 200 times a second).
    pub(crate) fn submit(&self, write: PendingWrite) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        if *pending != Some(write) {
            *pending = Some(write);
            self.wake.notify_one();
        }
    }

    /// Drops any pending write (the target it carried is no longer wanted).
    pub(crate) fn clear(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            *pending = None;
        }
    }

    /// Blocks until a write is pending, then takes it. `None` only if the lock is poisoned,
    /// which ends the writer rather than letting it spin.
    pub(crate) fn take_blocking(&self) -> Option<PendingWrite> {
        let mut pending = self.pending.lock().ok()?;
        loop {
            if let Some(write) = pending.take() {
                return Some(write);
            }
            pending = self.wake.wait(pending).ok()?;
        }
    }

    /// A newer pending write if one arrived while the caller waited, else the `current` one.
    /// Used after pacing sleeps so the write that goes out is the freshest.
    pub(crate) fn refresh(&self, current: PendingWrite) -> PendingWrite {
        match self.pending.lock() {
            Ok(mut pending) => pending.take().unwrap_or(current),
            Err(_) => current,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    fn write(target_percent: f32, epoch: u64) -> PendingWrite {
        PendingWrite {
            target_percent,
            epoch,
        }
    }

    #[test]
    fn the_newest_target_replaces_older_ones() {
        let slot = LatestWriteSlot::default();
        slot.submit(write(10.0, 1));
        slot.submit(write(20.0, 1));
        slot.submit(write(30.0, 1));
        assert_eq!(slot.take_blocking(), Some(write(30.0, 1)));
    }

    #[test]
    fn clear_drops_a_pending_write_so_a_stale_target_is_never_written() {
        let slot = Arc::new(LatestWriteSlot::default());
        slot.submit(write(50.0, 1));
        slot.clear();
        // Nothing is pending now: the writer must keep waiting rather than receive 50.0.
        let writer = {
            let slot = Arc::clone(&slot);
            std::thread::spawn(move || slot.take_blocking())
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(!writer.is_finished(), "the writer must still be blocked");
        slot.submit(write(60.0, 2));
        assert_eq!(writer.join().unwrap(), Some(write(60.0, 2)));
    }

    #[test]
    fn a_blocked_writer_wakes_when_a_target_arrives() {
        let slot = Arc::new(LatestWriteSlot::default());
        let writer = {
            let slot = Arc::clone(&slot);
            std::thread::spawn(move || slot.take_blocking())
        };
        std::thread::sleep(Duration::from_millis(20));
        slot.submit(write(42.0, 7));
        assert_eq!(writer.join().unwrap(), Some(write(42.0, 7)));
    }

    #[test]
    fn taking_empties_the_slot() {
        let slot = LatestWriteSlot::default();
        slot.submit(write(1.0, 1));
        assert_eq!(slot.take_blocking(), Some(write(1.0, 1)));
        // A refresh now has nothing newer, so it returns what it was given.
        assert_eq!(slot.refresh(write(9.0, 1)), write(9.0, 1));
    }

    #[test]
    fn refresh_prefers_a_target_that_arrived_during_the_wait() {
        let slot = LatestWriteSlot::default();
        let taken = write(10.0, 1);
        slot.submit(write(11.0, 1));
        slot.submit(write(12.0, 1));
        assert_eq!(slot.refresh(taken), write(12.0, 1));
        assert_eq!(slot.refresh(taken), taken, "the newer one was consumed");
    }

    #[test]
    fn the_epoch_travels_with_the_target() {
        let slot = LatestWriteSlot::default();
        slot.submit(write(10.0, 3));
        assert_eq!(slot.take_blocking().unwrap().epoch, 3);
    }
}
