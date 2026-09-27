//! Desktop-owned, fail-closed gesture policy.
//!
//! Consumes already-classified pinch model transitions (never raw
//! probabilities or model classes) and decides only a closed set of safe
//! fixed intents, gated by [`PolicyMode`] (Off/Monitor/Live). The policy
//! guarantees a forced release whenever the input stream looks unreliable
//! (malformed confidence, out-of-order timestamps, a stale grab, an explicit
//! runtime failure report, a mode downgrade mid-grab, or an out-of-order/stale
//! raw sensor window rejected before it ever reached inference) so a stuck
//! inference pipeline can never leave the volume grab held forever.
//!
//! Releasing is always safe to actually execute -- it can only stop
//! something, never start it -- so [`PolicyDecision::live`] is only ever
//! gated behind [`PolicyMode::Live`] for intents that *initiate* an action
//! (see [`GestureIntent::requires_live_mode`]). The one thing a release is
//! gated on is whether the grab it ends was itself ever executed: a grab
//! recorded while merely monitoring never reached the desktop, so releasing
//! it must not reach the desktop either (see [`PolicyState`]).

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// A typed transition emitted by desktop-side pinch inference once it has
/// already classified a window -- the policy never re-thresholds
/// `confidence`, it is carried through for observability only.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PinchTransition {
    Started { confidence: f32, timestamp_ns: u64 },
    Held { confidence: f32, timestamp_ns: u64 },
    Released { confidence: f32, timestamp_ns: u64 },
}

impl PinchTransition {
    pub fn timestamp_ns(self) -> u64 {
        match self {
            Self::Started { timestamp_ns, .. }
            | Self::Held { timestamp_ns, .. }
            | Self::Released { timestamp_ns, .. } => timestamp_ns,
        }
    }

    fn confidence(self) -> f32 {
        match self {
            Self::Started { confidence, .. }
            | Self::Held { confidence, .. }
            | Self::Released { confidence, .. } => confidence,
        }
    }
}

/// Closed set of desktop-executed effects. Gesture classes and any future
/// custom labels must resolve to one of these -- never to an arbitrary
/// command -- which is what keeps the policy safe regardless of what a
/// model was trained to recognize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GestureIntent {
    NoAction,
    VolumeGrab,
    VolumeRelease,
    Mute,
    PlayPause,
    PreviousTrack,
    NextTrack,
}

impl GestureIntent {
    /// `true` for intents that *initiate* a real effect. These may only be
    /// executed in [`PolicyMode::Live`]. Intents that only stop or no-op are
    /// never blocked by the mode itself, since a stuck grab is a bigger risk
    /// than a redundant release -- a [`GestureIntent::VolumeRelease`] is
    /// instead gated on whether the grab it ends was actually executed (see
    /// [`GesturePolicy::release_decision`]), which is what keeps monitoring
    /// from tearing down a grab it never started.
    pub fn requires_live_mode(self) -> bool {
        !matches!(self, GestureIntent::NoAction | GestureIntent::VolumeRelease)
    }
}

/// Global activation mode, mirroring the desktop model registry's
/// `InferenceMode`. `Off` means no transitions should even be flowing, but
/// the policy still fails closed if one arrives anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyMode {
    Off,
    Monitor,
    Live,
}

