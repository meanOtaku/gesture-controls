use interaction_engine::commit_visibility_after;

#[test]
fn visibility_changes_only_after_native_transition_succeeds() {
    let mut visible = false;

    let failed = commit_visibility_after(&mut visible, true, || Err::<(), _>("show failed"));
    assert_eq!(failed, Err("show failed"));
    assert!(!visible);

    let succeeded = commit_visibility_after(&mut visible, true, || Ok::<(), &str>(()));
    assert_eq!(succeeded, Ok(()));
    assert!(visible);
}
