//! Carries out brightness, scroll and pointer changes asked for by recipes.
//!
//! Both are relative: a recipe's device says "move by this fraction of the range", and fractions arriving faster
//! than the OS can be driven are added together (never dropped) and applied in one go. The native calls can be
//! slow (brightness presses keys through a subprocess), so they run on one worker thread, never on the watch loop.

use std::collections::HashMap;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use automation::{Action, PointerEvent};
use serde::Serialize;
use system_control::{
    Accumulator, BrightnessController, ControlError, KeyCombo, MAX_PIXELS_PER_CALL,
    MAX_POINTER_PIXELS_PER_CALL, MediaController, MediaKey, PointerController, ScrollController,
    ShortcutController, platform_brightness_controller, platform_media_controller,
    platform_pointer_controller, platform_scroll_controller, platform_shortcut_controller,
};
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

pub const ACTION_ERROR_EVENT: &str = "automation-action-error";

/// How many pixels a full-range change scrolls: a recipe's 0.1 is 100 pixels, a few lines.
pub const SCROLL_PIXELS_PER_FULL_RANGE: f64 = 1000.0;
/// The most brightness steps one call presses, so a glitch cannot slam the screen to an extreme.
const MAX_BRIGHTNESS_STEPS_PER_CALL: i32 = 8;
/// A key-like action ignores a second firing this soon after the first, so a flickering pinch cannot skip tracks.
const KEY_COOLDOWN: Duration = Duration::from_millis(500);
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
    /// A trigger recipe fired.
    Press(Action),
    /// A keyboard-shortcut recipe fired: press these keys.
    Shortcut(String),
    /// Pointer mode moved the pointer or changed the button.
    Pointer(Vec<PointerEvent>),
    /// Read the brightness and tell the overlay.
    ReadBrightness,
}

/// The screen size assumed when the platform cannot say, for moves given as fractions of the screen.
const FALLBACK_SCREEN_SIZE: (f64, f64) = (1440.0, 900.0);

/// Merges runs of moves into one, keeping every click and button change in its place, so a backlog of moves never
/// replays one by one and a click never lands before the move that came first.
pub fn merge_pointer_events(events: impl IntoIterator<Item = PointerEvent>) -> Vec<PointerEvent> {
    let mut merged: Vec<PointerEvent> = Vec::new();
    for event in events {
        match (merged.last_mut(), event) {
            (Some(PointerEvent::Move { dx, dy }), PointerEvent::Move { dx: x, dy: y })
            | (
                Some(PointerEvent::MoveScreen { dx, dy }),
                PointerEvent::MoveScreen { dx: x, dy: y },
            ) => {
                *dx += x;
                *dy += y;
            }
            _ => merged.push(event),
        }
    }
    merged
}

/// Presses keyboard shortcuts, each at most once per [`KEY_COOLDOWN`].
pub struct ShortcutPresser {
    controller: Box<dyn ShortcutController>,
    last_pressed: HashMap<KeyCombo, Instant>,
}

impl ShortcutPresser {
    pub fn new(controller: Box<dyn ShortcutController>) -> Self {
        Self {
            controller,
            last_pressed: HashMap::new(),
        }
    }

    /// Presses `keys` (as a recipe stores them), or `None` when the same shortcut was pressed a moment ago.
    pub fn press(&mut self, keys: &str, now: Instant) -> Option<Result<(), ControlError>> {
        let combo: KeyCombo = match keys.parse() {
            Ok(combo) => combo,
            Err(error) => return Some(Err(ControlError::Backend(format!("'{keys}': {error}")))),
        };
        if self
            .last_pressed
            .get(&combo)
            .is_some_and(|previous| now.saturating_duration_since(*previous) < KEY_COOLDOWN)
        {
            return None;
        }
        self.last_pressed.insert(combo, now);
        Some(self.controller.press(&combo))
    }
}

