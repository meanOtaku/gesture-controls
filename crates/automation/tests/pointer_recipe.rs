//! A pointer recipe as the user would build it: snap to switch pointer mode on, the hand moves the pointer, a quick
//! pinch clicks, a held pinch drags, and the next snap switches it off.

use std::collections::BTreeSet;

use automation::*;

const MS: u64 = 1_000_000;

fn pointer_stage() -> Stage {
    Stage::Pointer {
        pixels_per_degree: 10.0,
        press_label: "pinch_in".into(),
        hold_label: "pinch_hold".into(),
        release_label: "pinch_out".into(),
        lookback_ms: 400,
        mode: PointerMode::Mouse,
        source: PointerSource::Watch,
        reverse_across: false,
        reverse_up: false,
        head_range: None,
    }
}

fn snap_pointer() -> Recipe {
    Recipe {
        id: "pointer".into(),
        name: "Snap for the pointer".into(),
        enabled: true,
        stages: vec![
            Stage::Model {
                label: "snap_fingers".into(),
                hold: ModelHold::OneShot,
            },
            pointer_stage(),
        ],
        device: Device::default_for(DeviceKind::RotationKnob),
        action: Action::Pointer,
        keys: None,
        apps: Vec::new(),
        overlay_at: None,
    }
}

/// The forearm level, pointing `heading` degrees anticlockwise of the world's x axis.
fn heading(degrees: f64) -> [f64; 4] {
    let half = degrees.to_radians() / 2.0;
    [half.cos(), 0.0, 0.0, half.sin()]
}

fn set(labels: &[&str]) -> BTreeSet<String> {
    labels.iter().map(|l| l.to_string()).collect()
}

struct Labels {
    edges: BTreeSet<String>,
    held: BTreeSet<String>,
    pulsed: BTreeSet<String>,
}

impl Labels {
    fn none() -> Self {
        Self {
            edges: set(&[]),
            held: set(&[]),
            pulsed: set(&[]),
        }
    }
}

fn step(
    runner: &mut RecipeRunner,
    at_ms: u64,
    pointing: f64,
    labels: &Labels,
) -> Vec<PointerEvent> {
    runner.update(&Signals {
        orientation: Some(heading(pointing)),
        now_ns: Some(at_ms * MS),
        model_edges: Some(&labels.edges),
        models_held: Some(&labels.held),
        models_pulsed: Some(&labels.pulsed),
        ..Signals::default()
    });
    runner.take_pointer_events()
}

fn snap() -> Labels {
    Labels {
        pulsed: set(&["snap_fingers"]),
        ..Labels::none()
    }
}

fn edge(label: &str) -> Labels {
    Labels {
        edges: set(&[label]),
        ..Labels::none()
    }
}

fn held(label: &str) -> Labels {
    Labels {
        held: set(&[label]),
        ..Labels::none()
    }
}

fn moved_right(events: &[PointerEvent]) -> f64 {
    events
        .iter()
        .map(|event| match event {
            PointerEvent::Move { dx, .. } => *dx,
            _ => 0.0,
        })
        .sum()
}

fn buttons(events: &[PointerEvent]) -> Vec<PointerEvent> {
    events
        .iter()
        .copied()
        .filter(|event| !matches!(event, PointerEvent::Move { .. }))
        .collect()
}

#[test]
fn the_pointer_recipe_is_valid_and_its_step_belongs_to_it_alone() {
    assert_eq!(validate_recipe(&snap_pointer()), Ok(()));
    let mut volume = snap_pointer();
    volume.action = Action::Volume;
    assert_eq!(
        validate_recipe(&volume),
        Err(RecipeError::PointerStageOnlyForPointer)
    );
    let mut no_step = snap_pointer();
    no_step.stages.pop();
    assert_eq!(
        validate_recipe(&no_step),
        Err(RecipeError::PointerNeedsPointerStage)
    );
    let mut always_on = snap_pointer();
    always_on.stages.remove(0);
    assert_eq!(
        validate_recipe(&always_on),
        Err(RecipeError::PointerNeedsSwitch)
    );
    let mut same_labels = snap_pointer();
    same_labels.stages[1] = Stage::Pointer {
        pixels_per_degree: 10.0,
        press_label: "pinch".into(),
        hold_label: "pinch".into(),
        release_label: "pinch".into(),
        lookback_ms: 400,
        mode: PointerMode::Mouse,
        source: PointerSource::Watch,
        reverse_across: false,
        reverse_up: false,
        head_range: None,
    };
    assert_eq!(
        validate_recipe(&same_labels),
        Err(RecipeError::InvalidPointer)
    );
}