/// Why the policy forced a release outside of a normal Held -> Released
/// transition. Always wins over whatever state the model/caller thinks it's in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForceReleaseReason {
    StaleModelData,
    WatchDisconnected,
    ModelRuntimeFailure,
    SensorQualityRejected,
    ModeChanged,
    /// A raw sensor window arrived out of order or duplicated a
    /// previously-seen timestamp -- rejected before it ever reached the
    /// sensor-quality gate, since a bad ordering makes any quality
    /// computation over it untrustworthy too.
    StaleSensorWindow,
    /// The active model is about to be swapped (activation or rollback) --
    /// forced before the swap so a grab classified under the outgoing
    /// model's bindings can never survive into the incoming model's
    /// lifetime, which has no reason to share its meaning.
    ModelSwapped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DecisionReason {
    Started,
    Held,
    Released,
    ForcedRelease(ForceReleaseReason),
    IgnoredNotGrabbed,
    IgnoredAlreadyGrabbed,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub intent: GestureIntent,
    pub reason: DecisionReason,
    /// Whether the caller should actually execute `intent`. `false` means
    /// the policy still ran (useful for Monitor-mode observability) but the
    /// effect must not reach any real system. For a release this tracks the
    /// grab being ended rather than the current mode, so a grab only ever
    /// recorded while monitoring is discarded silently instead of reaching
    /// the desktop on its way out.
    pub live: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PolicyState {
    Idle,
    Grabbed {
        /// Whether the `Started` that opened this grab was actually executed
        /// against the desktop, i.e. whether it was decided in
        /// [`PolicyMode::Live`]. A grab recorded while `Off`/`Monitor` never
        /// reached the overlay or the volume backend at all, so the release
        /// that ends it must not reach them either: the desktop's overlay
        /// release hides the window and ends the wrist-rotation interaction
        /// outright, which would tear down an unrelated Watch-button grab
        /// that monitoring has no business touching.
        executed: bool,
    },
}

impl PolicyState {
    fn is_grabbed(self) -> bool {
        matches!(self, PolicyState::Grabbed { .. })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GesturePolicyConfig {
    /// Forced-release timeout applied while grabbed: guards against a
    /// stalled or dead inference pipeline leaving the grab held forever if
    /// no Held/Released confirmation arrives in time.
    pub held_staleness_timeout: Duration,
}

impl Default for GesturePolicyConfig {
    fn default() -> Self {
        Self {
            held_staleness_timeout: Duration::from_millis(750),
        }
    }
}

/// The gesture policy state machine. Pure and synchronous: callers own
/// timestamps (`now_ns`) and threading.
#[derive(Debug)]
pub struct GesturePolicy {
    config: GesturePolicyConfig,
    mode: PolicyMode,
    state: PolicyState,
    last_event_at_ns: Option<u64>,
}

impl GesturePolicy {
    pub fn new(config: GesturePolicyConfig) -> Self {
        Self {
            config,
            mode: PolicyMode::Off,
            state: PolicyState::Idle,
            last_event_at_ns: None,
        }
    }

    pub fn mode(&self) -> PolicyMode {
        self.mode
    }

    /// Switches the global mode, forcing an immediate release of any grab in
    /// progress. A downgrade out of `Live` mid-gesture must never leave real
    /// volume control grabbed; an upgrade *into* `Live` must not either
    /// inherit a grab that was only ever recorded (never executed) while
    /// monitoring, since that grab would then block the user's first real
    /// pinch as `IgnoredAlreadyGrabbed`. Either way the released grab's own
    /// executed-ness decides whether the resulting decision is `live` (see
    /// [`Self::release_decision`]), so a monitored grab is discarded without
    /// touching the desktop.
    pub fn set_mode(&mut self, mode: PolicyMode) -> Option<PolicyDecision> {
        let previous = self.mode;
        self.mode = mode;
        if previous != mode && self.state.is_grabbed() {
            Some(self.force_release(ForceReleaseReason::ModeChanged))
        } else {
            None
        }
    }

    /// Applies one classified model transition and returns the resulting
    /// decision. Never panics and never leaves the state machine stuck:
    /// malformed confidence or an out-of-order timestamp is treated as a
    /// model-runtime failure and forces a release.
    pub fn on_transition(&mut self, transition: PinchTransition) -> PolicyDecision {
        let confidence = transition.confidence();
        let timestamp_ns = transition.timestamp_ns();
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            return self.force_release(ForceReleaseReason::ModelRuntimeFailure);
        }
        if let Some(last) = self.last_event_at_ns
            && timestamp_ns < last
        {
            return self.force_release(ForceReleaseReason::ModelRuntimeFailure);
        }

        match (self.state, transition) {
            (PolicyState::Idle, PinchTransition::Started { .. }) => {
                let decision = self.decision(GestureIntent::VolumeGrab, DecisionReason::Started);
                // Record exactly what the caller was told to do, not what the
                // mode merely allowed: `decision.live` is the single source of
                // truth for whether this grab reached the desktop, so the
                // release that ends it can mirror it precisely.
                self.state = PolicyState::Grabbed {
                    executed: decision.live,
                };
                self.last_event_at_ns = Some(timestamp_ns);
                decision
            }
            (PolicyState::Grabbed { .. }, PinchTransition::Held { .. }) => {
                self.last_event_at_ns = Some(timestamp_ns);
                self.decision(GestureIntent::NoAction, DecisionReason::Held)
            }
            (PolicyState::Grabbed { executed }, PinchTransition::Released { .. }) => {
                self.state = PolicyState::Idle;
                self.last_event_at_ns = None;
                self.release_decision(executed, DecisionReason::Released)
            }
            (PolicyState::Grabbed { .. }, PinchTransition::Started { .. }) => {
                self.last_event_at_ns = Some(timestamp_ns);
                self.decision(
                    GestureIntent::NoAction,
                    DecisionReason::IgnoredAlreadyGrabbed,
                )
            }
            (
                PolicyState::Idle,
                PinchTransition::Held { .. } | PinchTransition::Released { .. },
            ) => self.decision(GestureIntent::NoAction, DecisionReason::IgnoredNotGrabbed),
        }
    }

    /// Must be called periodically (e.g. every few hundred milliseconds) so
    /// a grab is never left open by a pipeline that simply stops sending
    /// Held confirmations without an explicit Released or failure report.
    pub fn on_tick(&mut self, now_ns: u64) -> Option<PolicyDecision> {
        if !self.state.is_grabbed() {
            return None;
        }
        let last = self.last_event_at_ns?;
        let elapsed_ns = now_ns.saturating_sub(last);
        if elapsed_ns >= self.config.held_staleness_timeout.as_nanos() as u64 {
            Some(self.force_release(ForceReleaseReason::StaleModelData))
        } else {
            None
        }
    }

    /// Unconditionally returns to `Idle`. Safe to call even when already
    /// idle (returns a `NoAction` decision in that case). Used for watch
    /// disconnects, sensor-quality rejections, explicit model-runtime
    /// failure reports, and mode downgrades.
    pub fn force_release(&mut self, reason: ForceReleaseReason) -> PolicyDecision {
        let was_grabbed = self.state;
        self.state = PolicyState::Idle;
        self.last_event_at_ns = None;
        match was_grabbed {
            PolicyState::Grabbed { executed } => {
                self.release_decision(executed, DecisionReason::ForcedRelease(reason))
            }
            PolicyState::Idle => self.decision(
                GestureIntent::NoAction,
                DecisionReason::ForcedRelease(reason),
            ),
        }
    }

    /// The decision that ends a grab. Always reports the release intent so
    /// Monitor-mode observability still sees the full grab/release arc, but
    /// only marks it `live` when the grab it ends was actually executed
    /// against the desktop -- a release is unconditionally safe to run only
    /// against something this policy itself started. A grab that was merely
    /// recorded while `Off`/`Monitor` was never handed to the overlay, so
    /// executing its release would reach out and cancel whatever the overlay
    /// *is* doing (in practice, a Watch-button grab).
    fn release_decision(&self, executed: bool, reason: DecisionReason) -> PolicyDecision {
        PolicyDecision {
            intent: GestureIntent::VolumeRelease,
            reason,
            live: executed,
        }
    }

    fn decision(&self, intent: GestureIntent, reason: DecisionReason) -> PolicyDecision {
        PolicyDecision {
            intent,
            reason,
            live: !intent.requires_live_mode() || self.mode == PolicyMode::Live,
        }
    }
}

impl Default for GesturePolicy {
    fn default() -> Self {
        Self::new(GesturePolicyConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(confidence: f32, timestamp_ns: u64) -> PinchTransition {
        PinchTransition::Started {
            confidence,
            timestamp_ns,
        }
    }
    fn held(confidence: f32, timestamp_ns: u64) -> PinchTransition {
        PinchTransition::Held {
            confidence,
            timestamp_ns,
        }
    }
    fn released(confidence: f32, timestamp_ns: u64) -> PinchTransition {
        PinchTransition::Released {
            confidence,
            timestamp_ns,
        }
    }

    #[test]
    fn new_defaults_to_off_and_idle_and_never_acts() {
        let mut policy = GesturePolicy::default();
        assert_eq!(policy.mode(), PolicyMode::Off);
        let decision = policy.on_transition(started(0.9, 1));
        assert_eq!(decision.intent, GestureIntent::VolumeGrab);
        assert!(!decision.live);
    }

    #[test]
    fn started_from_idle_in_live_mode_grabs_live() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        let decision = policy.on_transition(started(0.9, 1));
        assert_eq!(decision.intent, GestureIntent::VolumeGrab);
        assert_eq!(decision.reason, DecisionReason::Started);
        assert!(decision.live);
    }

    #[test]
    fn started_from_idle_in_monitor_mode_decides_but_is_not_live() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Monitor);
        let decision = policy.on_transition(started(0.9, 1));
        assert_eq!(decision.intent, GestureIntent::VolumeGrab);
        assert!(!decision.live);
    }

    #[test]
    fn held_without_started_is_ignored() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        let decision = policy.on_transition(held(0.9, 1));
        assert_eq!(decision.intent, GestureIntent::NoAction);
        assert_eq!(decision.reason, DecisionReason::IgnoredNotGrabbed);
    }

    #[test]
    fn released_without_started_is_ignored() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        let decision = policy.on_transition(released(0.9, 1));
        assert_eq!(decision.intent, GestureIntent::NoAction);
        assert_eq!(decision.reason, DecisionReason::IgnoredNotGrabbed);
    }

    #[test]
    fn double_started_is_ignored_the_second_time() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 1));
        let decision = policy.on_transition(started(0.9, 2));
        assert_eq!(decision.intent, GestureIntent::NoAction);
        assert_eq!(decision.reason, DecisionReason::IgnoredAlreadyGrabbed);
    }

    #[test]
    fn held_updates_liveness_without_changing_state_or_acting() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 1));
        let decision = policy.on_transition(held(0.9, 2));
        assert_eq!(decision.intent, GestureIntent::NoAction);
        assert_eq!(decision.reason, DecisionReason::Held);
        // Still grabbed: a Released after Held must still be honored.
        let decision = policy.on_transition(released(0.9, 3));
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
    }

    #[test]
    fn released_after_a_live_grab_is_live() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 1));
        let decision = policy.on_transition(released(0.9, 2));
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        assert!(
            decision.live,
            "a grab that really executed must always be releasable"
        );
    }

    #[test]
    fn released_after_a_monitor_grab_is_reported_but_never_live() {
        // Monitor never executed the grab, so executing its release would
        // reach the overlay for the first time on the way *out* -- cancelling
        // whatever the overlay is actually doing (a Watch-button grab).
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Monitor);
        policy.on_transition(started(0.9, 1));
        let decision = policy.on_transition(released(0.9, 2));
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        assert_eq!(decision.reason, DecisionReason::Released);
        assert!(!decision.live);
    }

    #[test]
    fn a_full_monitor_mode_gesture_never_produces_a_live_actuating_decision() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Monitor);
        for transition in [
            started(0.9, 1),
            held(0.9, 2),
            held(0.9, 3),
            released(0.9, 4),
        ] {
            let decision = policy.on_transition(transition);
            assert!(
                !(decision.live && decision.intent != GestureIntent::NoAction),
                "Monitor emitted an executable {:?} for {transition:?}",
                decision.intent
            );
        }
    }

    #[test]
    fn a_full_off_mode_gesture_never_produces_a_live_actuating_decision() {
        // `Off` should never see a transition at all (the desktop skips
        // classification entirely), but if one arrives anyway it must be
        // just as inert as Monitor.
        let mut policy = GesturePolicy::default();
        for transition in [started(0.9, 1), held(0.9, 2), released(0.9, 3)] {
            let decision = policy.on_transition(transition);
            assert!(!(decision.live && decision.intent != GestureIntent::NoAction));
        }
    }

    #[test]
    fn staleness_forces_release_after_timeout_while_grabbed_in_live_mode() {
        let mut policy = GesturePolicy::new(GesturePolicyConfig {
            held_staleness_timeout: Duration::from_millis(100),
        });
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 0));
        assert!(policy.on_tick(50_000_000).is_none());
        let decision = policy
            .on_tick(150_000_000)
            .expect("must force release once stale");
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        assert_eq!(
            decision.reason,
            DecisionReason::ForcedRelease(ForceReleaseReason::StaleModelData)
        );
        assert!(decision.live);
    }

    #[test]
    fn staleness_tick_is_a_no_op_when_idle() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        assert!(policy.on_tick(1_000_000_000).is_none());
    }

    #[test]
    fn malformed_confidence_forces_release_regardless_of_transition_kind() {
        for value in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
            let mut policy = GesturePolicy::default();
            policy.set_mode(PolicyMode::Live);
            policy.on_transition(started(0.9, 1));
            let decision = policy.on_transition(held(value, 2));
            assert_eq!(decision.intent, GestureIntent::VolumeRelease);
            assert_eq!(
                decision.reason,
                DecisionReason::ForcedRelease(ForceReleaseReason::ModelRuntimeFailure)
            );
        }
    }

    #[test]
    fn out_of_order_timestamp_forces_release() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 100));
        let decision = policy.on_transition(held(0.9, 50));
        assert_eq!(
            decision.reason,
            DecisionReason::ForcedRelease(ForceReleaseReason::ModelRuntimeFailure)
        );
    }

    #[test]
    fn mode_downgrade_from_live_to_monitor_while_grabbed_forces_release() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 1));
        let decision = policy
            .set_mode(PolicyMode::Monitor)
            .expect("downgrading out of Live mid-grab must force a release");
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        assert_eq!(
            decision.reason,
            DecisionReason::ForcedRelease(ForceReleaseReason::ModeChanged)
        );
        assert!(decision.live);
    }

    #[test]
    fn mode_downgrade_from_live_to_off_while_grabbed_forces_release() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 1));
        assert!(policy.set_mode(PolicyMode::Off).is_some());
    }

    #[test]
    fn mode_change_while_idle_is_a_no_op() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        assert!(policy.set_mode(PolicyMode::Monitor).is_none());
    }

    #[test]
    fn setting_the_same_mode_again_while_grabbed_is_a_no_op() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 1));
        assert!(policy.set_mode(PolicyMode::Live).is_none());
        // The grab survives a redundant mode write.
        let decision = policy.on_transition(released(0.9, 2));
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        assert!(decision.live);
    }

    #[test]
    fn upgrading_monitor_to_live_discards_a_monitored_grab_without_acting() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Monitor);
        policy.on_transition(started(0.9, 1));
        let decision = policy
            .set_mode(PolicyMode::Live)
            .expect("a grab in progress must not survive a mode change");
        assert_eq!(
            decision.reason,
            DecisionReason::ForcedRelease(ForceReleaseReason::ModeChanged)
        );
        assert!(
            !decision.live,
            "the monitored grab never reached the desktop, so neither may its release"
        );
        // And the discarded grab must not block the user's first real pinch.
        let first_live = policy.on_transition(started(0.9, 2));
        assert_eq!(first_live.intent, GestureIntent::VolumeGrab);
        assert_eq!(first_live.reason, DecisionReason::Started);
        assert!(first_live.live);
    }

    #[test]
    fn force_release_when_already_idle_reports_no_action() {
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        let decision = policy.force_release(ForceReleaseReason::WatchDisconnected);
        assert_eq!(decision.intent, GestureIntent::NoAction);
        assert!(decision.live);
    }

    #[test]
    fn model_swap_forces_a_live_release_of_an_active_grab() {
        // Mirrors `model_registry::force_release_before_swap`, called by both
        // `activate_model` and `rollback_active_model` before the active
        // model id ever changes: a grab classified under the outgoing
        // model's bindings must never survive into the incoming model's
        // lifetime.
        let mut policy = GesturePolicy::default();
        policy.set_mode(PolicyMode::Live);
        policy.on_transition(started(0.9, 1));
        let decision = policy.force_release(ForceReleaseReason::ModelSwapped);
        assert_eq!(decision.intent, GestureIntent::VolumeRelease);
        assert_eq!(
            decision.reason,
            DecisionReason::ForcedRelease(ForceReleaseReason::ModelSwapped)
        );
        assert!(decision.live);
        let after = policy.on_transition(held(0.9, 2));
        assert_eq!(after.intent, GestureIntent::NoAction);
        assert_eq!(after.reason, DecisionReason::IgnoredNotGrabbed);
    }

    #[test]
    fn force_release_always_clears_the_grab_but_only_executes_one_it_started() {
        // A grab recorded internally under any mode must always be cleared,
        // so the state machine never gets stuck reporting `Grabbed` after a
        // failure. Whether the release is actually *executed* still follows
        // the grab: only a Live grab ever reached the desktop.
        for (mode, expected_live) in [
            (PolicyMode::Off, false),
            (PolicyMode::Monitor, false),
            (PolicyMode::Live, true),
        ] {
            let mut policy = GesturePolicy::default();
            policy.set_mode(mode);
            policy.on_transition(started(0.9, 1));
            let decision = policy.force_release(ForceReleaseReason::ModelRuntimeFailure);
            assert_eq!(decision.intent, GestureIntent::VolumeRelease);
            assert_eq!(decision.live, expected_live, "mode {mode:?}");
            let after = policy.on_transition(held(0.9, 2));
            assert_eq!(after.reason, DecisionReason::IgnoredNotGrabbed, "{mode:?}");
        }
    }

    #[test]
    fn requires_live_mode_matches_action_initiating_intents_only() {
        assert!(!GestureIntent::NoAction.requires_live_mode());
        assert!(!GestureIntent::VolumeRelease.requires_live_mode());
        assert!(GestureIntent::VolumeGrab.requires_live_mode());
        assert!(GestureIntent::Mute.requires_live_mode());
        assert!(GestureIntent::PlayPause.requires_live_mode());
        assert!(GestureIntent::PreviousTrack.requires_live_mode());
        assert!(GestureIntent::NextTrack.requires_live_mode());
    }

    #[test]
    fn pinch_transition_round_trips_through_json_with_camel_case_fields() {
        let transition = PinchTransition::Started {
            confidence: 0.75,
            timestamp_ns: 42,
        };
        let json = serde_json::to_string(&transition).expect("must serialize");
        assert!(json.contains("\"kind\":\"started\""));
        assert!(json.contains("\"timestampNs\":42"));
        let restored: PinchTransition = serde_json::from_str(&json).expect("must deserialize");
        assert_eq!(restored, transition);
    }
}
