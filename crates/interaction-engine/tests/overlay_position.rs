use interaction_engine::top_right_overlay_position;

#[test]
fn positions_a_logical_overlay_against_the_destination_monitors_physical_work_area() {
    assert_eq!(
        top_right_overlay_position((0, 0), (3840, 2160), (320.0, 320.0), 2.0, 16.0),
        Some((3168, 32)),
    );
}

#[test]
fn supports_negative_monitor_origins_and_clamps_oversized_overlays() {
    assert_eq!(
        top_right_overlay_position((-1920, -120), (1920, 1080), (320.0, 320.0), 1.5, 16.0,),
        Some((-504, -96)),
    );
    assert_eq!(
        top_right_overlay_position((100, 50), (300, 200), (400.0, 200.0), 1.0, 16.0),
        Some((116, 66)),
    );
}

#[test]
fn rejects_invalid_geometry() {
    assert_eq!(
        top_right_overlay_position((0, 0), (1920, 1080), (320.0, 320.0), 0.0, 16.0),
        None,
    );
    assert_eq!(
        top_right_overlay_position((0, 0), (1920, 1080), (f64::NAN, 320.0), 1.0, 16.0),
        None,
    );
}

#[test]
fn rejects_geometry_that_would_overflow_position_arithmetic() {
    assert_eq!(
        top_right_overlay_position(
            (i32::MIN, i32::MIN),
            (u32::MAX, u32::MAX),
            (i64::MAX as f64, 1.0),
            1.0,
            i64::MAX as f64,
        ),
        None,
    );
}
