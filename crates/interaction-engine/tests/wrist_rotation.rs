use interaction_engine::{WristRotation, WristRotationConfig, WristRotationError};

const IDENTITY: [f64; 4] = [1.0, 0.0, 0.0, 0.0];
const ACTIVATION_VOLUME: f32 = 50.0;

// The forearm's long axis runs through the watch's 9-3 (quaternion i/X)
// direction: the band wraps circumferentially through the 12/6 lugs, so
// 12-6 (Y) goes around the wrist and 9-3 (X) runs along the arm. Confirmed
// against real Watch hardware, where a physical wrist roll produced no
// signal on the previously-used Y axis.
fn rotated_around_forearm(degrees: f64) -> [f64; 4] {
    let half = degrees.to_radians() / 2.0;
    [half.cos(), half.sin(), 0.0, 0.0]
}

// A rotation around the watch's 12-6 (Y) axis: around-the-wrist motion, not
// a forearm twist. Real Y-axis Watch hardware traffic must never move the
// volume -- that exact confusion (treating Y as the roll axis) is why a
// physical wrist roll previously produced no volume change at all.
fn rotated_around_wrist_circumference(degrees: f64) -> [f64; 4] {
    let half = degrees.to_radians() / 2.0;
    [half.cos(), 0.0, half.sin(), 0.0]
}

// Both the Watch-button path and the desktop-model path must funnel through
// `begin_with_config` to start a volume interaction; these tests exercise
// that single entry point so the two callers can never diverge.

#[test]
fn observe_before_any_begin_is_a_silent_no_op() {
    let mut rotation = WristRotation::default();
    assert!(!rotation.is_active());
    let target = rotation
        .observe(rotated_around_forearm(20.0), 1_000)
        .unwrap();
    assert_eq!(target, 0.0);
}

#[test]
fn begin_with_config_establishes_a_fresh_reference_and_allows_relative_rotation() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    assert!(rotation.is_active());

    // Small rotation stays inside the dead zone: target holds at the
    // activation baseline.
    let inside_dead_zone = rotation
        .observe(rotated_around_forearm(1.0), 100_000_000)
        .unwrap();
    assert_eq!(inside_dead_zone, f64::from(ACTIVATION_VOLUME));

    // A larger relative rotation clears the dead zone and raises the target
    // above the activation baseline.
    let beyond_dead_zone = rotation
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(beyond_dead_zone > f64::from(ACTIVATION_VOLUME));
}

#[test]
fn begin_with_config_rejects_invalid_configuration_without_mutating_state() {
    let mut rotation = WristRotation::default();
    let invalid = WristRotationConfig {
        dead_zone_degrees: -1.0,
        ..Default::default()
    };

    let error = rotation
        .begin_with_config(invalid, IDENTITY, 0, ACTIVATION_VOLUME)
        .unwrap_err();
    assert_eq!(error, WristRotationError::InvalidConfiguration);

    // Failed initialization must leave no partial grab/reference behind.
    assert!(!rotation.is_active());
    assert_eq!(
        rotation.observe(rotated_around_forearm(20.0), 1).unwrap(),
        0.0
    );
}

#[test]
fn begin_with_config_rejects_invalid_quaternion_without_mutating_config() {
    let mut rotation = WristRotation::default();
    let error = rotation
        .begin_with_config(
            WristRotationConfig::default(),
            [0.0, 0.0, 0.0, 0.0],
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap_err();
    assert!(matches!(error, WristRotationError::InvalidQuaternion(_)));
    assert!(!rotation.is_active());
}

#[test]
fn begin_with_config_rejects_non_finite_activation_volume_without_mutating_state() {
    let mut rotation = WristRotation::default();
    let error = rotation
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0, f32::NAN)
        .unwrap_err();
    assert_eq!(error, WristRotationError::InvalidConfiguration);
    assert!(!rotation.is_active());
}

#[test]
fn end_clears_the_reference_so_future_observations_stay_safely_inert() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    rotation
        .observe(rotated_around_forearm(20.0), 100_000_000)
        .unwrap();

    rotation.end();
    assert!(!rotation.is_active());
    let after_release = rotation
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert_eq!(after_release, 0.0);
}