/// The part with the logic, independent of threads and of the real machine, so it can be tested.
pub struct Core {
    brightness: Box<dyn BrightnessController>,
    scroll: Box<dyn ScrollController>,
    media: Box<dyn MediaController>,
    pointer: Box<dyn PointerController>,
    brightness_acc: Accumulator,
    scroll_acc: Accumulator,
    pointer_x: Accumulator,
    pointer_y: Accumulator,
    /// The left button is down because pointer mode pressed it.
    pointer_down: bool,
    last_pressed: HashMap<Action, Instant>,
}

impl Core {
    pub fn new(
        brightness: Box<dyn BrightnessController>,
        scroll: Box<dyn ScrollController>,
        media: Box<dyn MediaController>,
        pointer: Box<dyn PointerController>,
    ) -> Self {
        Self {
            brightness,
            scroll,
            media,
            pointer,
            brightness_acc: Accumulator::default(),
            scroll_acc: Accumulator::default(),
            pointer_x: Accumulator::default(),
            pointer_y: Accumulator::default(),
            pointer_down: false,
            last_pressed: HashMap::new(),
        }
    }

    /// The display brightness now, in percent, when the platform can read it.
    pub fn brightness_level(&self) -> Option<f64> {
        self.brightness.level()
    }

    /// Carries out one of pointer mode's requests. Moves carry fractions of a pixel over to the next one.
    pub fn pointer(&mut self, event: PointerEvent) -> Result<(), ControlError> {
        match event {
            PointerEvent::MoveScreen { dx, dy } => {
                // Fractions of the screen the pointer is on, for a head pointer with a range.
                let (width, height) = self.pointer.screen_size().unwrap_or(FALLBACK_SCREEN_SIZE);
                self.pointer(PointerEvent::Move {
                    dx: dx * width,
                    dy: dy * height,
                })
            }
            PointerEvent::Move { dx, dy } => {
                let limit = MAX_POINTER_PIXELS_PER_CALL;
                let x = self.pointer_x.take(dx, 1.0).clamp(-limit, limit);
                let y = self.pointer_y.take(dy, 1.0).clamp(-limit, limit);
                if x == 0 && y == 0 {
                    return Ok(());
                }
                self.pointer.move_by(x, y, self.pointer_down)
            }
            PointerEvent::Click => {
                if self.pointer_down {
                    // A click while the button is down would only let it go: do that, once.
                    self.pointer_down = false;
                    return self.pointer.button(false);
                }
                self.pointer.click()
            }
            PointerEvent::Press => {
                if self.pointer_down {
                    return Ok(());
                }
                self.pointer_down = true;
                self.pointer.button(true)
            }
            PointerEvent::Release => {
                if !self.pointer_down {
                    return Ok(());
                }
                self.pointer_down = false;
                self.pointer.button(false)
            }
        }
    }

    /// Whether a press of `action` at `now` is allowed, recording it if so.
    pub fn allow_press(&mut self, action: Action, now: Instant) -> bool {
        if self
            .last_pressed
            .get(&action)
            .is_some_and(|previous| now.saturating_duration_since(*previous) < KEY_COOLDOWN)
        {
            return false;
        }
        self.last_pressed.insert(action, now);
        true
    }

