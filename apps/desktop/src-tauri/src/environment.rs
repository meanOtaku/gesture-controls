use std::path::Path;
use std::process::Command;

use serde::Serialize;

const PINCH_CLASSIFIER_PROJECT_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tools/pinch-classifier"
);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDiagnostic {
    pub id: &'static str,
    pub title: &'static str,
    pub status: EnvironmentDiagnosticStatus,
    pub detail: String,
    pub action: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentDiagnosticStatus {
    Ready,
    Attention,
}

impl EnvironmentDiagnostic {
    fn ready(id: &'static str, title: &'static str, detail: impl Into<String>) -> Self {
        Self {
            id,
            title,
            status: EnvironmentDiagnosticStatus::Ready,
            detail: detail.into(),
            action: None,
        }
    }

    fn attention(
        id: &'static str,
        title: &'static str,
        detail: impl Into<String>,
        action: &'static str,
    ) -> Self {
        Self {
            id,
            title,
            status: EnvironmentDiagnosticStatus::Attention,
            detail: detail.into(),
            action: Some(action),
        }
    }
}

#[tauri::command]
pub fn get_environment_diagnostics() -> Vec<EnvironmentDiagnostic> {
    vec![
        training_runner_diagnostic(),
        litert_diagnostic(),
        volume_diagnostic(),
    ]
}

fn training_runner_diagnostic() -> EnvironmentDiagnostic {
    let project_manifest = Path::new(PINCH_CLASSIFIER_PROJECT_DIR).join("pyproject.toml");
    if !project_manifest.is_file() {
        return EnvironmentDiagnostic::attention(
            "training-runner",
            "Training and replay runner",
            "The bundled pinch-classifier project is unavailable. Training and replay require a full repository checkout.",
            "Run the app from a complete gesture-controls checkout.",
        );
    }

    if command_available("uv") {
        EnvironmentDiagnostic::ready(
            "training-runner",
            "Training and replay runner",
            "uv and the bundled pinch-classifier project are available. Python environments are created by uv when you start training or replay.",
        )
    } else {
        EnvironmentDiagnostic::attention(
            "training-runner",
            "Training and replay runner",
            "uv was not found on PATH. This development runner is not bundled into desktop packages.",
            "Install uv from https://docs.astral.sh/uv/ and restart the app.",
        )
    }
}

fn litert_diagnostic() -> EnvironmentDiagnostic {
    if cfg!(feature = "litert-inference") {
        EnvironmentDiagnostic::ready(
            "litert-runtime",
            "Desktop LiteRT inference",
            "This desktop build includes the LiteRT backend. A validated active TFLite model and complete safe-intent bindings are still required before Monitor or Live can run.",
        )
    } else {
        EnvironmentDiagnostic::attention(
            "litert-runtime",
            "Desktop LiteRT inference",
            "This desktop build omits the optional LiteRT backend, so model windows fail closed.",
            "Build the desktop app with cargo feature litert-inference before using Monitor or Live.",
        )
    }
}

fn volume_diagnostic() -> EnvironmentDiagnostic {
    match volume_control::platform_volume_controller().get_volume() {
        Ok(_) => EnvironmentDiagnostic::ready(
            "volume-backend",
            "System volume backend",
            "The desktop can read the host system volume. Gesture volume changes remain gated by the overlay and safe intent policy.",
        ),
        Err(error) => EnvironmentDiagnostic::attention(
            "volume-backend",
            "System volume backend",
            format!("The desktop could not read the host system volume: {error}"),
            "Install or configure the host audio backend, then choose Recheck.",
        ),
    }
}

fn command_available(command: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_safe_to_query_without_a_training_runner() {
        let diagnostics = get_environment_diagnostics();
        assert_eq!(diagnostics.len(), 3);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.id == "training-runner")
        );
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.id == "litert-runtime")
        );
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.id == "volume-backend")
        );
    }

    #[test]
    fn every_attention_diagnostic_has_an_action() {
        for diagnostic in get_environment_diagnostics() {
            if matches!(diagnostic.status, EnvironmentDiagnosticStatus::Attention) {
                assert!(diagnostic.action.is_some());
            }
        }
    }
}