#[test]
fn nothing_moves_until_a_snap_switches_pointer_mode_on() {
    let mut runner = RecipeRunner::new(snap_pointer());
    step(&mut runner, 0, 0.0, &Labels::none());
    assert!(step(&mut runner, 10, -5.0, &Labels::none()).is_empty());
    assert_eq!(runner.phase(), RunnerPhase::Idle);

    step(&mut runner, 20, -5.0, &snap());
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    // Pointing further right moves the pointer right.
    let events = step(&mut runner, 30, -6.0, &snap());
    assert!(moved_right(&events) > 0.0, "{events:?}");
}

#[test]
fn a_quick_pinch_clicks_a_held_one_drags_and_the_next_snap_ends_it_with_the_button_up() {
    let mut runner = RecipeRunner::new(snap_pointer());
    step(&mut runner, 0, 0.0, &snap());
    // Let the snap's moment pass, then point around for a second.
    for n in 1..=100 {
        step(&mut runner, n * 10, -(n as f64) * 0.2, &Labels::none());
    }
    step(&mut runner, 1010, -20.0, &edge("pinch_in"));
    let click = step(&mut runner, 1100, -20.5, &edge("pinch_out"));
    assert_eq!(buttons(&click), vec![PointerEvent::Click]);

    step(&mut runner, 1500, -21.0, &edge("pinch_in"));
    let down = step(&mut runner, 1600, -21.0, &held("pinch_hold"));
    assert_eq!(buttons(&down), vec![PointerEvent::Press]);
    let drag = step(&mut runner, 1700, -23.0, &held("pinch_hold"));
    assert!(
        moved_right(&drag) > 0.0,
        "the hand drags with the button down"
    );

    // A snap while the button is down ends pointer mode, and the button comes up with it.
    let off = step(&mut runner, 1800, -23.0, &snap());
    assert_eq!(buttons(&off), vec![PointerEvent::Release]);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    assert!(step(&mut runner, 1900, -30.0, &Labels::none()).is_empty());
}

#[test]
fn losing_the_watch_or_a_reset_never_leaves_the_button_down() {
    let mut runner = RecipeRunner::new(snap_pointer());
    step(&mut runner, 0, 0.0, &snap());
    step(&mut runner, 1000, 0.0, &edge("pinch_in"));
    step(&mut runner, 1010, 0.0, &held("pinch_hold"));
    // The orientation is gone: the watch went away.
    runner.update(&Signals {
        now_ns: Some(1020 * MS),
        ..Signals::default()
    });
    assert_eq!(
        buttons(&runner.take_pointer_events()),
        vec![PointerEvent::Release]
    );

    let mut runner = RecipeRunner::new(snap_pointer());
    step(&mut runner, 0, 0.0, &snap());
    step(&mut runner, 1000, 0.0, &edge("pinch_in"));
    step(&mut runner, 1010, 0.0, &held("pinch_hold"));
    runner.reset();
    assert_eq!(
        buttons(&runner.take_pointer_events()),
        vec![PointerEvent::Release]
    );
}

#[test]
fn pointer_mode_comes_back_on_long_after_it_last_went_off() {
    let mut runner = RecipeRunner::new(snap_pointer());
    step(&mut runner, 0, 0.0, &snap());
    step(&mut runner, 700, -3.0, &Labels::none());
    step(&mut runner, 800, -6.0, &Labels::none());
    step(&mut runner, 1000, -6.0, &snap());
    step(&mut runner, 1700, -6.0, &Labels::none());
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    // A minute later, longer than pointer mode's idle time, a snap still switches it on.
    let later = 60_000 + POINTER_IDLE_NS / MS;
    step(&mut runner, later, -6.0, &Labels::none());
    step(&mut runner, later + 10, -6.0, &snap());
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    let events = step(&mut runner, later + 20, -8.0, &snap());
    assert!(moved_right(&events) > 0.0, "{events:?}");
}

