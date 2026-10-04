//! Carries out brightness and scroll changes asked for by recipes.
//!
//! Both are relative: a recipe's device says "move by this fraction of the range", and fractions arriving faster
//! than the OS can be driven are added together (never dropped) and applied in one go. The native calls can be
//! slow (brightness presses keys through a subprocess), so they run on one worker thread, never on the watch loop.

use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use automation::Action;
use serde::Serialize;
use system_control::{
    Accumulator, BrightnessController, ControlError, MAX_PIXELS_PER_CALL, ScrollController,
    platform_brightness_controller, platform_scroll_controller,
};
use tauri::{AppHandle, Emitter};
use tracing::warn;

pub const ACTION_ERROR_EVENT: &str = "automation-action-error";

/// How many pixels a full-range change scrolls: a recipe's 0.1 is 100 pixels, a few lines.
pub const SCROLL_PIXELS_PER_FULL_RANGE: f64 = 1000.0;
/// The most brightness steps one call presses, so a glitch cannot slam the screen to an extreme.
const MAX_BRIGHTNESS_STEPS_PER_CALL: i32 = 8;
/// Pause after a scroll call so a fast stream becomes smooth, evenly spaced events.
const SCROLL_PACING: Duration = Duration::from_millis(8);

/// Sent to the UI when an action cannot be carried out, once per run of failures.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionError {
    pub action: Action,
    pub message: String,
}

enum Command {
    Delta(Action, f64),
    Reset(Action),
}

/// The part with the logic, independent of threads and of the real machine, so it can be tested.
pub struct Core {
    brightness: Box<dyn BrightnessController>,
    scroll: Box<dyn ScrollController>,
    brightness_acc: Accumulator,
    scroll_acc: Accumulator,
}

impl Core {
    pub fn new(
        brightness: Box<dyn BrightnessController>,
        scroll: Box<dyn ScrollController>,
    ) -> Self {
        Self {
            brightness,
            scroll,
            brightness_acc: Accumulator::default(),
            scroll_acc: Accumulator::default(),
        }
    }

    /// Applies a change of `fraction` of the full range to `action`. Volume is handled by the overlay, not here.
    pub fn deliver(&mut self, action: Action, fraction: f64) -> Result<(), ControlError> {
        match action {
            Action::Brightness => {
                let steps = self
                    .brightness_acc
                    .take(fraction * 100.0, self.brightness.step_percent())
                    .clamp(
                        -MAX_BRIGHTNESS_STEPS_PER_CALL,
                        MAX_BRIGHTNESS_STEPS_PER_CALL,
                    );
                if steps == 0 {
                    return Ok(());
                }
                self.brightness.adjust_steps(steps)
            }
            Action::Scroll => {
                let pixels = self
                    .scroll_acc
                    .take(fraction * SCROLL_PIXELS_PER_FULL_RANGE, 1.0)
                    .clamp(-MAX_PIXELS_PER_CALL, MAX_PIXELS_PER_CALL);
                if pixels == 0 {
                    return Ok(());
                }
                self.scroll.scroll_pixels(pixels)
            }
            Action::Volume => Ok(()),
        }
    }

    /// An interaction ended: drop any change still being carried so it cannot leak into the next one.
    pub fn reset(&mut self, action: Action) {
        match action {
            Action::Brightness => self.brightness_acc.clear(),
            Action::Scroll => self.scroll_acc.clear(),
            Action::Volume => {}
        }
    }
}

#[derive(Default)]
pub struct Actuators {
    sender: OnceLock<Mutex<Sender<Command>>>,
}

impl Actuators {
    fn send(&self, app: &AppHandle, command: Command) {
        let sender = self.sender.get_or_init(|| {
            let (tx, rx) = channel::<Command>();
            let app = app.clone();
            let spawned = std::thread::Builder::new()
                .name("action-writer".to_string())
                .spawn(move || run_worker(app, rx));
            if let Err(error) = spawned {
                warn!(%error, "failed to start the action writer; brightness and scroll are unavailable");
            }
            Mutex::new(tx)
        });
        if let Ok(sender) = sender.lock() {
            let _ = sender.send(command);
        }
    }

    pub fn delta(&self, app: &AppHandle, action: Action, fraction: f64) {
        self.send(app, Command::Delta(action, fraction));
    }

    pub fn reset(&self, app: &AppHandle, action: Action) {
        self.send(app, Command::Reset(action));
    }
}

