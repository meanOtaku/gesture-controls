use std::f64::consts::FRAC_PI_2;
use std::time::Duration;

use interaction_engine::{
    CalibrationConfig, CalibrationEvent, CalibrationTarget, HeadCalibration,
    quaternion_angular_distance,
};

#[test]
fn angular_distance_uses_shortest_rotation_and_ignores_quaternion_sign() {
    let identity = [1.0, 0.0, 0.0, 0.0];
    let ninety_degrees = [(FRAC_PI_2 / 2.0).cos(), 0.0, (FRAC_PI_2 / 2.0).sin(), 0.0];

    assert!(
        (quaternion_angular_distance(identity, ninety_degrees).unwrap() - FRAC_PI_2).abs() < 1e-9
    );
    assert!(quaternion_angular_distance(identity, [-1.0, 0.0, 0.0, 0.0]).unwrap() < 1e-9);
}

#[test]
fn target_enters_only_after_remaining_inside_threshold_for_the_dwell() {
    let mut calibration = HeadCalibration::new(CalibrationConfig {
        activation_threshold_degrees: 12.0,
        dwell: Duration::from_millis(400),
    })
    .unwrap();
    let center = [1.0, 0.0, 0.0, 0.0];
    let top_right = [0.965925826, 0.0, 0.258819045, 0.0];
    calibration
        .capture(&CalibrationTarget::center(), center)
        .unwrap();
    calibration
        .capture(&CalibrationTarget::top_right(), top_right)
        .unwrap();

    assert!(
        calibration
            .observe(top_right, Duration::ZERO)
            .unwrap()
            .is_empty()
    );
    assert!(
        calibration
            .observe(top_right, Duration::from_millis(399))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        calibration
            .observe(top_right, Duration::from_millis(400))
            .unwrap(),
        vec![CalibrationEvent::TargetEntered(
            CalibrationTarget::top_right()
        )]
    );
}

#[test]
fn leaving_a_candidate_resets_dwell_and_reset_counter_invalidates_targets() {
    let mut calibration = HeadCalibration::default();
    let center = [1.0, 0.0, 0.0, 0.0];
    let top_right = [0.965925826, 0.0, 0.258819045, 0.0];
    calibration
        .capture(&CalibrationTarget::center(), center)
        .unwrap();
    calibration
        .capture(&CalibrationTarget::top_right(), top_right)
        .unwrap();

    calibration.observe(top_right, Duration::ZERO).unwrap();
    calibration
        .observe(center, Duration::from_millis(250))
        .unwrap();
    assert!(
        calibration
            .observe(top_right, Duration::from_millis(400))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        calibration
            .observe(top_right, Duration::from_millis(800))
            .unwrap(),
        vec![CalibrationEvent::TargetEntered(
            CalibrationTarget::top_right()
        )]
    );

    assert_eq!(
        calibration.deactivate(),
        vec![CalibrationEvent::TargetExited(
            CalibrationTarget::top_right()
        )]
    );
    assert!(!calibration.state().requires_recalibration);
    assert!(calibration.state().is_calibrated("center"));
    assert!(calibration.state().is_calibrated("topRight"));

    assert!(
        calibration
            .observe(top_right, Duration::from_millis(900))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        calibration
            .capture(&CalibrationTarget::center(), center)
            .unwrap(),
        Vec::<CalibrationEvent>::new()
    );
    assert_eq!(calibration.invalidate(), Vec::<CalibrationEvent>::new());
    let state = calibration.state();
    assert!(!state.is_calibrated("center"));
    assert!(!state.is_calibrated("topRight"));
    assert!(state.requires_recalibration);
}

