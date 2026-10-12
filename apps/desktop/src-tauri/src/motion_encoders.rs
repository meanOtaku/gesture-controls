//! Pre-trained motion encoders a convolutional model can start from (see `tools/label-trainer/src/label_trainer/pretrain.py`).
//!
//! The trainer writes each encoder to `data/external/microdpad/encoders/<name>.pt` with a `<name>.json` beside it (its
//! window, steps and how it did on people it never saw). They stay in that folder of the checkout: MicroDPad's licence
//! (CC BY-NC-ND 4.0) does not allow sharing what is derived from it, so they are neither committed nor bundled with the
//! app, and like training itself they are only available from a checkout. A request names an encoder by its name, never a
//! path, and only a file in that folder is ever handed to the trainer.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where the trainer writes encoders, in this checkout.
pub const ENCODERS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../data/external/microdpad/encoders"
);

/// The six motion channels an encoder reads, in its order.
pub const MOTION_CHANNELS: [&str; 6] = [
    "accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionEncoder {
    /// The file's name without `.pt`: what a request and a design name it by.
    pub id: String,
    pub window_ms: u32,
    pub steps: u32,
    /// On the people held out of pre-training: all twelve classes, gesture against nothing, pinch against other gestures.
    pub accuracy: Option<f64>,
    pub gesture_vs_nothing_auc: Option<f64>,
    pub pinch_vs_other_gestures_auc: Option<f64>,
    pub sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    sha256: String,
    window_ms: u32,
    steps: u32,
    #[serde(default)]
    metrics: serde_json::Value,
}

/// A name that can only be a file directly in the encoders folder.
fn plain_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Every encoder in `dir` that has both its `.pt` and a readable `.json`, by name. A missing folder is none.
pub fn list_encoders(dir: &Path) -> Vec<MotionEncoder> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<MotionEncoder> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_name()?.to_str()?.strip_suffix(".pt")?.to_string();
            if !plain_name(&id) || !path.is_file() {
                return None;
            }
            let sidecar: Sidecar =
                serde_json::from_str(&fs::read_to_string(dir.join(format!("{id}.json"))).ok()?)
                    .ok()?;
            let metric = |name: &str| {
                sidecar
                    .metrics
                    .get(name)
                    .and_then(serde_json::Value::as_f64)
            };
            Some(MotionEncoder {
                accuracy: metric("accuracy"),
                gesture_vs_nothing_auc: metric("gestureVsNothingAuc"),
                pinch_vs_other_gestures_auc: metric("pinchVsOtherGesturesAuc"),
                id,
                window_ms: sidecar.window_ms,
                steps: sidecar.steps,
                sha256: sidecar.sha256,
            })
        })
        .collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}

/// The encoder named `id` in `dir` and its file, after checking a convolutional model with these settings can start from
/// it: it reads exactly the encoder's six motion channels, over the encoder's window, in its steps.
pub fn check_encoder(
    dir: &Path,
    id: &str,
    backend: &str,
    features: &[String],
    window_ms: u32,
    grid_steps: u32,
) -> Result<(MotionEncoder, PathBuf), String> {
    if backend != "cnn1d" {
        return Err("only the convolutional network can start from a pre-trained encoder".into());
    }
    let encoder = list_encoders(dir)
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| {
            format!(
                "there is no pre-trained encoder named '{id}' in data/external/microdpad/encoders"
            )
        })?;
    if features != MOTION_CHANNELS {
        return Err(format!(
            "the encoder '{id}' reads acceleration and gyroscope (x, y and z of each), so the model must read exactly those columns"
        ));
    }
    if window_ms != encoder.window_ms || grid_steps != encoder.steps {
        return Err(format!(
            "the encoder '{id}' reads {} ms windows in {} readings; this model asks for {window_ms} ms in {grid_steps}",
            encoder.window_ms, encoder.steps
        ));
    }
    let path = dir.join(format!("{id}.pt"));
    Ok((encoder, path))
}

#[tauri::command]
pub fn list_motion_encoders() -> Vec<MotionEncoder> {
    list_encoders(Path::new(ENCODERS_DIR))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(encoders: &[(&str, u32, u32)]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("motion-encoders-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        for (id, window, steps) in encoders {
            fs::write(dir.join(format!("{id}.pt")), b"weights").unwrap();
            fs::write(
                dir.join(format!("{id}.json")),
                serde_json::json!({"sha256": "ab", "windowMs": window, "steps": steps, "metrics": {"gestureVsNothingAuc": 0.93}})
                    .to_string(),
            )
            .unwrap();
        }
        dir
    }

    fn motion() -> Vec<String> {
        MOTION_CHANNELS.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn encoders_are_listed_with_their_settings_and_scores() {
        let dir = dir_with(&[("motion-encoder", 1000, 32), ("short", 500, 16)]);
        fs::write(dir.join("no-sidecar.pt"), b"x").unwrap();
        fs::write(dir.join(".hidden.pt"), b"x").unwrap();
        let found = list_encoders(&dir);
        assert_eq!(
            found.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["motion-encoder", "short"]
        );
        assert_eq!((found[0].window_ms, found[0].steps), (1000, 32));
        assert_eq!(found[0].gesture_vs_nothing_auc, Some(0.93));
        assert!(list_encoders(&dir.join("missing")).is_empty());
    }

    #[test]
    fn only_a_convolutional_model_that_reads_what_the_encoder_read_can_start_from_it() {
        let dir = dir_with(&[("motion-encoder", 1000, 32)]);
        let (encoder, path) =
            check_encoder(&dir, "motion-encoder", "cnn1d", &motion(), 1000, 32).unwrap();
        assert_eq!(encoder.id, "motion-encoder");
        assert_eq!(path, dir.join("motion-encoder.pt"));
        for (id, backend, features, window, steps, reason) in [
            (
                "motion-encoder",
                "gbt",
                motion(),
                1000,
                32,
                "only the convolutional",
            ),
            (
                "other",
                "cnn1d",
                motion(),
                1000,
                32,
                "no pre-trained encoder",
            ),
            (
                "../motion-encoder",
                "cnn1d",
                motion(),
                1000,
                32,
                "no pre-trained encoder",
            ),
            (
                "motion-encoder",
                "cnn1d",
                vec!["accel_x".to_string()],
                1000,
                32,
                "exactly those columns",
            ),
            (
                "motion-encoder",
                "cnn1d",
                motion(),
                500,
                32,
                "1000 ms windows in 32",
            ),
            (
                "motion-encoder",
                "cnn1d",
                motion(),
                1000,
                16,
                "1000 ms windows in 32",
            ),
        ] {
            let error = check_encoder(&dir, id, backend, &features, window, steps).unwrap_err();
            assert!(error.contains(reason), "{error} should mention {reason}");
        }
    }
}
