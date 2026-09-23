use interaction_engine::{WristRotation, WristRotationConfig, WristRotationError};

const IDENTITY: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

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
    let delta = rotation
        .observe(rotated_around_forearm(20.0), 1_000)
        .unwrap();
    assert_eq!(delta, 0.0);
}

#[test]
fn begin_with_config_establishes_a_fresh_reference_and_allows_relative_rotation() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0)
        .unwrap();
    assert!(rotation.is_active());

    // Small rotation stays inside the dead zone: no volume change yet.
    let inside_dead_zone = rotation
        .observe(rotated_around_forearm(1.0), 100_000_000)
        .unwrap();
    assert_eq!(inside_dead_zone, 0.0);

    // A larger relative rotation clears the dead zone and produces signal.
    let beyond_dead_zone = rotation
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(beyond_dead_zone > 0.0);
}

#[test]
fn begin_with_config_rejects_invalid_configuration_without_mutating_state() {
    let mut rotation = WristRotation::default();
    let invalid = WristRotationConfig {
        dead_zone_degrees: -1.0,
        ..Default::default()
    };

    let error = rotation
        .begin_with_config(invalid, IDENTITY, 0)
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
        .begin_with_config(WristRotationConfig::default(), [0.0, 0.0, 0.0, 0.0], 0)
        .unwrap_err();
    assert!(matches!(error, WristRotationError::InvalidQuaternion(_)));
    assert!(!rotation.is_active());
}

#[test]
fn end_clears_the_reference_so_future_observations_stay_safely_inert() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0)
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
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0)
        .unwrap();
    assert_eq!(rotation.last_relative_degrees(), None);

    // Inside the dead zone: no volume delta, but the raw roll must still be
    // visible for diagnostics (e.g. proving the wrist is moving at all).
    let inside_dead_zone = rotation
        .observe(rotated_around_forearm(1.0), 100_000_000)
        .unwrap();
    assert_eq!(inside_dead_zone, 0.0);
    assert!((rotation.last_relative_degrees().unwrap() - 1.0).abs() < 1e-6);

    let beyond_dead_zone = rotation
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(beyond_dead_zone > 0.0);
    assert!((rotation.last_relative_degrees().unwrap() - 20.0).abs() < 1e-6);

    rotation.end();
    assert_eq!(rotation.last_relative_degrees(), None);
}

#[test]
fn re_beginning_after_a_release_starts_from_a_fresh_reference_with_no_carried_state() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0)
        .unwrap();
    rotation
        .observe(rotated_around_forearm(40.0), 100_000_000)
        .unwrap();
    rotation.end();

    // A second interaction (e.g. model grab following a button release, or
    // vice versa) begins relative to its own new starting pose, not the
    // orientation left over from the previous interaction.
    let start_of_second_interaction = rotated_around_forearm(40.0);
    rotation
        .begin_with_config(
            WristRotationConfig::default(),
            start_of_second_interaction,
            1_000_000_000,
        )
        .unwrap();
    let delta_at_same_absolute_orientation = rotation
        .observe(start_of_second_interaction, 1_100_000_000)
        .unwrap();
    assert_eq!(delta_at_same_absolute_orientation, 0.0);
}

// Sign convention: a positive rotation around the forearm (quaternion i)
// axis is "clockwise" and must always raise volume (positive delta) by
// default; `invert_direction` exists solely to correct a Watch physically
// mounted/worn with the opposite handedness, and must flip both directions
// together, never just one.
#[test]
fn clockwise_forearm_rotation_raises_volume_by_default() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0)
        .unwrap();
    let delta = rotation
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(delta > 0.0, "clockwise twist must increase volume, got {delta}");
}

#[test]
fn counter_clockwise_forearm_rotation_lowers_volume_by_default() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0)
        .unwrap();
    let delta = rotation
        .observe(rotated_around_forearm(-20.0), 200_000_000)
        .unwrap();
    assert!(delta < 0.0, "counter-clockwise twist must decrease volume, got {delta}");
}

#[test]
fn invert_direction_flips_both_signs_for_a_reversed_watch_mounting() {
    let config = WristRotationConfig {
        invert_direction: true,
        ..WristRotationConfig::default()
    };

    let mut clockwise = WristRotation::default();
    clockwise.begin_with_config(config, IDENTITY, 0).unwrap();
    let clockwise_delta = clockwise
        .observe(rotated_around_forearm(20.0), 200_000_000)
        .unwrap();
    assert!(
        clockwise_delta < 0.0,
        "inverted config must lower volume on a physically clockwise twist, got {clockwise_delta}"
    );

    let mut counter_clockwise = WristRotation::default();
    counter_clockwise
        .begin_with_config(config, IDENTITY, 0)
        .unwrap();
    let counter_clockwise_delta = counter_clockwise
        .observe(rotated_around_forearm(-20.0), 200_000_000)
        .unwrap();
    assert!(
        counter_clockwise_delta > 0.0,
        "inverted config must raise volume on a physically counter-clockwise twist, got {counter_clockwise_delta}"
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
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 0)
        .unwrap();
    let delta = rotation
        .observe(rotated_around_wrist_circumference(20.0), 200_000_000)
        .unwrap();
    assert_eq!(
        delta, 0.0,
        "rotation around the wrist-circumference (Y) axis must not move volume, got {delta}"
    );
}

#[test]
fn observe_after_begin_still_enforces_monotonic_timestamps() {
    let mut rotation = WristRotation::default();
    rotation
        .begin_with_config(WristRotationConfig::default(), IDENTITY, 1_000)
        .unwrap();
    let error = rotation
        .observe(rotated_around_forearm(20.0), 500)
        .unwrap_err();
    assert_eq!(error, WristRotationError::NonMonotonicTimestamp);
}