#[test]
fn updated_threshold_and_dwell_control_activation() {
    let mut calibration = HeadCalibration::default();
    let center = [1.0, 0.0, 0.0, 0.0];
    let top_right = [0.965925826, 0.0, 0.258819045, 0.0];
    let six_degrees_from_top_right = [0.951056516, 0.0, 0.309016994, 0.0];
    calibration
        .capture(&CalibrationTarget::center(), center)
        .unwrap();
    calibration
        .capture(&CalibrationTarget::top_right(), top_right)
        .unwrap();

    calibration.update_config(5.0, 100).unwrap();
    assert!(
        calibration
            .observe(six_degrees_from_top_right, Duration::ZERO)
            .unwrap()
            .is_empty()
    );
    assert!(
        calibration
            .observe(six_degrees_from_top_right, Duration::from_millis(200))
            .unwrap()
            .is_empty()
    );

    calibration.update_config(7.0, 100).unwrap();
    calibration
        .observe(six_degrees_from_top_right, Duration::from_millis(300))
        .unwrap();
    assert_eq!(
        calibration
            .observe(six_degrees_from_top_right, Duration::from_millis(400))
            .unwrap(),
        vec![CalibrationEvent::TargetEntered(
            CalibrationTarget::top_right()
        )]
    );
    let state = calibration.state();
    assert_eq!(state.activation_threshold_degrees, 7.0);
    assert_eq!(state.dwell_ms, 100);
}

#[test]
fn angular_distance_rejects_zero_length_quaternions() {
    assert!(quaternion_angular_distance([0.0; 4], [1.0, 0.0, 0.0, 0.0]).is_err());
}

// GC-035: a corner-gated interaction (e.g. the wrist-volume demo) must stay
// open while a valid, still-generally-on-target head tracker keeps reporting
// samples -- a single noisy sample that transiently crosses the activation
// threshold is not a "confirmed" exit. Entry already required a sustained
// dwell; exit previously fired instantly on one bad sample with no symmetric
// debounce, which is the auto-close-while-still-looking-at-the-corner bug.

#[test]
fn a_single_noisy_sample_beyond_threshold_does_not_exit_an_active_target() {
    let mut calibration = HeadCalibration::new(CalibrationConfig {
        activation_threshold_degrees: 12.0,
        dwell: Duration::from_millis(400),
    })
    .unwrap();
    let center = [1.0, 0.0, 0.0, 0.0];
    let top_right = [0.965925826, 0.0, 0.258819045, 0.0];
    calibration
        .capture(&CalibrationTarget::center(), center)
        .unwrap();
    calibration
        .capture(&CalibrationTarget::top_right(), top_right)
        .unwrap();

    calibration.observe(top_right, Duration::ZERO).unwrap();
    assert_eq!(
        calibration
            .observe(top_right, Duration::from_millis(400))
            .unwrap(),
        vec![CalibrationEvent::TargetEntered(
            CalibrationTarget::top_right()
        )]
    );

    // A far-off single sample (tracker jitter, a blink-fast head twitch) --
    // must not immediately emit `TargetExited`.
    assert!(
        calibration
            .observe(center, Duration::from_millis(420))
            .unwrap()
            .is_empty(),
        "one noisy sample must not instantly drop an active target"
    );
    assert_eq!(
        calibration.state().active_target,
        Some(CalibrationTarget::top_right()),
        "target must still read active immediately after a single noisy sample"
    );

    // Recovering back onto the target before the grace period elapses must
    // cancel the pending exit entirely -- no `TargetExited` ever fires.
    assert!(
        calibration
            .observe(top_right, Duration::from_millis(450))
            .unwrap()
            .is_empty(),
        "recovering onto the target within the grace period must not emit any event"
    );
    assert_eq!(
        calibration.state().active_target,
        Some(CalibrationTarget::top_right())
    );
}

