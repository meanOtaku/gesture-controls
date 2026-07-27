use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use sony_head_tracker_sys::{EngineError, Sample, Status, Tracker};
use spatial_protocol::HeadPose;
use tokio::sync::broadcast;

use crate::{
    HeadPoseError, HeadPoseEvent, HeadPoseProvider, HeadPoseProviderSnapshot,
    HeadTrackerRuntimeState, HeadTrackerRuntimeStatus,
};

struct DirectState {
    events: broadcast::Sender<HeadPoseEvent>,
    connected: AtomicBool,
    reset_counter: Mutex<Option<u64>>,
    runtime: Mutex<HeadTrackerRuntimeStatus>,
}

impl DirectState {
    fn sample(&self, sample: Sample) {
        let current = u64::from(sample.reset_counter);
        if let Ok(mut counter) = self.reset_counter.lock()
            && let Some(previous) = counter.replace(current)
            && previous != current
        {
            let _ = self
                .events
                .send(HeadPoseEvent::ResetCounterChanged { previous, current });
        }
        let _ = self
            .events
            .send(HeadPoseEvent::Pose(sample_to_head_pose(sample)));
    }

    fn status(&self, status: Status, message: String) {
        let (state, connected) = match status {
            Status::Searching => (HeadTrackerRuntimeState::Searching, false),
            Status::Connected => (HeadTrackerRuntimeState::Connected, true),
            Status::Disconnected if message.to_ascii_lowercase().contains("stopped") => {
                (HeadTrackerRuntimeState::Stopped, false)
            }
            Status::Disconnected => (HeadTrackerRuntimeState::Reconnecting, false),
            Status::Permission => (HeadTrackerRuntimeState::PermissionRequired, false),
            Status::Unsupported => (HeadTrackerRuntimeState::Unsupported, false),
            Status::Error => (HeadTrackerRuntimeState::Error, false),
        };
        let was_connected = self.connected.swap(connected, Ordering::AcqRel);
        if connected && !was_connected {
            let _ = self.events.send(HeadPoseEvent::Connected);
        } else if !connected && was_connected {
            let _ = self.events.send(HeadPoseEvent::Disconnected);
        }
        let device = (status == Status::Connected && !message.is_empty()).then(|| message.clone());
        if let Ok(mut runtime) = self.runtime.lock() {
            *runtime = HeadTrackerRuntimeStatus {
                state,
                message: message.clone(),
                device: device.clone(),
            };
        }
        let _ = self.events.send(HeadPoseEvent::RuntimeStatus {
            state,
            message,
            device,
        });
    }
}

pub struct SonyDirectHeadPoseProvider {
    state: Arc<DirectState>,
    tracker: Mutex<Option<Arc<Tracker>>>,
}

impl Default for SonyDirectHeadPoseProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SonyDirectHeadPoseProvider {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            state: Arc::new(DirectState {
                events,
                connected: AtomicBool::new(false),
                reset_counter: Mutex::new(None),
                runtime: Mutex::new(HeadTrackerRuntimeStatus {
                    state: HeadTrackerRuntimeState::Stopped,
                    message: "Built-in Sony head tracker is stopped".to_owned(),
                    device: None,
                }),
            }),
            tracker: Mutex::new(None),
        }
    }
}

#[async_trait]
impl HeadPoseProvider for SonyDirectHeadPoseProvider {
    async fn start(&self) -> Result<(), HeadPoseError> {
        let mut active = self
            .tracker
            .lock()
            .map_err(|_| HeadPoseError::StatePoisoned)?;
        if active.is_some() {
            return Err(HeadPoseError::AlreadyRunning);
        }
        let starting = HeadTrackerRuntimeStatus {
            state: HeadTrackerRuntimeState::Starting,
            message: "Starting built-in Sony head tracker".to_owned(),
            device: None,
        };
        *self
            .state
            .runtime
            .lock()
            .map_err(|_| HeadPoseError::StatePoisoned)? = starting.clone();
        let _ = self.state.events.send(HeadPoseEvent::RuntimeStatus {
            state: starting.state,
            message: starting.message,
            device: starting.device,
        });
        if let Ok(mut reset) = self.state.reset_counter.lock() {
            *reset = None;
        }

        let sample_state = Arc::clone(&self.state);
        let status_state = Arc::clone(&self.state);
        let tracker = Arc::new(Tracker::new(
            move |sample| sample_state.sample(sample),
            move |status, message| status_state.status(status, message),
        )?);
        match tracker.start() {
            Ok(()) => {
                *active = Some(tracker);
                Ok(())
            }
            Err(EngineError::Unsupported) => Err(HeadPoseError::UnsupportedPlatform),
            Err(error) => Err(HeadPoseError::Native(error)),
        }
    }