#[test]
fn pointer_mode_left_alone_switches_itself_off() {
    let mut runner = RecipeRunner::new(snap_pointer());
    step(&mut runner, 0, 0.0, &snap());
    step(&mut runner, 700, 0.0, &Labels::none());
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    step(
        &mut runner,
        700 + POINTER_IDLE_NS / MS + 10,
        0.0,
        &Labels::none(),
    );
    assert_eq!(runner.phase(), RunnerPhase::Idle);
}

#[test]
fn a_pointer_step_saved_before_trackpad_mode_still_moves_like_a_mouse() {
    let older = serde_json::json!({
        "kind": "pointer", "pixelsPerDegree": 25.0, "pressLabel": "pinch_in", "holdLabel": "pinch_hold",
        "releaseLabel": "pinch_out", "lookbackMs": 400
    });
    let stage: Stage = serde_json::from_value(older.clone()).unwrap();
    assert!(matches!(
        stage,
        Stage::Pointer {
            mode: PointerMode::Mouse,
            ..
        }
    ));
    let mut trackpad = older;
    trackpad["mode"] = "trackpad".into();
    let stage: Stage = serde_json::from_value(trackpad).unwrap();
    assert!(matches!(
        stage,
        Stage::Pointer {
            mode: PointerMode::Trackpad,
            ..
        }
    ));
}

#[test]
fn with_the_head_as_the_source_a_snap_switches_it_on_the_head_moves_the_pointer_and_the_arm_does_not()
 {
    let mut recipe = snap_pointer();
    if let Some(Stage::Pointer { source, .. }) = recipe.stages.last_mut() {
        *source = PointerSource::Head;
    }
    assert_eq!(validate_recipe(&recipe), Ok(()));
    let mut runner = RecipeRunner::new(recipe);
    let head = |at_ms: u64, yaw: f64| HeadAim {
        yaw_deg: yaw,
        pitch_deg: 0.0,
        timestamp_ns: 50_000_000_000 + at_ms * MS,
    };
    let drive =
        |runner: &mut RecipeRunner, at_ms: u64, arm: f64, aim: Option<HeadAim>, labels: &Labels| {
            runner.update(&Signals {
                orientation: Some(heading(arm)),
                now_ns: Some(at_ms * MS),
                model_edges: Some(&labels.edges),
                models_held: Some(&labels.held),
                models_pulsed: Some(&labels.pulsed),
                head_aim: aim,
                ..Signals::default()
            });
            runner.take_pointer_events()
        };
    drive(&mut runner, 0, 0.0, Some(head(0, 0.0)), &snap());
    // The arm swings right while the head turns right too: only the head counts.
    let mut events = Vec::new();
    for n in 1..=150u64 {
        let f = (n.min(50) as f64) / 50.0;
        events.extend(drive(
            &mut runner,
            n * 10,
            40.0 * f,
            Some(head(n * 10, -10.0 * f)),
            &Labels::none(),
        ));
    }
    let across = moved_right(&events);
    assert!(across > 50.0, "{across}");
    // The headphones going away ends pointer mode.
    drive(&mut runner, 1600, 0.0, None, &Labels::none());
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    assert!(
        drive(
            &mut runner,
            1610,
            0.0,
            Some(head(1610, -20.0)),
            &Labels::none()
        )
        .is_empty()
    );
}

#[test]
fn a_pointer_step_saved_before_the_head_source_still_follows_the_watch() {
    let older = serde_json::json!({
        "kind": "pointer", "pixelsPerDegree": 25.0, "pressLabel": "pinch_in", "holdLabel": "pinch_hold",
        "releaseLabel": "pinch_out", "lookbackMs": 400, "mode": "trackpad"
    });
    let stage: Stage = serde_json::from_value(older.clone()).unwrap();
    assert!(matches!(
        stage,
        Stage::Pointer {
            source: PointerSource::Watch,
            reverse_across: false,
            reverse_up: false,
            ..
        }
    ));
    let mut head = older;
    head["source"] = "head".into();
    head["reverseAcross"] = true.into();
    let stage: Stage = serde_json::from_value(head).unwrap();
    assert!(matches!(
        stage,
        Stage::Pointer {
            source: PointerSource::Head,
            reverse_across: true,
            reverse_up: false,
            ..
        }
    ));
}
