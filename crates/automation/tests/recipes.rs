use automation::*;

fn recipe(id: &str, stages: Vec<Stage>, device: Device) -> Recipe {
    Recipe {
        id: id.into(),
        name: id.into(),
        enabled: true,
        stages,
        device,
        action: Action::Volume,
    }
}

fn chain() -> Vec<Stage> {
    vec![
        Stage::HeadAt {
            location: "topRight".into(),
        },
        Stage::Hold { hold: Hold::Pinch },
        Stage::Drive { axis: Axis::Roll },
    ]
}

fn signals(head: Option<&'static str>, pinch: bool, roll: f64) -> Signals<'static> {
    Signals {
        head_location: head,
        pinch_held: pinch,
        roll: Some(roll),
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
    assert_eq!(runner.phase(), RunnerPhase::Idle);
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
        pinch_held: true,
        ..Signals::default()
    };
    assert_eq!(runner.update(&no_orientation), None);
    assert_eq!(runner.phase(), RunnerPhase::Idle);
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
        validate_recipe(&recipe("a", vec![Stage::Hold { hold: Hold::Pinch }], knob)),
        Err(RecipeError::MustEndWithDrive)
    );
    assert_eq!(
        validate_recipe(&recipe(
            "a",
            vec![
                Stage::Drive { axis: Axis::Roll },
                Stage::Drive { axis: Axis::Pitch }
            ],
            knob
        )),
        Err(RecipeError::DriveNotLast)
    );
    let repeated = vec![
        Stage::Hold { hold: Hold::Pinch },
        Stage::Hold { hold: Hold::Pinch },
        Stage::Drive { axis: Axis::Roll },
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
            Stage::Drive { axis: Axis::Roll },
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