fn run_worker(app: AppHandle, rx: std::sync::mpsc::Receiver<Command>) {
    let mut core = Core::new(
        platform_brightness_controller(),
        platform_scroll_controller(),
    );
    let mut failing: Option<Action> = None;
    while let Ok(first) = rx.recv() {
        // Everything already waiting is folded into one change per action, so a backlog never replays.
        let mut pending: Vec<(Action, f64)> = Vec::new();
        let handle =
            |command: Command, core: &mut Core, pending: &mut Vec<(Action, f64)>| match command {
                Command::Delta(action, fraction) => {
                    match pending.iter_mut().find(|(a, _)| *a == action) {
                        Some((_, total)) => *total += fraction,
                        None => pending.push((action, fraction)),
                    }
                }
                Command::Reset(action) => {
                    pending.retain(|(a, _)| *a != action);
                    core.reset(action);
                }
            };
        handle(first, &mut core, &mut pending);
        while let Ok(next) = rx.try_recv() {
            handle(next, &mut core, &mut pending);
        }
        for (action, fraction) in pending {
            match core.deliver(action, fraction) {
                Ok(()) => {
                    if failing == Some(action) {
                        failing = None;
                    }
                }
                Err(error) => {
                    if failing != Some(action) {
                        failing = Some(action);
                        warn!(%error, ?action, "failed to carry out a recipe's action");
                        let _ = app.emit(
                            ACTION_ERROR_EVENT,
                            ActionError {
                                action,
                                message: error.to_string(),
                            },
                        );
                    }
                }
            }
            if action == Action::Scroll {
                std::thread::sleep(SCROLL_PACING);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    struct Log {
        brightness: Vec<i32>,
        scroll: Vec<i32>,
    }

    struct FakeBrightness(Arc<Mutex<Log>>, f64);
    struct FakeScroll(Arc<Mutex<Log>>);

    impl BrightnessController for FakeBrightness {
        fn step_percent(&self) -> f64 {
            self.1
        }
        fn adjust_steps(&self, steps: i32) -> Result<(), ControlError> {
            self.0.lock().unwrap().brightness.push(steps);
            Ok(())
        }
    }

    impl ScrollController for FakeScroll {
        fn scroll_pixels(&self, pixels: i32) -> Result<(), ControlError> {
            self.0.lock().unwrap().scroll.push(pixels);
            Ok(())
        }
    }

    fn core(step_percent: f64) -> (Core, Arc<Mutex<Log>>) {
        let log = Arc::new(Mutex::new(Log::default()));
        (
            Core::new(
                Box::new(FakeBrightness(log.clone(), step_percent)),
                Box::new(FakeScroll(log.clone())),
            ),
            log,
        )
    }

    #[test]
    fn scroll_turns_fractions_into_whole_pixels_without_losing_any() {
        let (mut core, log) = core(1.0);
        for _ in 0..10 {
            core.deliver(Action::Scroll, 0.0004).unwrap(); // 0.4 px each
        }
        // Ten 0.4 px changes are four whole pixels in total, however they were split up.
        assert_eq!(log.lock().unwrap().scroll.iter().sum::<i32>(), 4);
        core.deliver(Action::Scroll, -0.1).unwrap();
        assert_eq!(*log.lock().unwrap().scroll.last().unwrap(), -100);
    }

    #[test]
    fn brightness_moves_in_whole_steps_of_what_the_platform_can_do() {
        // A key-press platform steps by a sixteenth: 10 percent of range is one step with a remainder carried.
        let (mut core, log) = core(6.25);
        core.deliver(Action::Brightness, 0.10).unwrap();
        assert_eq!(log.lock().unwrap().brightness, vec![1]);
        core.deliver(Action::Brightness, 0.03).unwrap(); // 3.75 + 3 carried = 6.75: another step
        assert_eq!(log.lock().unwrap().brightness, vec![1, 1]);
        core.deliver(Action::Brightness, -0.5).unwrap();
        assert_eq!(*log.lock().unwrap().brightness.last().unwrap(), -7);
    }

    #[test]
    fn a_glitch_is_capped_and_a_reset_drops_the_carried_remainder() {
        let (mut core, log) = core(1.0);
        core.deliver(Action::Scroll, 50.0).unwrap();
        assert_eq!(log.lock().unwrap().scroll, vec![MAX_PIXELS_PER_CALL]);
        core.deliver(Action::Brightness, 5.0).unwrap();
        assert_eq!(
            log.lock().unwrap().brightness,
            vec![MAX_BRIGHTNESS_STEPS_PER_CALL]
        );

        core.deliver(Action::Scroll, 0.0009).unwrap(); // 0.9 px carried
        core.reset(Action::Scroll);
        core.deliver(Action::Scroll, 0.0002).unwrap();
        assert_eq!(
            log.lock().unwrap().scroll.len(),
            1,
            "the carried 0.9 px must not leak into the next gesture"
        );
    }

    #[test]
    fn volume_is_not_this_modules_job() {
        let (mut core, log) = core(1.0);
        core.deliver(Action::Volume, 0.5).unwrap();
        assert!(log.lock().unwrap().brightness.is_empty() && log.lock().unwrap().scroll.is_empty());
    }
}
