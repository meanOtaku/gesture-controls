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
        .capture(CalibrationTarget::Center, center)
        .unwrap();
    calibration
        .capture(CalibrationTarget::TopRight, top_right)
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
        vec![CalibrationEvent::TargetEntered(CalibrationTarget::TopRight)]
    );
}

#[test]
fn leaving_a_candidate_resets_dwell_and_reset_counter_invalidates_targets() {
    let mut calibration = HeadCalibration::default();
    let center = [1.0, 0.0, 0.0, 0.0];
    let top_right = [0.965925826, 0.0, 0.258819045, 0.0];
    calibration
        .capture(CalibrationTarget::Center, center)
        .unwrap();
    calibration
        .capture(CalibrationTarget::TopRight, top_right)
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
        vec![CalibrationEvent::TargetEntered(CalibrationTarget::TopRight)]
    );

    assert_eq!(
        calibration.deactivate(),
        vec![CalibrationEvent::TargetExited(CalibrationTarget::TopRight)]
    );
    assert!(!calibration.state().requires_recalibration);
    assert!(calibration.state().center_calibrated);
    assert!(calibration.state().top_right_calibrated);

    assert!(
        calibration
            .observe(top_right, Duration::from_millis(900))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        calibration
            .capture(CalibrationTarget::Center, center)
            .unwrap(),
        Vec::<CalibrationEvent>::new()
    );
    assert_eq!(calibration.invalidate(), Vec::<CalibrationEvent>::new());
    let state = calibration.state();
    assert!(!state.center_calibrated);
    assert!(!state.top_right_calibrated);
    assert!(state.requires_recalibration);
}

#[test]
fn updated_threshold_and_dwell_control_activation() {
    let mut calibration = HeadCalibration::default();
    let center = [1.0, 0.0, 0.0, 0.0];
    let top_right = [0.965925826, 0.0, 0.258819045, 0.0];
    let six_degrees_from_top_right = [0.951056516, 0.0, 0.309016994, 0.0];
    calibration
        .capture(CalibrationTarget::Center, center)
        .unwrap();
    calibration
        .capture(CalibrationTarget::TopRight, top_right)
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
        vec![CalibrationEvent::TargetEntered(CalibrationTarget::TopRight)]
    );
    let state = calibration.state();
    assert_eq!(state.activation_threshold_degrees, 7.0);
    assert_eq!(state.dwell_ms, 100);
}

#[test]
fn angular_distance_rejects_zero_length_quaternions() {
    assert!(quaternion_angular_distance([0.0; 4], [1.0, 0.0, 0.0, 0.0]).is_err());
}
