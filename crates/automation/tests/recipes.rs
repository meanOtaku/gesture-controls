use automation::*;

fn recipe(id: &str, stages: Vec<Stage>, device: Device) -> Recipe {
    Recipe {
        id: id.into(),
        name: id.into(),
        enabled: true,
        stages,
        device,
        action: Action::Volume,
        keys: None,
        apps: Vec::new(),
    }
}

fn chain() -> Vec<Stage> {
    vec![
        Stage::HeadAt {
            location: "topRight".into(),
        },
        Stage::Hold {
            hold: Hold::StemButton,
        },
        Stage::Drive {
            axis: Axis::Roll,
            dead_zone_degrees: 0.0,
            invert: false,
        },
    ]
}

/// The orientation of a watch rolled `degrees` about the forearm.
fn about_x(degrees: f64) -> [f64; 4] {
    let half = degrees.to_radians() / 2.0;
    [half.cos(), half.sin(), 0.0, 0.0]
}

fn signals(head: Option<&'static str>, pinch: bool, roll: f64) -> Signals<'static> {
    Signals {
        head_location: head,
        stem_button_held: pinch,
        orientation: Some(about_x(roll)),
        ..Signals::default()
    }
}

#[test]
fn the_chain_only_drives_while_every_stage_holds() {
    let mut runner = RecipeRunner::new(recipe(
        "vol",
        chain(),
        Device::RotationKnob {
            fraction_per_degree: 0.01,
        },
    ));
    // Looking and rolling without the pinch does nothing.
    assert_eq!(runner.update(&signals(Some("topRight"), false, 10.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    // Pinching somewhere else does nothing either.
    assert_eq!(runner.update(&signals(None, true, 10.0)), None);
    // Everything holds: the first reading only sets the starting angle.
    assert_eq!(runner.update(&signals(Some("topRight"), true, 10.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    let up = runner
        .update(&signals(Some("topRight"), true, 30.0))
        .unwrap();
    assert!((up.delta_fraction - 0.2).abs() < 1e-9);
    let down = runner
        .update(&signals(Some("topRight"), true, 20.0))
        .unwrap();
    assert!((down.delta_fraction + 0.1).abs() < 1e-9);
    // Looking away ends it, and the next pinch starts from a fresh reference.
    assert_eq!(runner.update(&signals(None, true, 90.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    assert_eq!(runner.update(&signals(Some("topRight"), true, 90.0)), None);
    assert_eq!(runner.update(&signals(Some("topRight"), true, 90.0)), None);
}

#[test]
fn a_knob_turns_through_the_180_degree_seam_without_jumping() {
    let mut runner = RecipeRunner::new(recipe(
        "vol",
        chain(),
        Device::RotationKnob {
            fraction_per_degree: 0.01,
        },
    ));
    runner.update(&signals(Some("topRight"), true, 170.0));
    let step = runner
        .update(&signals(Some("topRight"), true, -170.0))
        .unwrap();
    assert!(
        (step.delta_fraction - 0.2).abs() < 1e-9,
        "20 degrees through the seam, got {step:?}"
    );
}

#[test]
fn a_fader_stops_at_its_ends_and_comes_back() {
    let device = Device::HorizontalFader {
        travel_degrees: 40.0,
        fraction_per_travel: 0.5,
    };
    let mut runner = RecipeRunner::new(recipe("vol", chain(), device));
    runner.update(&signals(Some("topRight"), true, 0.0));
    let first = runner
        .update(&signals(Some("topRight"), true, 40.0))
        .unwrap();
    assert!((first.delta_fraction - 0.5).abs() < 1e-9);
    // Beyond the end the handle does not move.
    assert_eq!(runner.update(&signals(Some("topRight"), true, 80.0)), None);
    // Coming back only moves the output once past the end stop.
    assert_eq!(runner.update(&signals(Some("topRight"), true, 50.0)), None);
    let back = runner
        .update(&signals(Some("topRight"), true, 20.0))
        .unwrap();
    assert!((back.delta_fraction + 0.25).abs() < 1e-9);
}

#[test]
fn a_step_knob_moves_in_whole_detents() {
    let device = Device::StepKnob {
        degrees_per_step: 15.0,
        fraction_per_step: 0.05,
    };
    let mut runner = RecipeRunner::new(recipe("vol", chain(), device));
    runner.update(&signals(Some("topRight"), true, 0.0));
    assert_eq!(runner.update(&signals(Some("topRight"), true, 14.0)), None);
    let one = runner
        .update(&signals(Some("topRight"), true, 16.0))
        .unwrap();
    assert!((one.delta_fraction - 0.05).abs() < 1e-9);
    let back = runner
        .update(&signals(Some("topRight"), true, -16.0))
        .unwrap();
    assert!((back.delta_fraction + 0.10).abs() < 1e-9);
}

#[test]
fn a_disabled_recipe_and_a_missing_orientation_do_nothing() {
    let mut disabled = recipe(
        "vol",
        chain(),
        Device::default_for(DeviceKind::RotationKnob),
    );
    disabled.enabled = false;
    let mut runner = RecipeRunner::new(disabled);
    assert_eq!(runner.update(&signals(Some("topRight"), true, 0.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);

    let mut runner = RecipeRunner::new(recipe(
        "vol",
        chain(),
        Device::default_for(DeviceKind::RotationKnob),
    ));
    let no_orientation = Signals {
        head_location: Some("topRight"),
        stem_button_held: true,
        ..Signals::default()
    };
    assert_eq!(runner.update(&no_orientation), None);
    // Looking at the location still arms it, but without an orientation the device cannot be driven.
    assert_eq!(runner.phase(), RunnerPhase::Armed);
}

#[test]
fn recipes_must_be_well_formed() {
    let knob = Device::default_for(DeviceKind::RotationKnob);
    assert!(validate_recipe(&recipe("ok", chain(), knob)).is_ok());
    assert_eq!(
        validate_recipe(&recipe("a", vec![], knob)),
        Err(RecipeError::NoStages)
    );
    assert_eq!(
        validate_recipe(&recipe(
            "a",
            vec![Stage::Hold {
                hold: Hold::StemButton
            }],
            knob
        )),
        Err(RecipeError::MustEndWithDrive)
    );
    assert_eq!(
        validate_recipe(&recipe(
            "a",
            vec![
                Stage::Drive {
                    axis: Axis::Roll,
                    dead_zone_degrees: 0.0,
                    invert: false
                },
                Stage::Drive {
                    axis: Axis::Pitch,
                    dead_zone_degrees: 0.0,
                    invert: false
                }
            ],
            knob
        )),
        Err(RecipeError::DriveNotLast)
    );
    let repeated = vec![
        Stage::Hold {
            hold: Hold::StemButton,
        },
        Stage::Hold {
            hold: Hold::StemButton,
        },
        Stage::Drive {
            axis: Axis::Roll,
            dead_zone_degrees: 0.0,
            invert: false,
        },
    ];
    assert_eq!(
        validate_recipe(&recipe("a", repeated, knob)),
        Err(RecipeError::RepeatedStage)
    );
    let mut unnamed = recipe("a", chain(), knob);
    unnamed.name = "  ".into();
    assert_eq!(validate_recipe(&unnamed), Err(RecipeError::InvalidName));
    let bad_device = Device::RotationKnob {
        fraction_per_degree: f64::NAN,
    };
    assert_eq!(
        validate_recipe(&recipe("a", chain(), bad_device)),
        Err(RecipeError::InvalidDevice)
    );
}

#[test]
fn two_enabled_recipes_on_one_resource_conflict_and_are_both_blocked() {
    let knob = Device::default_for(DeviceKind::RotationKnob);
    let a = recipe("headVolume", chain(), knob);
    let b = recipe(
        "buttonVolume",
        vec![
            Stage::Hold {
                hold: Hold::StemButton,
            },
            Stage::Drive {
                axis: Axis::Roll,
                dead_zone_degrees: 0.0,
                invert: false,
            },
        ],
        knob,
    );
    let mut c = recipe("spare", chain(), knob);
    c.enabled = false;

    let conflicts = find_conflicts(&[a.clone(), b.clone(), c.clone()]);
    assert_eq!(
        conflicts,
        vec![Conflict {
            resource: "volume".into(),
            first: "headVolume".into(),
            second: "buttonVolume".into()
        }]
    );
    let blocked = blocked_recipes(&[a.clone(), b.clone(), c.clone()]);
    assert!(
        blocked.contains("headVolume")
            && blocked.contains("buttonVolume")
            && !blocked.contains("spare")
    );
    // Disabling one clears the clash.
    let mut b_off = b;
    b_off.enabled = false;
    assert!(find_conflicts(&[a, b_off, c]).is_empty());
}

#[test]
fn recipes_round_trip_through_json_in_camel_case() {
    let original = recipe("vol", chain(), Device::default_for(DeviceKind::StepKnob));
    let json = serde_json::to_string(&original).unwrap();
    assert!(json.contains("\"kind\":\"headAt\"") && json.contains("\"degreesPerStep\""));
    assert_eq!(serde_json::from_str::<Recipe>(&json).unwrap(), original);
}

fn drive_recipe(dead_zone_degrees: f64, invert: bool) -> Recipe {
    recipe(
        "vol",
        vec![
            Stage::Hold {
                hold: Hold::StemButton,
            },
            Stage::Drive {
                axis: Axis::Roll,
                dead_zone_degrees,
                invert,
            },
        ],
        Device::RotationKnob {
            fraction_per_degree: 0.01,
        },
    )
}

fn held(orientation: [f64; 4]) -> Signals<'static> {
    Signals {
        stem_button_held: true,
        orientation: Some(orientation),
        ..Signals::default()
    }
}

#[test]
fn the_dead_zone_ignores_small_movement_and_only_counts_the_excess() {
    let mut runner = RecipeRunner::new(drive_recipe(3.0, false));
    runner.update(&held(about_x(0.0)));
    assert_eq!(runner.update(&held(about_x(2.0))), None);
    let moved = runner.update(&held(about_x(13.0))).unwrap();
    assert!(
        (moved.delta_fraction - 0.10).abs() < 1e-9,
        "13 degrees less a 3 degree dead zone, got {moved:?}"
    );
}

#[test]
fn inverting_flips_the_direction() {
    let mut runner = RecipeRunner::new(drive_recipe(0.0, true));
    runner.update(&held(about_x(0.0)));
    let moved = runner.update(&held(about_x(10.0))).unwrap();
    assert!((moved.delta_fraction + 0.10).abs() < 1e-9);
}

#[test]
fn rotation_is_measured_from_the_orientation_when_the_hold_began() {
    // Starting from an arbitrary orientation, rolling a further 10 degrees about the same axis moves by 10.
    let mut runner = RecipeRunner::new(drive_recipe(0.0, false));
    runner.update(&held(about_x(100.0)));
    let moved = runner.update(&held(about_x(110.0))).unwrap();
    assert!((moved.delta_fraction - 0.10).abs() < 1e-9);
    // A zero-length quaternion is not an orientation: the interaction ends rather than guessing.
    assert_eq!(runner.update(&held([0.0; 4])), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
}

#[test]
fn a_bad_dead_zone_is_rejected() {
    let mut bad = drive_recipe(0.0, false);
    bad.stages[1] = Stage::Drive {
        axis: Axis::Roll,
        dead_zone_degrees: 120.0,
        invert: false,
    };
    assert_eq!(validate_recipe(&bad), Err(RecipeError::InvalidDeadZone));
}

#[test]
fn a_cancelled_interaction_restarts_only_after_the_chain_was_released() {
    let mut runner = RecipeRunner::new(drive_recipe(0.0, false));
    runner.update(&held(about_x(0.0)));
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    runner.cancel();
    // Still holding the same gesture: nothing happens.
    assert_eq!(runner.update(&held(about_x(20.0))), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    // Let go, then hold again: a fresh interaction begins.
    runner.update(&Signals::default());
    runner.update(&held(about_x(20.0)));
    assert_eq!(runner.phase(), RunnerPhase::Driving);
}

#[test]
fn looking_arms_the_recipe_and_escape_does_not_re_arm_while_still_looking() {
    let mut runner = RecipeRunner::new(recipe(
        "vol",
        chain(),
        Device::default_for(DeviceKind::RotationKnob),
    ));
    runner.update(&signals(Some("topRight"), false, 0.0));
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    runner.cancel();
    runner.update(&signals(Some("topRight"), false, 0.0));
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    runner.update(&signals(None, false, 0.0));
    runner.update(&signals(Some("topRight"), false, 0.0));
    assert_eq!(runner.phase(), RunnerPhase::Armed);
}

#[test]
fn recipes_on_different_things_never_conflict_but_two_on_one_thing_do() {
    let knob = Device::default_for(DeviceKind::RotationKnob);
    let mut volume = recipe("volume", chain(), knob);
    let mut brightness = recipe("brightness", chain(), knob);
    brightness.action = Action::Brightness;
    let mut scroll = recipe("scroll", chain(), knob);
    scroll.action = Action::Scroll;
    // The same gesture chain may drive three different things at once.
    assert!(find_conflicts(&[volume.clone(), brightness.clone(), scroll.clone()]).is_empty());

    let mut second_scroll = recipe("scroll2", chain(), knob);
    second_scroll.action = Action::Scroll;
    let conflicts = find_conflicts(&[volume.clone(), scroll.clone(), second_scroll]);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].resource, "scroll");
    volume.enabled = false;
    brightness.enabled = false;
    assert_eq!(blocked_recipes(&[volume, brightness, scroll]).len(), 0);
}

#[test]
fn actions_serialize_in_camel_case() {
    assert_eq!(
        serde_json::to_string(&Action::Brightness).unwrap(),
        "\"brightness\""
    );
    assert_eq!(
        serde_json::from_str::<Action>("\"scroll\"").unwrap(),
        Action::Scroll
    );
}

fn trigger(stages: Vec<Stage>) -> Recipe {
    let mut recipe = recipe(
        "playPause",
        stages,
        Device::default_for(DeviceKind::RotationKnob),
    );
    recipe.action = Action::PlayPause;
    recipe
}

#[test]
fn a_trigger_recipe_fires_once_as_its_chain_completes() {
    let stages = vec![
        Stage::HeadAt {
            location: "topRight".into(),
        },
        Stage::Hold {
            hold: Hold::StemButton,
        },
    ];
    let mut runner = RecipeRunner::new(trigger(stages));
    // Looking alone arms it but does not fire.
    runner.update(&signals(Some("topRight"), false, 0.0));
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    assert!(!runner.take_fired());
    // The pinch completes the chain: one firing, and holding on does not repeat it.
    runner.update(&signals(Some("topRight"), true, 0.0));
    assert!(runner.take_fired());
    runner.update(&signals(Some("topRight"), true, 5.0));
    runner.update(&signals(Some("topRight"), true, 9.0));
    assert!(!runner.take_fired());
    // Let go and do it again: it fires again.
    runner.update(&signals(Some("topRight"), false, 0.0));
    runner.update(&signals(Some("topRight"), true, 0.0));
    assert!(runner.take_fired());
}

#[test]
fn a_cancelled_or_disabled_trigger_does_not_fire() {
    let stages = vec![Stage::Hold {
        hold: Hold::StemButton,
    }];
    let mut runner = RecipeRunner::new(trigger(stages.clone()));
    let pressed = Signals {
        stem_button_held: true,
        ..Signals::default()
    };
    runner.update(&pressed);
    assert!(runner.take_fired());
    runner.cancel();
    runner.update(&pressed);
    assert!(!runner.take_fired(), "held through a cancel");

    let mut off = trigger(stages);
    off.enabled = false;
    let mut runner = RecipeRunner::new(off);
    runner.update(&pressed);
    assert!(!runner.take_fired());
}

#[test]
fn trigger_recipes_are_validated_differently() {
    let step = vec![Stage::Hold {
        hold: Hold::StemButton,
    }];
    assert!(validate_recipe(&trigger(step.clone())).is_ok());
    assert_eq!(
        validate_recipe(&trigger(vec![])),
        Err(RecipeError::NoStages)
    );
    let with_drive = vec![
        step[0].clone(),
        Stage::Drive {
            axis: Axis::Roll,
            dead_zone_degrees: 0.0,
            invert: false,
        },
    ];
    assert_eq!(
        validate_recipe(&trigger(with_drive)),
        Err(RecipeError::TriggerHasDrive)
    );
    let repeated = vec![step[0].clone(), step[0].clone()];
    assert_eq!(
        validate_recipe(&trigger(repeated)),
        Err(RecipeError::RepeatedStage)
    );
    // And a continuous action still needs its wrist rotation.
    let mut volume = trigger(step);
    volume.action = Action::Volume;
    assert_eq!(validate_recipe(&volume), Err(RecipeError::MustEndWithDrive));
}

#[test]
fn media_actions_are_triggers_with_their_own_resources() {
    assert!(Action::PlayPause.is_trigger() && Action::Mute.is_trigger());
    assert!(!Action::Volume.is_trigger() && !Action::Scroll.is_trigger());
    let resources: Vec<_> = [
        Action::PlayPause,
        Action::NextTrack,
        Action::PreviousTrack,
        Action::Mute,
    ]
    .iter()
    .map(|a| a.resource())
    .collect();
    assert_eq!(
        resources,
        ["playPause", "nextTrack", "previousTrack", "mute"]
    );
    // Play/pause and next-track may share a gesture without conflicting.
    let mut next = trigger(vec![Stage::Hold {
        hold: Hold::StemButton,
    }]);
    next.id = "next".into();
    next.action = Action::NextTrack;
    let play = trigger(vec![Stage::Hold {
        hold: Hold::StemButton,
    }]);
    assert!(find_conflicts(&[play, next]).is_empty());
}

#[test]
fn a_shake_starts_a_button_action_and_is_allowed_in_a_dial_recipe() {
    let shake = || {
        vec![
            Stage::HeadAt {
                location: "topRight".into(),
            },
            Stage::Hold { hold: Hold::Shake },
        ]
    };
    let mut runner = RecipeRunner::new(trigger(shake()));
    let looking = |shake| Signals {
        head_location: Some("topRight"),
        shake,
        ..Signals::default()
    };
    runner.update(&looking(false));
    assert!(!runner.take_fired());
    runner.update(&looking(true));
    assert!(runner.take_fired());
    runner.update(&looking(true)); // still inside the shake's window
    assert!(!runner.take_fired());
    runner.update(&looking(false));
    runner.update(&looking(true));
    assert!(runner.take_fired());

    let mut dial = recipe(
        "dial",
        vec![
            Stage::Hold { hold: Hold::Shake },
            Stage::Drive {
                axis: Axis::Roll,
                dead_zone_degrees: 0.0,
                invert: false,
            },
        ],
        Device::default_for(DeviceKind::RotationKnob),
    );
    assert_eq!(
        validate_recipe(&dial),
        Ok(()),
        "in a dial recipe a shake switches the dial on and off"
    );
    dial.action = Action::Scroll;
    assert_eq!(validate_recipe(&dial), Ok(()));
    assert_eq!(serde_json::to_string(&Hold::Shake).unwrap(), "\"shake\"");
}

#[test]
fn a_swipe_step_fires_only_for_its_own_direction_and_is_momentary() {
    let mut runner = RecipeRunner::new(trigger(vec![Stage::Hold {
        hold: Hold::SwipeRight,
    }]));
    let swiped = |direction| Signals {
        swipe: direction,
        ..Signals::default()
    };
    runner.update(&swiped(Some(SwipeDirection::Left)));
    assert!(!runner.take_fired(), "the wrong way");
    runner.update(&swiped(None));
    runner.update(&swiped(Some(SwipeDirection::Right)));
    assert!(runner.take_fired());
    runner.update(&swiped(Some(SwipeDirection::Right)));
    assert!(!runner.take_fired(), "once per swipe");

    for hold in [
        Hold::SwipeLeft,
        Hold::SwipeRight,
        Hold::SwipeUp,
        Hold::SwipeDown,
        Hold::Shake,
    ] {
        assert!(hold.is_momentary());
        let dial = recipe(
            "dial",
            vec![
                Stage::Hold { hold },
                Stage::Drive {
                    axis: Axis::Roll,
                    dead_zone_degrees: 0.0,
                    invert: false,
                },
            ],
            Device::default_for(DeviceKind::RotationKnob),
        );
        assert_eq!(validate_recipe(&dial), Ok(()));
    }
    assert!(!Hold::StemButton.is_momentary() && !Hold::StemButton.is_momentary());
    assert_eq!(
        serde_json::to_string(&Hold::SwipeUp).unwrap(),
        "\"swipeUp\""
    );
}

#[test]
fn a_tap_step_and_a_double_tap_step_each_fire_only_for_their_own_kind() {
    let signals = |tap| Signals {
        tap,
        ..Signals::default()
    };
    let mut single = RecipeRunner::new(trigger(vec![Stage::Hold { hold: Hold::Tap }]));
    let mut double = RecipeRunner::new(trigger(vec![Stage::Hold {
        hold: Hold::DoubleTap,
    }]));
    for runner in [&mut single, &mut double] {
        runner.update(&signals(Some(TapKind::Single)));
    }
    assert!(single.take_fired());
    assert!(!double.take_fired());
    for runner in [&mut single, &mut double] {
        runner.update(&signals(None));
        runner.update(&signals(Some(TapKind::Double)));
    }
    assert!(!single.take_fired());
    assert!(double.take_fired());
    assert_eq!(
        serde_json::to_string(&Hold::DoubleTap).unwrap(),
        "\"doubleTap\""
    );
}

#[test]
fn a_roll_step_fires_only_for_its_own_direction() {
    let signals = |roll| Signals {
        roll,
        ..Signals::default()
    };
    let mut clockwise = RecipeRunner::new(trigger(vec![Stage::Hold {
        hold: Hold::RollClockwise,
    }]));
    clockwise.update(&signals(Some(RollDirection::CounterClockwise)));
    assert!(!clockwise.take_fired());
    clockwise.update(&signals(None));
    clockwise.update(&signals(Some(RollDirection::Clockwise)));
    assert!(clockwise.take_fired());
    assert_eq!(
        serde_json::to_string(&Hold::RollCounterClockwise).unwrap(),
        "\"rollCounterClockwise\""
    );
}

#[test]
fn a_pitch_step_fires_only_for_its_own_direction() {
    let signals = |pitch| Signals {
        pitch,
        ..Signals::default()
    };
    let mut up = RecipeRunner::new(trigger(vec![Stage::Hold {
        hold: Hold::PitchUp,
    }]));
    up.update(&signals(Some(PitchDirection::Down)));
    assert!(!up.take_fired());
    up.update(&signals(None));
    up.update(&signals(Some(PitchDirection::Up)));
    assert!(up.take_fired());
    assert_eq!(
        serde_json::to_string(&Hold::PitchDown).unwrap(),
        "\"pitchDown\""
    );
}

#[test]
fn recipes_saved_with_the_old_rotate_names_still_load() {
    let old: Hold = serde_json::from_str("\"rotateClockwise\"").unwrap();
    assert_eq!(old, Hold::RollClockwise);
    let old: Hold = serde_json::from_str("\"rotateCounterClockwise\"").unwrap();
    assert_eq!(old, Hold::RollCounterClockwise);
    // And it is written back under the new name.
    assert_eq!(
        serde_json::to_string(&Hold::RollClockwise).unwrap(),
        "\"rollClockwise\""
    );
}

fn model_recipe(action: Action, label: &str, hold: ModelHold, stages: Vec<Stage>) -> Recipe {
    let mut stages = stages;
    stages.insert(
        0,
        Stage::Model {
            label: label.into(),
            hold,
        },
    );
    Recipe {
        action,
        keys: None,
        apps: Vec::new(),
        ..recipe("m", stages, Device::default_for(DeviceKind::RotationKnob))
    }
}

#[test]
fn model_steps_validate_their_label_and_only_one_shots_are_limited_to_buttons() {
    let trigger = |label: &str, hold| model_recipe(Action::PlayPause, label, hold, vec![]);
    assert_eq!(
        validate_recipe(&trigger("snap", ModelHold::OneShot)),
        Ok(())
    );
    assert_eq!(validate_recipe(&trigger("snap", ModelHold::Held)), Ok(()));
    for bad in ["", "Snap", "1snap", "a-b", "a b", &"a".repeat(49)] {
        assert_eq!(
            validate_recipe(&trigger(bad, ModelHold::Held)),
            Err(RecipeError::InvalidLabel),
            "{bad:?}"
        );
    }
    let drive = vec![Stage::Drive {
        axis: Axis::Roll,
        dead_zone_degrees: 0.0,
        invert: false,
    }];
    assert_eq!(
        validate_recipe(&model_recipe(
            Action::Volume,
            "fist",
            ModelHold::Held,
            drive.clone()
        )),
        Ok(())
    );
    assert_eq!(
        validate_recipe(&model_recipe(
            Action::Volume,
            "fist",
            ModelHold::OneShot,
            drive
        )),
        Ok(())
    );
    let twice = vec![Stage::Model {
        label: "snap".into(),
        hold: ModelHold::OneShot,
    }];
    assert_eq!(
        validate_recipe(&model_recipe(
            Action::PlayPause,
            "snap",
            ModelHold::OneShot,
            twice
        )),
        Err(RecipeError::RepeatedStage)
    );
}

#[test]
fn a_model_step_reads_the_held_or_pulsed_sets_the_host_supplies() {
    use std::collections::BTreeSet;
    let held: BTreeSet<String> = ["fist".to_string()].into();
    let none = BTreeSet::new();
    let mut held_runner = RecipeRunner::new(model_recipe(
        Action::PlayPause,
        "fist",
        ModelHold::Held,
        vec![],
    ));
    let mut shot_runner = RecipeRunner::new(model_recipe(
        Action::PlayPause,
        "fist",
        ModelHold::OneShot,
        vec![],
    ));
    let signals = Signals {
        models_held: Some(&held),
        models_pulsed: Some(&none),
        ..Signals::default()
    };
    held_runner.update(&signals);
    shot_runner.update(&signals);
    assert!(held_runner.take_fired());
    // A label that is merely held is not a one-shot: it needs a fresh rising edge.
    assert!(!shot_runner.take_fired());
    // Absent sets (a host that has no models) hold nothing.
    let mut empty = RecipeRunner::new(model_recipe(
        Action::PlayPause,
        "fist",
        ModelHold::Held,
        vec![],
    ));
    empty.update(&Signals::default());
    assert!(!empty.take_fired());
}

fn camera_recipe(action: Action, gesture: &str, hold: ModelHold) -> Recipe {
    Recipe {
        action,
        keys: None,
        apps: Vec::new(),
        ..recipe(
            "c",
            vec![Stage::Camera {
                gesture: gesture.into(),
                hold,
            }],
            Device::default_for(DeviceKind::RotationKnob),
        )
    }
}

#[test]
fn camera_steps_validate_their_gesture_id_and_only_one_shots_are_limited_to_buttons() {
    assert_eq!(
        validate_recipe(&camera_recipe(
            Action::PlayPause,
            "gesture-1a2b3c4d",
            ModelHold::OneShot
        )),
        Ok(())
    );
    for bad in ["", "has space", "../x", &"a".repeat(65)] {
        assert_eq!(
            validate_recipe(&camera_recipe(Action::PlayPause, bad, ModelHold::Held)),
            Err(RecipeError::InvalidCameraGesture),
            "{bad:?}"
        );
    }
    // A held camera gesture can keep a dial turning (with a wrist rotation last); a one-shot cannot.
    let with_drive = |hold| {
        let mut r = camera_recipe(Action::Volume, "gesture-1", hold);
        r.stages.push(Stage::Drive {
            axis: Axis::Roll,
            dead_zone_degrees: 0.0,
            invert: false,
        });
        r
    };
    assert_eq!(validate_recipe(&with_drive(ModelHold::Held)), Ok(()));
    assert_eq!(validate_recipe(&with_drive(ModelHold::OneShot)), Ok(()));
}

#[test]
fn a_camera_step_reads_the_held_or_pulsed_sets_the_host_supplies_and_ignores_model_sets() {
    use std::collections::BTreeSet;
    let held: BTreeSet<String> = ["gesture-1".to_string()].into();
    let none = BTreeSet::new();
    let mut held_runner = RecipeRunner::new(camera_recipe(
        Action::PlayPause,
        "gesture-1",
        ModelHold::Held,
    ));
    let mut shot_runner = RecipeRunner::new(camera_recipe(
        Action::PlayPause,
        "gesture-1",
        ModelHold::OneShot,
    ));
    let signals = Signals {
        cameras_held: Some(&held),
        cameras_pulsed: Some(&none),
        ..Signals::default()
    };
    held_runner.update(&signals);
    shot_runner.update(&signals);
    assert!(held_runner.take_fired());
    assert!(!shot_runner.take_fired());
    // A model label with the same name does not stand in for a camera gesture.
    let mut other = RecipeRunner::new(camera_recipe(
        Action::PlayPause,
        "gesture-1",
        ModelHold::Held,
    ));
    other.update(&Signals {
        models_held: Some(&held),
        ..Signals::default()
    });
    assert!(!other.take_fired());
    let mut empty = RecipeRunner::new(camera_recipe(
        Action::PlayPause,
        "gesture-1",
        ModelHold::Held,
    ));
    empty.update(&Signals::default());
    assert!(!empty.take_fired());
}

#[test]
fn a_camera_step_round_trips_through_json_in_camel_case() {
    let stage = Stage::Camera {
        gesture: "gesture-1".into(),
        hold: ModelHold::OneShot,
    };
    let json = serde_json::to_string(&stage).unwrap();
    assert_eq!(
        json,
        r#"{"kind":"camera","gesture":"gesture-1","hold":"oneShot"}"#
    );
    assert_eq!(serde_json::from_str::<Stage>(&json).unwrap(), stage);
}

fn paired_recipe() -> Recipe {
    let mut stages = chain();
    stages[1] = Stage::ModelPair {
        start_label: "pinch_in".into(),
        end_label: "pinch_out".into(),
    };
    recipe(
        "paired",
        stages,
        Device::RotationKnob {
            fraction_per_degree: 0.01,
        },
    )
}

#[test]
fn paired_pinch_releases_to_ready_and_regrabs_at_the_current_wrist_angle() {
    let mut runner = RecipeRunner::new(paired_recipe());
    let start = ["pinch_in".to_string()].into_iter().collect();
    let end = ["pinch_out".to_string()].into_iter().collect();
    let mut input = signals(Some("topRight"), false, 0.0);
    runner.update(&input);
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    input.model_edges = Some(&start);
    runner.update(&input);
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    input.model_edges = None;
    input.orientation = Some(about_x(10.25));
    assert!((runner.update(&input).unwrap().delta_fraction - 0.1025).abs() < 1e-9);
    // Silence between detections is a hold, including an exactly stationary wrist.
    assert_eq!(runner.update(&input).unwrap().delta_fraction, 0.0);
    input.model_edges = Some(&start); // duplicate does not rebase the knob
    input.orientation = Some(about_x(5.0));
    assert!((runner.update(&input).unwrap().delta_fraction + 0.0525).abs() < 1e-9);
    input.model_edges = Some(&end);
    assert_eq!(runner.update(&input), None);
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    // Unheld rotation cannot change volume. No head movement is needed to grab again.
    input.model_edges = None;
    input.orientation = Some(about_x(60.0));
    assert_eq!(runner.update(&input), None);
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    input.model_edges = Some(&start);
    assert_eq!(runner.update(&input), None); // rebase; no jump
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    input.model_edges = None;
    input.orientation = Some(about_x(62.0));
    assert!((runner.update(&input).unwrap().delta_fraction - 0.02).abs() < 1e-9);
    input.head_location = None;
    assert_eq!(runner.update(&input), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
}

#[test]
fn paired_pinch_needs_a_fresh_start_and_release_wins() {
    let mut runner = RecipeRunner::new(paired_recipe());
    let start = ["pinch_in".to_string()].into_iter().collect();
    let both = ["pinch_in".to_string(), "pinch_out".to_string()]
        .into_iter()
        .collect();
    let mut input = signals(None, false, 0.0);
    input.model_edges = Some(&start);
    runner.update(&input);
    input.head_location = Some("topRight");
    input.model_edges = None;
    runner.update(&input);
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    input.model_edges = Some(&both);
    runner.update(&input);
    assert_eq!(runner.phase(), RunnerPhase::Armed);
    input.model_edges = Some(&start);
    runner.update(&input);
    runner.cancel();
    runner.update(&input);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
}

#[test]
fn paired_recipe_validation_and_serialization() {
    let recipe = paired_recipe();
    validate_recipe(&recipe).unwrap();
    let json = serde_json::to_string(&recipe).unwrap();
    assert!(json.contains("startLabel"));
    assert_eq!(serde_json::from_str::<Recipe>(&json).unwrap(), recipe);
    let mut bad = recipe.clone();
    bad.stages[1] = Stage::ModelPair {
        start_label: "pinch_in".into(),
        end_label: "pinch_in".into(),
    };
    assert!(validate_recipe(&bad).is_err());
    bad = recipe;
    bad.action = Action::PlayPause;
    assert!(validate_recipe(&bad).is_err());
}

fn toggle_dial(hold: Hold) -> RecipeRunner {
    RecipeRunner::new(recipe(
        "toggle",
        vec![
            Stage::Hold { hold },
            Stage::Drive {
                axis: Axis::Roll,
                dead_zone_degrees: 0.0,
                invert: false,
            },
        ],
        Device::RotationKnob {
            fraction_per_degree: 0.01,
        },
    ))
}

/// A reading at `ms` with the wrist rolled `roll` degrees, and whether a double tap still counts as happening.
fn tapped(ms: u64, double_tap: bool, roll: f64) -> Signals<'static> {
    Signals {
        tap: double_tap.then_some(TapKind::Double),
        orientation: Some(about_x(roll)),
        now_ns: Some(ms * 1_000_000),
        ..Signals::default()
    }
}

#[test]
fn a_momentary_step_switches_a_dial_on_and_the_next_one_switches_it_off() {
    let mut runner = toggle_dial(Hold::DoubleTap);
    // Rolling without the double tap does nothing.
    assert_eq!(runner.update(&tapped(0, false, 20.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    // The double tap switches it on; the angle then is where the dial starts from.
    assert_eq!(runner.update(&tapped(100, true, 20.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    // It stays on while the tap still counts and after it has passed.
    let moved = runner.update(&tapped(300, true, 30.0)).unwrap();
    assert!((moved.delta_fraction - 0.10).abs() < 1e-9);
    let moved = runner.update(&tapped(900, false, 35.0)).unwrap();
    assert!((moved.delta_fraction - 0.05).abs() < 1e-9);
    // A second double tap switches it off, and the wrist is free again.
    assert_eq!(runner.update(&tapped(2000, true, 35.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    assert_eq!(runner.update(&tapped(2100, true, 60.0)), None);
    assert_eq!(runner.update(&tapped(2700, false, 80.0)), None);
    // A third switches it on again, starting from where the wrist is now.
    assert_eq!(runner.update(&tapped(4000, true, 80.0)), None);
    let moved = runner.update(&tapped(4100, true, 81.0)).unwrap();
    assert!((moved.delta_fraction - 0.01).abs() < 1e-9);
}

#[test]
fn a_switched_on_dial_goes_off_by_itself_when_left_alone_or_when_another_step_lets_go() {
    let mut runner = toggle_dial(Hold::Shake);
    let shaken = |ms: u64, shake: bool, roll: f64| Signals {
        shake,
        orientation: Some(about_x(roll)),
        now_ns: Some(ms * 1_000_000),
        ..Signals::default()
    };
    runner.update(&shaken(0, true, 0.0));
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    assert!(runner.update(&shaken(1000, false, 5.0)).is_some());
    // Still on six seconds after it last moved, off just after.
    runner.update(&shaken(7000, false, 5.0));
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    runner.update(&shaken(7100, false, 5.0));
    assert_eq!(runner.phase(), RunnerPhase::Idle);
    assert_eq!(runner.update(&shaken(7200, false, 40.0)), None);

    // With a head location in the chain, looking away switches it off, and looking back does not switch it on.
    let mut gated = RecipeRunner::new(recipe(
        "gated",
        vec![
            Stage::HeadAt {
                location: "topRight".into(),
            },
            Stage::Hold { hold: Hold::Hammer },
            Stage::Drive {
                axis: Axis::Roll,
                dead_zone_degrees: 0.0,
                invert: false,
            },
        ],
        Device::RotationKnob {
            fraction_per_degree: 0.01,
        },
    ));
    let at = |head: Option<&'static str>, hammer: bool, roll: f64| Signals {
        head_location: head,
        hammer,
        orientation: Some(about_x(roll)),
        ..Signals::default()
    };
    gated.update(&at(None, true, 0.0));
    assert_eq!(
        gated.phase(),
        RunnerPhase::Idle,
        "a blow while looking elsewhere"
    );
    gated.update(&at(None, false, 0.0));
    gated.update(&at(Some("topRight"), true, 0.0));
    assert_eq!(gated.phase(), RunnerPhase::Driving);
    gated.update(&at(None, false, 10.0));
    assert_eq!(gated.phase(), RunnerPhase::Idle);
    gated.update(&at(Some("topRight"), false, 10.0));
    assert_eq!(gated.phase(), RunnerPhase::Armed);
}

#[test]
fn cancelling_a_switched_on_dial_keeps_it_off_and_a_pair_cannot_be_mixed_with_a_momentary_step() {
    let mut runner = toggle_dial(Hold::DoubleTap);
    runner.update(&tapped(0, true, 0.0));
    assert_eq!(runner.phase(), RunnerPhase::Driving);
    runner.cancel();
    assert_eq!(runner.update(&tapped(100, true, 30.0)), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);

    let mixed = recipe(
        "mixed",
        vec![
            Stage::ModelPair {
                start_label: "pinch_in".into(),
                end_label: "pinch_out".into(),
            },
            Stage::Hold { hold: Hold::Shake },
            Stage::Drive {
                axis: Axis::Roll,
                dead_zone_degrees: 0.0,
                invert: false,
            },
        ],
        Device::default_for(DeviceKind::RotationKnob),
    );
    assert_eq!(validate_recipe(&mixed), Err(RecipeError::InvalidModelPair));
}

#[test]
fn a_directional_shake_a_wiggle_and_a_hammer_each_fire_only_their_own_step() {
    let fires = |hold: Hold, signals: Signals<'static>| {
        let mut runner = RecipeRunner::new(trigger(vec![Stage::Hold { hold }]));
        runner.update(&signals);
        runner.take_fired()
    };
    let shake = |axis| Signals {
        shake: true,
        shake_axis: axis,
        ..Signals::default()
    };
    assert!(fires(Hold::ShakeVertical, shake(Some(ShakeAxis::Vertical))));
    assert!(!fires(
        Hold::ShakeVertical,
        shake(Some(ShakeAxis::Sideways))
    ));
    assert!(!fires(Hold::ShakeAlong, shake(None)));
    assert!(
        fires(Hold::Shake, shake(Some(ShakeAxis::Along))),
        "any shake is a shake"
    );
    assert!(fires(Hold::ShakeSideways, shake(Some(ShakeAxis::Sideways))));
    let wiggle = Signals {
        wiggle: true,
        ..Signals::default()
    };
    let hammer = Signals {
        hammer: true,
        ..Signals::default()
    };
    assert!(fires(Hold::Wiggle, wiggle) && !fires(Hold::Hammer, wiggle));
    assert!(fires(Hold::Hammer, hammer) && !fires(Hold::Shake, hammer));
    assert_eq!(
        serde_json::to_string(&Hold::ShakeVertical).unwrap(),
        "\"shakeVertical\""
    );
    assert_eq!(serde_json::to_string(&Hold::Hammer).unwrap(), "\"hammer\"");
}

#[test]
fn a_shortcut_recipe_needs_its_keys_and_only_the_same_shortcut_conflicts() {
    let shortcut = |id: &str, keys: Option<&str>| Recipe {
        id: id.into(),
        action: Action::Shortcut,
        keys: keys.map(Into::into),
        ..trigger(vec![Stage::Hold { hold: Hold::Hammer }])
    };
    assert_eq!(validate_recipe(&shortcut("a", Some("cmd+shift+4"))), Ok(()));
    assert_eq!(
        validate_recipe(&shortcut("a", None)),
        Err(RecipeError::MissingKeys)
    );
    assert_eq!(
        validate_recipe(&shortcut("a", Some("  "))),
        Err(RecipeError::MissingKeys)
    );
    assert!(Action::Shortcut.is_trigger());
    let with_drive = Recipe {
        stages: chain(),
        ..shortcut("a", Some("f5"))
    };
    assert_eq!(
        validate_recipe(&with_drive),
        Err(RecipeError::TriggerHasDrive)
    );

    let (a, b, same) = (
        shortcut("a", Some("cmd+shift+4")),
        shortcut("b", Some("f5")),
        shortcut("c", Some("Cmd+Shift+4 ")),
    );
    assert!(find_conflicts(&[a.clone(), b.clone()]).is_empty());
    let clash = find_conflicts(&[a, b, same]);
    assert_eq!(clash.len(), 1);
    assert_eq!(
        (clash[0].first.as_str(), clash[0].second.as_str()),
        ("a", "c")
    );
    // An old recipe file has no keys at all.
    let old: Recipe = serde_json::from_str(
        r#"{"id":"x","name":"x","enabled":true,"stages":[],"device":{"kind":"rotationKnob","fractionPerDegree":0.01},"action":"volume"}"#,
    )
    .unwrap();
    assert_eq!(old.keys, None);
    assert!(!serde_json::to_string(&old).unwrap().contains("keys"));
}

#[test]
fn a_recipe_for_some_apps_runs_only_in_them_and_does_not_clash_with_one_for_other_apps() {
    let volume = |id: &str, apps: &[&str]| Recipe {
        id: id.into(),
        apps: apps.iter().map(|app| (*app).to_string()).collect(),
        ..recipe(id, chain(), Device::default_for(DeviceKind::RotationKnob))
    };
    let everywhere = volume("everywhere", &[]);
    let music = volume("music", &["Spotify", "Music"]);
    let browser = volume("browser", &["Safari"]);
    assert!(everywhere.runs_in(None) && everywhere.runs_in(Some("Anything")));
    assert!(music.runs_in(Some("spotify ")) && music.runs_in(Some("Music")));
    assert!(!music.runs_in(Some("Safari")));
    assert!(
        !music.runs_in(None),
        "not knowing the app in front is not a match"
    );

    assert!(find_conflicts(&[music.clone(), browser.clone()]).is_empty());
    assert_eq!(
        find_conflicts(&[music.clone(), volume("also", &["MUSIC"])]).len(),
        1
    );
    // One that works everywhere clashes with every other on the same resource.
    assert_eq!(
        find_conflicts(&[everywhere, music.clone(), browser]).len(),
        2
    );

    assert_eq!(validate_recipe(&music), Ok(()));
    assert_eq!(
        validate_recipe(&volume("twice", &["Safari", "safari"])),
        Err(RecipeError::InvalidApps)
    );
    assert_eq!(
        validate_recipe(&volume("blank", &[" "])),
        Err(RecipeError::InvalidApps)
    );
    let many: Vec<String> = (0..9).map(|i| format!("App {i}")).collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    assert_eq!(
        validate_recipe(&volume("many", &many)),
        Err(RecipeError::InvalidApps)
    );
    // A recipe saved before apps existed works everywhere, and one with none is saved without the field.
    assert!(
        !serde_json::to_string(&volume("x", &[]))
            .unwrap()
            .contains("apps")
    );
}