#[test]
fn last_relative_degrees_tracks_raw_roll_independent_of_dead_zone_and_clears_on_end() {
    let mut rotation = WristRotation::default();
    assert_eq!(rotation.last_relative_degrees(), None);

    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    assert_eq!(rotation.last_relative_degrees(), None);

    // Inside the dead zone: target holds at baseline, but the raw roll must
    // still be visible for diagnostics (e.g. proving the wrist is moving at
    // all).
    let inside_dead_zone = rotation
        .observe(rotated_around_forearm(1.0), 100_000_000)
        .unwrap();
    assert_eq!(inside_dead_zone, f64::from(ACTIVATION_VOLUME));
    assert!((rotation.last_relative_degrees().unwrap() - 1.0).abs() < 1e-6);

    let beyond_dead_zone = rotation
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(beyond_dead_zone > f64::from(ACTIVATION_VOLUME));
    assert!((rotation.last_relative_degrees().unwrap() - 20.0).abs() < 1e-6);

    rotation.end();
    assert_eq!(rotation.last_relative_degrees(), None);
}

#[test]
fn re_beginning_after_a_release_starts_from_a_fresh_reference_with_no_carried_state() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    rotation
        .observe(rotated_around_forearm(40.0), 100_000_000)
        .unwrap();
    rotation.end();

    // A second interaction (e.g. model grab following a button release, or
    // vice versa) begins relative to its own new starting pose and its own
    // fresh activation volume, not anything left over from the previous
    // interaction.
    let start_of_second_interaction = rotated_around_forearm(40.0);
    let second_activation_volume = 80.0;
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            start_of_second_interaction,
            1_000_000_000,
            second_activation_volume,
        )
        .unwrap();
    let target_at_same_absolute_orientation = rotation
        .observe(start_of_second_interaction, 1_100_000_000)
        .unwrap();
    assert_eq!(
        target_at_same_absolute_orientation,
        f64::from(second_activation_volume)
    );
}

// Sign convention: a positive rotation around the forearm (quaternion i)
// axis is "clockwise" and must always raise volume above the activation
// baseline by default; `invert_direction` exists solely to correct a Watch
// physically mounted/worn with the opposite handedness, and must flip both
// directions together, never just one.
#[test]
fn clockwise_forearm_rotation_raises_volume_by_default() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    let target = rotation
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(
        target > f64::from(ACTIVATION_VOLUME),
        "clockwise twist must increase volume, got {target}"
    );
}

#[test]
fn counter_clockwise_forearm_rotation_lowers_volume_by_default() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    let target = rotation
        .observe(rotated_around_forearm(-20.0), 200_000_000)
        .unwrap();
    assert!(
        target < f64::from(ACTIVATION_VOLUME),
        "counter-clockwise twist must decrease volume, got {target}"
    );
}

#[test]
fn invert_direction_flips_both_signs_for_a_reversed_watch_mounting() {
    let config = WristRotationConfig {
        invert_direction: true,
        ..WristRotationConfig::default()
    };

    let mut clockwise = WristRotation::default();
    clockwise
        .begin_with_config(config, IDENTITY, 0, ACTIVATION_VOLUME)
        .unwrap();
    let clockwise_target = clockwise
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(
        clockwise_target < f64::from(ACTIVATION_VOLUME),
        "inverted config must lower volume on a physically clockwise twist, got {clockwise_target}"
    );

    let mut counter_clockwise = WristRotation::default();
    counter_clockwise
        .begin_with_config(config, IDENTITY, 0, ACTIVATION_VOLUME)
        .unwrap();
    let counter_clockwise_target = counter_clockwise
        .observe(rotated_around_forearm(-20.0), 200_000_000)
        .unwrap();
    assert!(
        counter_clockwise_target > f64::from(ACTIVATION_VOLUME),
        "inverted config must raise volume on a physically counter-clockwise twist, got {counter_clockwise_target}"
    );
}

// Regression for the real-hardware failure: rolling the Watch produced no
// volume change because the code read the wrong quaternion axis (Y, around
// the wrist) instead of the forearm's actual twist axis (X). A rotation on
// the Y axis alone -- what the old, wrong extraction responded to -- must
// stay inert now.
#[test]
fn rotation_around_the_wrist_circumference_axis_produces_no_volume_change() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    let target = rotation
        .observe(rotated_around_wrist_circumference(20.0), 200_000_000)
        .unwrap();
    assert_eq!(
        target,
        f64::from(ACTIVATION_VOLUME),
        "rotation around the wrist-circumference (Y) axis must not move volume, got {target}"
    );
}