#[test]
fn a_sustained_departure_still_confirms_a_real_exit() {
    let mut calibration = HeadCalibration::new(CalibrationConfig {
        activation_threshold_degrees: 12.0,
        dwell: Duration::from_millis(400),
    })
    .unwrap();
    let center = [1.0, 0.0, 0.0, 0.0];
    let top_right = [0.965925826, 0.0, 0.258819045, 0.0];
    calibration
        .capture(&CalibrationTarget::center(), center)
        .unwrap();
    calibration
        .capture(&CalibrationTarget::top_right(), top_right)
        .unwrap();

    calibration.observe(top_right, Duration::ZERO).unwrap();
    calibration
        .observe(top_right, Duration::from_millis(400))
        .unwrap();
    assert_eq!(
        calibration.state().active_target,
        Some(CalibrationTarget::top_right())
    );

    // Sustained departure for the full dwell must still fail closed -- this
    // is a confirmed exit, not noise.
    assert!(
        calibration
            .observe(center, Duration::from_millis(420))
            .unwrap()
            .is_empty(),
        "grace period has not elapsed yet"
    );
    assert_eq!(
        calibration
            .observe(center, Duration::from_millis(820))
            .unwrap(),
        vec![CalibrationEvent::TargetExited(
            CalibrationTarget::top_right()
        )],
        "departure sustained for a full dwell must confirm the exit"
    );
    assert_eq!(calibration.state().active_target, None);
}

fn pose(yaw_degrees: f64) -> [f64; 4] {
    let half = yaw_degrees.to_radians() / 2.0;
    [half.cos(), 0.0, half.sin(), 0.0]
}

#[test]
fn an_added_location_is_detected_and_ready_needs_only_one_besides_center() {
    let mut calibration = HeadCalibration::default();
    let left = CalibrationTarget::new("leftEdge").unwrap();
    calibration.add_location(left.clone(), "Left edge").unwrap();
    assert!(calibration.state().requires_recalibration);

    calibration
        .capture(&CalibrationTarget::center(), pose(0.0))
        .unwrap();
    // Top right was never captured; Center plus the new location is enough.
    calibration.capture(&left, pose(-40.0)).unwrap();
    let state = calibration.state();
    assert!(!state.requires_recalibration);
    assert_eq!(state.targets.len(), 3);
    assert!(state.is_calibrated("leftEdge") && !state.is_calibrated("topRight"));

    calibration.observe(pose(-40.0), Duration::ZERO).unwrap();
    let events = calibration
        .observe(pose(-40.0), Duration::from_millis(500))
        .unwrap();
    assert_eq!(events, vec![CalibrationEvent::TargetEntered(left)]);
}

#[test]
fn removing_the_active_location_exits_it_and_center_cannot_be_removed() {
    let mut calibration = HeadCalibration::default();
    let top_right = CalibrationTarget::top_right();
    calibration
        .capture(&CalibrationTarget::center(), pose(0.0))
        .unwrap();
    calibration.capture(&top_right, pose(30.0)).unwrap();
    calibration.observe(pose(30.0), Duration::ZERO).unwrap();
    calibration
        .observe(pose(30.0), Duration::from_millis(500))
        .unwrap();

    let events = calibration.remove_location(&top_right).unwrap();
    assert_eq!(events, vec![CalibrationEvent::TargetExited(top_right)]);
    assert!(calibration.state().requires_recalibration);
    assert!(
        calibration
            .remove_location(&CalibrationTarget::center())
            .is_err()
    );
}

#[test]
fn locations_reject_bad_ids_names_duplicates_and_overflow() {
    assert!(CalibrationTarget::new("1bad").is_err());
    assert!(CalibrationTarget::new("has space").is_err());
    assert!(CalibrationTarget::new("").is_err());
    let mut calibration = HeadCalibration::default();
    let target = CalibrationTarget::new("desk").unwrap();
    assert!(calibration.add_location(target.clone(), "  ").is_err());
    assert!(
        calibration
            .add_location(target.clone(), &"x".repeat(33))
            .is_err()
    );
    calibration.add_location(target.clone(), "Desk").unwrap();
    assert!(calibration.add_location(target, "Desk again").is_err());
    for n in 0..interaction_engine::MAX_LOCATIONS {
        let _ =
            calibration.add_location(CalibrationTarget::new(format!("loc{n}")).unwrap(), "Spot");
    }
    assert_eq!(
        calibration.state().targets.len(),
        interaction_engine::MAX_LOCATIONS
    );
}
