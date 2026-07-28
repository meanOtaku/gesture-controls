use interaction_engine::VolumeSimulation;

#[test]
fn simulated_volume_changes_in_steps_and_stays_in_range() {
    let mut volume = VolumeSimulation::new(50.0).expect("valid initial volume");

    assert_eq!(volume.adjust(8.0), 58.0);
    assert_eq!(volume.adjust(80.0), 100.0);
    assert_eq!(volume.adjust(-150.0), 0.0);
}

#[test]
fn simulated_volume_rejects_non_finite_values() {
    assert!(VolumeSimulation::new(f32::NAN).is_err());

    let mut volume = VolumeSimulation::default();
    assert!(volume.set(f32::INFINITY).is_err());
    assert_eq!(volume.current(), 50.0);
}