#[test]
fn observe_after_begin_still_enforces_monotonic_timestamps() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            1_000,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    let error = rotation
        .observe(rotated_around_forearm(20.0), 500)
        .unwrap_err();
    assert_eq!(error, WristRotationError::NonMonotonicTimestamp);
}

// GC-035 follow-up: absolute wrist-volume mapping.

#[test]
fn target_volume_is_activation_volume_plus_signed_roll_times_sensitivity() {
    let config = WristRotationConfig::default();
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(config, IDENTITY, 0, ACTIVATION_VOLUME)
        .unwrap();
    let degrees = 20.0;
    let target = rotation
        .observe(rotated_around_forearm(degrees), 200_000_000)
        .unwrap();

    let dead_zoned = degrees - config.dead_zone_degrees;
    let expected = f64::from(ACTIVATION_VOLUME) + dead_zoned * config.volume_points_per_degree;
    assert!(
        (target - expected).abs() < 1e-9,
        "expected {expected}, got {target}"
    );
}

#[test]
fn holding_a_fixed_angle_holds_a_fixed_volume_across_many_samples() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    let held = rotated_around_forearm(25.0);

    let first = rotation.observe(held, 100_000_000).unwrap();
    for tick in 2..50u64 {
        let target = rotation.observe(held, tick * 100_000_000).unwrap();
        assert_eq!(
            target, first,
            "target must not drift while the wrist angle is held fixed"
        );
    }
}

#[test]
fn no_drift_across_repeated_identical_orientation_samples() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();
    let sample = rotated_around_forearm(10.0);

    let mut previous = rotation.observe(sample, 100_000_000).unwrap();
    for tick in 2..200u64 {
        let target = rotation.observe(sample, tick * 100_000_000).unwrap();
        assert_eq!(
            target, previous,
            "identical samples must never accumulate drift"
        );
        previous = target;
    }
}

#[test]
fn returning_to_the_reference_angle_restores_the_activation_volume() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();

    // Spaced a full second apart so none of these swings trips the
    // velocity-outlier guard (default cap: 360 degrees/second).
    rotation
        .observe(rotated_around_forearm(45.0), 1_000_000_000)
        .unwrap();
    rotation
        .observe(rotated_around_forearm(-30.0), 2_000_000_000)
        .unwrap();
    rotation
        .observe(rotated_around_forearm(70.0), 3_000_000_000)
        .unwrap();

    let restored = rotation.observe(IDENTITY, 4_000_000_000).unwrap();
    assert_eq!(
        restored,
        f64::from(ACTIVATION_VOLUME),
        "returning to the reference angle must restore the activation volume exactly"
    );
}

#[test]
fn target_volume_clamps_to_the_valid_system_range() {
    let config = WristRotationConfig {
        volume_points_per_degree: 5.0,
        ..WristRotationConfig::default()
    };

    let mut high = WristRotation::default();
    high.begin_with_config(config, IDENTITY, 0, 90.0).unwrap();
    let clamped_high = high
        .observe(rotated_around_forearm(60.0), 200_000_000)
        .unwrap();
    assert_eq!(clamped_high, 100.0);

    let mut low = WristRotation::default();
    low.begin_with_config(config, IDENTITY, 0, 10.0).unwrap();
    let clamped_low = low
        .observe(rotated_around_forearm(-60.0), 200_000_000)
        .unwrap();
    assert_eq!(clamped_low, 0.0);
}

#[test]
fn velocity_outlier_freezes_the_previous_target_instead_of_jumping() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            IDENTITY,
            0,
            ACTIVATION_VOLUME,
        )
        .unwrap();

    let settled = rotation
        .observe(rotated_around_forearm(15.0), 100_000_000)
        .unwrap();

    // A huge rotation in a tiny time window exceeds
    // `max_angular_velocity_degrees_per_second`; the target must freeze at
    // the last accepted value rather than jump to the outlier's implied one.
    let outlier = rotation
        .observe(rotated_around_forearm(150.0), 100_001_000)
        .unwrap();
    assert_eq!(outlier, settled);
}