    async fn stop(&self) -> Result<(), HeadPoseError> {
        let tracker = self
            .tracker
            .lock()
            .map_err(|_| HeadPoseError::StatePoisoned)?
            .take();
        if let Some(tracker) = tracker {
            tokio::task::spawn_blocking(move || tracker.stop()).await??;
        }
        self.state.connected.store(false, Ordering::Release);
        if let Ok(mut runtime) = self.state.runtime.lock() {
            *runtime = HeadTrackerRuntimeStatus {
                state: HeadTrackerRuntimeState::Stopped,
                message: "Built-in Sony head tracker stopped".to_owned(),
                device: None,
            };
        }
        let _ = self.state.events.send(HeadPoseEvent::RuntimeStatus {
            state: HeadTrackerRuntimeState::Stopped,
            message: "Built-in Sony head tracker stopped".to_owned(),
            device: None,
        });
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<HeadPoseEvent> {
        self.state.events.subscribe()
    }

    fn is_connected(&self) -> bool {
        self.state.connected.load(Ordering::Acquire)
    }

    fn snapshot(&self) -> HeadPoseProviderSnapshot {
        let runtime = self
            .state
            .runtime
            .lock()
            .map(|value| value.clone())
            .unwrap_or(HeadTrackerRuntimeStatus {
                state: HeadTrackerRuntimeState::Error,
                message: "Built-in provider state lock was poisoned".to_owned(),
                device: None,
            });
        let reset_counter = self
            .state
            .reset_counter
            .lock()
            .map(|value| *value)
            .unwrap_or(None);
        HeadPoseProviderSnapshot {
            runtime,
            reset_counter,
        }
    }

    fn recenter(&self) -> Result<(), HeadPoseError> {
        let tracker = self
            .tracker
            .lock()
            .map_err(|_| HeadPoseError::StatePoisoned)?
            .clone()
            .ok_or(HeadPoseError::UnsupportedOperation(
                "recenter while the direct provider is stopped",
            ))?;
        tracker.recenter()?;
        Ok(())
    }
}

fn sample_to_head_pose(sample: Sample) -> HeadPose {
    let timestamp_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64;
    HeadPose {
        timestamp_ns,
        device: (!sample.device_label.is_empty()).then_some(sample.device_label),
        quaternion: sample.quaternion,
        yaw_deg: sample.ypr_degrees[0],
        pitch_deg: sample.ypr_degrees[1],
        roll_deg: sample.ypr_degrees[2],
        angular_velocity: sample.gyro,
        gyroscope: sample.gyro,
        accelerometer: sample.acceleration,
        reset_counter: u64::from(sample.reset_counter),
        packets_per_second: sample.packets_per_second,
        receive_latency_ms: sample.receive_latency_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(reset_counter: u8) -> Sample {
        Sample {
            quaternion: [0.9, 0.1, 0.2, 0.3],
            ypr_degrees: [10.0, -2.0, 3.0],
            gyro: Some([0.01, 0.02, 0.03]),
            acceleration: Some([1.0, 2.0, 3.0]),
            reset_counter,
            packets_per_second: 50.0,
            receive_latency_ms: 1.5,
            device_label: "WH-1000XM5".to_owned(),
        }
    }

    #[test]
    fn native_sample_maps_to_provider_neutral_pose() {
        let pose = sample_to_head_pose(sample(7));
        assert_eq!(pose.device.as_deref(), Some("WH-1000XM5"));
        assert_eq!(pose.quaternion, [0.9, 0.1, 0.2, 0.3]);
        assert_eq!(
            (pose.yaw_deg, pose.pitch_deg, pose.roll_deg),
            (10.0, -2.0, 3.0)
        );
        assert_eq!(pose.gyroscope, Some([0.01, 0.02, 0.03]));
        assert_eq!(pose.accelerometer, Some([1.0, 2.0, 3.0]));
        assert_eq!(pose.reset_counter, 7);
    }

    #[tokio::test]
    async fn first_sample_sets_reset_baseline_and_later_change_emits_reset() {
        let provider = SonyDirectHeadPoseProvider::new();
        let mut events = provider.subscribe();
        provider.state.sample(sample(3));
        assert!(matches!(
            events.recv().await.unwrap(),
            HeadPoseEvent::Pose(_)
        ));
        provider.state.sample(sample(4));
        assert!(matches!(
            events.recv().await.unwrap(),
            HeadPoseEvent::ResetCounterChanged {
                previous: 3,
                current: 4
            }
        ));
        assert_eq!(provider.snapshot().reset_counter, Some(4));
    }

    #[tokio::test]
    async fn native_status_controls_connection_and_runtime_events() {
        let provider = SonyDirectHeadPoseProvider::new();
        let mut events = provider.subscribe();
        provider
            .state
            .status(Status::Connected, "WH-1000XM5".to_owned());
        assert!(provider.is_connected());
        assert_eq!(
            provider.snapshot().runtime,
            HeadTrackerRuntimeStatus {
                state: HeadTrackerRuntimeState::Connected,
                message: "WH-1000XM5".to_owned(),
                device: Some("WH-1000XM5".to_owned()),
            }
        );
        assert!(matches!(
            events.recv().await.unwrap(),
            HeadPoseEvent::Connected
        ));
        assert!(matches!(
            events.recv().await.unwrap(),
            HeadPoseEvent::RuntimeStatus {
                state: HeadTrackerRuntimeState::Connected,
                device: Some(device),
                ..
            } if device == "WH-1000XM5"
        ));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[tokio::test]
    async fn unsupported_platform_is_explicit_and_does_not_require_an_external_process() {
        let provider = SonyDirectHeadPoseProvider::new();
        let mut events = provider.subscribe();
        assert!(matches!(
            provider.start().await,
            Err(HeadPoseError::UnsupportedPlatform)
        ));
        assert!(matches!(
            events.recv().await.unwrap(),
            HeadPoseEvent::RuntimeStatus {
                state: HeadTrackerRuntimeState::Starting,
                ..
            }
        ));
        assert!(matches!(
            events.recv().await.unwrap(),
            HeadPoseEvent::RuntimeStatus {
                state: HeadTrackerRuntimeState::Unsupported,
                ..
            }
        ));
        provider.stop().await.unwrap();
    }
}