    /// Presses the media key for a trigger action. Mute is not a media key here: the caller toggles it through the
    /// volume controller, which knows the current state.
    pub fn press_media(&mut self, action: Action) -> Option<Result<(), ControlError>> {
        let key = match action {
            Action::PlayPause => MediaKey::PlayPause,
            Action::NextTrack => MediaKey::NextTrack,
            Action::PreviousTrack => MediaKey::PreviousTrack,
            _ => return None,
        };
        Some(self.media.press(key))
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
            _ => Ok(()),
        }
    }

    /// An interaction ended: drop any change still being carried so it cannot leak into the next one.
    pub fn reset(&mut self, action: Action) {
        match action {
            Action::Brightness => self.brightness_acc.clear(),
            Action::Scroll => self.scroll_acc.clear(),
            Action::Pointer => {
                self.pointer_x.clear();
                self.pointer_y.clear();
                if self.pointer_down {
                    // Pointer mode ended with the button down: never leave it held.
                    self.pointer_down = false;
                    let _ = self.pointer.button(false);
                }
            }
            _ => {}
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

    pub fn press(&self, app: &AppHandle, action: Action) {
        self.send(app, Command::Press(action));
    }

    pub fn shortcut(&self, app: &AppHandle, keys: String) {
        self.send(app, Command::Shortcut(keys));
    }

    /// Reads the brightness off the watch loop (it can be slow) and shows it on the overlay.
    pub fn read_brightness(&self, app: &AppHandle) {
        self.send(app, Command::ReadBrightness);
    }

    pub fn pointer(&self, app: &AppHandle, events: Vec<PointerEvent>) {
        if !events.is_empty() {
            self.send(app, Command::Pointer(events));
        }
    }
}

/// Tells the UI once when an action starts failing, and quietly notes when it recovers.
fn report(
    app: &AppHandle,
    failing: &mut Option<Action>,
    action: Action,
    result: Result<(), ControlError>,
) {
    match result {
        Ok(()) => {
            if *failing == Some(action) {
                *failing = None;
            }
        }
        Err(error) => {
            crate::miss_recorder::note(app, "action", format!("{action:?} failed: {error}"));
            if *failing != Some(action) {
                *failing = Some(action);
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
}

fn run_worker(app: AppHandle, rx: std::sync::mpsc::Receiver<Command>) {
    let mut core = Core::new(
        platform_brightness_controller(),
        platform_scroll_controller(),
        platform_media_controller(),
        platform_pointer_controller(),
    );
    let mut shortcuts = ShortcutPresser::new(platform_shortcut_controller());
    let mut failing: Option<Action> = None;
    while let Ok(first) = rx.recv() {
        // Everything already waiting is folded into one change per action, so a backlog never replays.
        let mut pending: Vec<(Action, f64)> = Vec::new();
        let mut presses: Vec<Action> = Vec::new();
        let mut keys: Vec<String> = Vec::new();
        let mut pointer: Vec<PointerEvent> = Vec::new();
        let mut read_brightness = false;
        let mut handle =
            |command: Command, core: &mut Core, pending: &mut Vec<(Action, f64)>| match command {
                Command::Delta(action, fraction) => {
                    match pending.iter_mut().find(|(a, _)| *a == action) {
                        Some((_, total)) => *total += fraction,
                        None => pending.push((action, fraction)),
                    }
                }
                Command::Reset(Action::Pointer) => {
                    // Earlier pointer events still go first, so a release is not overtaken by a press before it.
                    for event in merge_pointer_events(pointer.drain(..)) {
                        let _ = core.pointer(event);
                    }
                    core.reset(Action::Pointer);
                }
                Command::Reset(action) => {
                    pending.retain(|(a, _)| *a != action);
                    core.reset(action);
                }
                Command::Pointer(events) => pointer.extend(events),
                Command::ReadBrightness => read_brightness = true,
                Command::Press(action) => presses.push(action),
                Command::Shortcut(combo) => keys.push(combo),
            };
        handle(first, &mut core, &mut pending);
        while let Ok(next) = rx.try_recv() {
            handle(next, &mut core, &mut pending);
        }
        for action in presses {
            if !core.allow_press(action, Instant::now()) {
                continue;
            }
            let result = match core.press_media(action) {
                Some(result) => result,
                None => app
                    .state::<crate::overlay::VolumeRuntime>()
                    .toggle_mute()
                    .map(|_| ())
                    .map_err(ControlError::Backend),
            };
            report(&app, &mut failing, action, result);
        }
        for combo in keys {
            if let Some(result) = shortcuts.press(&combo, Instant::now()) {
                report(&app, &mut failing, Action::Shortcut, result);
            }
        }
        for event in merge_pointer_events(pointer) {
            report(&app, &mut failing, Action::Pointer, core.pointer(event));
        }
        for (action, fraction) in pending {
            report(&app, &mut failing, action, core.deliver(action, fraction));
            read_brightness |= action == Action::Brightness;
            if action == Action::Scroll {
                std::thread::sleep(SCROLL_PACING);
            }
        }
        if read_brightness {
            app.state::<crate::overlay::OverlayRuntime>()
                .set_brightness_level(&app, core.brightness_level());
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
        keys: Vec<MediaKey>,
        pointer: Vec<String>,
    }

    struct FakeBrightness(Arc<Mutex<Log>>, f64);
    struct FakeScroll(Arc<Mutex<Log>>);
    struct FakeMedia(Arc<Mutex<Log>>);
    struct FakePointer(Arc<Mutex<Log>>);

    impl PointerController for FakePointer {
        fn move_by(&self, dx: i32, dy: i32, dragging: bool) -> Result<(), ControlError> {
            let kind = if dragging { "drag" } else { "move" };
            self.0
                .lock()
                .unwrap()
                .pointer
                .push(format!("{kind} {dx} {dy}"));
            Ok(())
        }
        fn button(&self, down: bool) -> Result<(), ControlError> {
            self.0
                .lock()
                .unwrap()
                .pointer
                .push(if down { "down" } else { "up" }.into());
            Ok(())
        }
    }

    impl MediaController for FakeMedia {
        fn press(&self, key: MediaKey) -> Result<(), ControlError> {
            self.0.lock().unwrap().keys.push(key);
            Ok(())
        }
    }

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

    struct FakeShortcut(Arc<Mutex<Vec<String>>>);

    impl ShortcutController for FakeShortcut {
        fn press(&self, combo: &KeyCombo) -> Result<(), ControlError> {
            self.0.lock().unwrap().push(combo.to_string());
            Ok(())
        }
    }

    #[test]
    fn a_shortcut_is_pressed_once_and_not_again_within_the_cooldown() {
        let pressed = Arc::new(Mutex::new(Vec::new()));
        let mut presser = ShortcutPresser::new(Box::new(FakeShortcut(pressed.clone())));
        let start = Instant::now();
        assert_eq!(presser.press("Cmd+Shift+4", start), Some(Ok(())));
        assert_eq!(
            presser.press("cmd+shift+4", start + Duration::from_millis(200)),
            None
        );
        // Another shortcut is not held back by the first.
        assert_eq!(
            presser.press("f5", start + Duration::from_millis(200)),
            Some(Ok(()))
        );
        assert_eq!(
            presser.press("cmd+shift+4", start + Duration::from_millis(600)),
            Some(Ok(()))
        );
        assert_eq!(
            *pressed.lock().unwrap(),
            vec!["cmd+shift+4", "f5", "cmd+shift+4"]
        );
        // Keys that cannot be pressed are an error, not a silent nothing.
        assert!(matches!(
            presser.press("k", start),
            Some(Err(ControlError::Backend(_)))
        ));
    }

    fn core(step_percent: f64) -> (Core, Arc<Mutex<Log>>) {
        let log = Arc::new(Mutex::new(Log::default()));
        (
            Core::new(
                Box::new(FakeBrightness(log.clone(), step_percent)),
                Box::new(FakeScroll(log.clone())),
                Box::new(FakeMedia(log.clone())),
                Box::new(FakePointer(log.clone())),
            ),
            log,
        )
    }

    fn moves(dx: f64, dy: f64) -> PointerEvent {
        PointerEvent::Move { dx, dy }
    }

    #[test]
    fn a_move_by_a_fraction_of_the_screen_becomes_pixels_of_the_screen() {
        let (mut core, log) = core(1.0);
        core.pointer(PointerEvent::MoveScreen { dx: 0.1, dy: -0.25 })
            .unwrap();
        // The fake cannot say how big its screen is, so the fallback size counts.
        assert_eq!(
            log.lock().unwrap().pointer,
            vec!["move 144 -225".to_string()]
        );
        let merged = merge_pointer_events([
            PointerEvent::MoveScreen { dx: 0.1, dy: 0.0 },
            PointerEvent::MoveScreen { dx: 0.1, dy: 0.1 },
            moves(1.0, 0.0),
        ]);
        assert_eq!(
            merged,
            vec![
                PointerEvent::MoveScreen { dx: 0.2, dy: 0.1 },
                moves(1.0, 0.0)
            ]
        );
    }

    #[test]
    fn runs_of_pointer_moves_are_merged_but_clicks_stay_in_their_place() {
        let merged = merge_pointer_events([
            moves(1.0, 0.5),
            moves(2.0, 0.5),
            PointerEvent::Click,
            moves(-1.0, 0.0),
            PointerEvent::Press,
            PointerEvent::Release,
        ]);
        assert_eq!(
            merged,
            vec![
                moves(3.0, 1.0),
                PointerEvent::Click,
                moves(-1.0, 0.0),
                PointerEvent::Press,
                PointerEvent::Release
            ]
        );
    }

    #[test]
    fn the_pointer_moves_in_whole_pixels_drags_while_pressed_and_a_reset_lets_go() {
        let (mut core, log) = core(1.0);
        core.pointer(moves(0.6, -0.4)).unwrap(); // nothing whole yet
        core.pointer(moves(0.6, -0.8)).unwrap(); // 1.2, -1.2: one pixel each way
        core.pointer(PointerEvent::Click).unwrap();
        core.pointer(PointerEvent::Press).unwrap();
        core.pointer(PointerEvent::Press).unwrap(); // already down: nothing more
        core.pointer(moves(5.0, 0.0)).unwrap();
        core.reset(Action::Pointer);
        core.reset(Action::Pointer); // already up: nothing more
        core.pointer(PointerEvent::Release).unwrap();
        assert_eq!(
            log.lock().unwrap().pointer,
            vec!["move 1 -1", "down", "up", "down", "drag 5 0", "up"]
        );
    }

    #[test]
    fn a_glitch_cannot_throw_the_pointer_across_the_screen() {
        let (mut core, log) = core(1.0);
        core.pointer(moves(1e6, -1e6)).unwrap();
        let limit = MAX_POINTER_PIXELS_PER_CALL;
        assert_eq!(
            log.lock().unwrap().pointer,
            vec![format!("move {limit} -{limit}")]
        );
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
    fn media_triggers_press_their_key_and_a_quick_repeat_is_ignored() {
        let (mut core, log) = core(1.0);
        let start = Instant::now();
        assert!(core.allow_press(Action::NextTrack, start));
        assert!(core.press_media(Action::NextTrack).unwrap().is_ok());
        // A flickering gesture firing again straight away is dropped, but only for that action.
        assert!(!core.allow_press(Action::NextTrack, start + Duration::from_millis(100)));
        assert!(core.allow_press(Action::PlayPause, start + Duration::from_millis(100)));
        assert!(core.allow_press(Action::NextTrack, start + Duration::from_millis(600)));
        assert_eq!(log.lock().unwrap().keys, vec![MediaKey::NextTrack]);
        // Mute is toggled by the caller through the volume controller, not as a key.
        assert!(core.press_media(Action::Mute).is_none());
    }

    #[test]
    fn volume_is_not_this_modules_job() {
        let (mut core, log) = core(1.0);
        core.deliver(Action::Volume, 0.5).unwrap();
        assert!(log.lock().unwrap().brightness.is_empty() && log.lock().unwrap().scroll.is_empty());
    }
}
