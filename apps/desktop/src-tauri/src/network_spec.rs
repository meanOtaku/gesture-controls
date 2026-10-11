//! The shape of a neural network and how it is trained, as a person sets it in the Train card.
//!
//! Checked here with the same limits as the trainer's `network.py`; the trainer checks again and fills in whatever is not
//! given with the method's own default. Every activation and layer here is one the runtime can run.

use serde::{Deserialize, Serialize};

pub const ACTIVATIONS: [&str; 4] = ["relu", "tanh", "sigmoid", "leaky_relu"];
pub const POOLINGS: [&str; 3] = ["mean_max", "mean", "max"];
pub const MAX_HIDDEN_LAYERS: usize = 6;
pub const MAX_CONV_LAYERS: usize = 4;
pub const MAX_UNITS: u32 = 512;
pub const MAX_FILTERS: u32 = 128;
pub const KERNELS: [u32; 7] = [3, 5, 7, 9, 11, 13, 15];

fn relu() -> String {
    "relu".into()
}
fn five() -> u32 {
    5
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerSpec {
    pub units: u32,
    #[serde(default = "relu")]
    pub activation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConvSpec {
    pub filters: u32,
    #[serde(default = "five")]
    pub kernel: u32,
    #[serde(default = "relu")]
    pub activation: String,
}

/// Anything left out takes the method's own default (see `default_network` in the trainer).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkSpec {
    /// Dense layers: after the inputs (dense methods), or after the pooling (convolutional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<Vec<LayerSpec>>,
    /// Convolution layers (convolutional method only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conv: Option<Vec<ConvSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pooling: Option<String>,
    /// The share of the last layer's inputs switched off while training.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropout: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub learning_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epochs: Option<u32>,
    /// 0 trains on the whole set at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight_decay: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance_classes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub augment: Option<bool>,
}

fn between(name: &str, value: f64, low: f64, high: f64) -> Result<(), String> {
    if (low..=high).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be from {low} to {high}, got {value}"))
    }
}

fn activation(name: &str) -> Result<(), String> {
    if ACTIVATIONS.contains(&name) {
        Ok(())
    } else {
        Err(format!(
            "unknown activation '{name}'; choose from {ACTIVATIONS:?}"
        ))
    }
}

impl NetworkSpec {
    /// Refuses what cannot be trained or run, with the reason. `backend` is the training method.
    pub fn validate(&self, backend: &str) -> Result<(), String> {
        let neural = matches!(backend, "mlp" | "torch-mlp" | "cnn1d");
        if !neural {
            return Err("network settings only apply to the neural network methods".into());
        }
        if let Some(hidden) = &self.hidden {
            if hidden.len() > MAX_HIDDEN_LAYERS {
                return Err(format!(
                    "a network has at most {MAX_HIDDEN_LAYERS} hidden layers"
                ));
            }
            for layer in hidden {
                between("units", f64::from(layer.units), 1.0, f64::from(MAX_UNITS))?;
                activation(&layer.activation)?;
            }
        }
        if let Some(conv) = &self.conv {
            if backend != "cnn1d" {
                return Err("convolution layers only apply to the convolutional method".into());
            }
            if conv.is_empty() || conv.len() > MAX_CONV_LAYERS {
                return Err(format!(
                    "a convolutional network has from 1 to {MAX_CONV_LAYERS} convolution layers"
                ));
            }
            for layer in conv {
                between(
                    "filters",
                    f64::from(layer.filters),
                    1.0,
                    f64::from(MAX_FILTERS),
                )?;
                if !KERNELS.contains(&layer.kernel) {
                    return Err(format!(
                        "a kernel must be an odd width from 3 to 15, got {}",
                        layer.kernel
                    ));
                }
                activation(&layer.activation)?;
            }
        }
        if let Some(pooling) = &self.pooling {
            if !POOLINGS.contains(&pooling.as_str()) {
                return Err(format!(
                    "unknown pooling '{pooling}'; choose from {POOLINGS:?}"
                ));
            }
        }
        if let Some(v) = self.dropout {
            between("dropout", v, 0.0, 0.7)?;
        }
        if let Some(v) = self.learning_rate {
            between("learningRate", v, 1e-4, 0.1)?;
        }
        if let Some(v) = self.epochs {
            between("epochs", f64::from(v), 5.0, 1000.0)?;
        }
        if let Some(v) = self.batch_size {
            between("batchSize", f64::from(v), 0.0, 256.0)?;
        }
        if let Some(v) = self.weight_decay {
            between("weightDecay", v, 0.0, 0.1)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: serde_json::Value) -> NetworkSpec {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn an_empty_spec_is_fine_and_leaves_everything_to_the_defaults() {
        let spec = parse(serde_json::json!({}));
        assert_eq!(spec, NetworkSpec::default());
        assert!(spec.validate("torch-mlp").is_ok());
        assert_eq!(serde_json::to_value(&spec).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn a_designed_network_is_accepted_and_round_trips() {
        let json = serde_json::json!({
            "hidden": [{"units": 64, "activation": "tanh"}, {"units": 8}],
            "conv": [{"filters": 12, "kernel": 7, "activation": "leaky_relu"}],
            "pooling": "max", "dropout": 0.3, "learningRate": 0.005, "epochs": 120,
            "batchSize": 32, "weightDecay": 0.001, "balanceClasses": false, "augment": true
        });
        let spec = parse(json.clone());
        assert!(spec.validate("cnn1d").is_ok());
        assert_eq!(spec.hidden.as_ref().unwrap()[1].activation, "relu"); // the default fills in
        let back = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            back["hidden"][0],
            serde_json::json!({"units": 64, "activation": "tanh"})
        );
        assert_eq!(back["conv"][0]["kernel"], 7);
    }

    #[test]
    fn what_cannot_be_trained_or_run_is_refused_with_the_reason() {
        let bad = [
            (serde_json::json!({"hidden": [{"units": 0}]}), "units"),
            (serde_json::json!({"hidden": [{"units": 9999}]}), "units"),
            (
                serde_json::json!({"hidden": [{"units": 4, "activation": "swish"}]}),
                "activation",
            ),
            (
                serde_json::json!({"hidden": (0..7).map(|_| serde_json::json!({"units": 4})).collect::<Vec<_>>()}),
                "at most",
            ),
            (serde_json::json!({"learningRate": 5.0}), "learningRate"),
            (serde_json::json!({"epochs": 2}), "epochs"),
            (serde_json::json!({"batchSize": 1000}), "batchSize"),
            (serde_json::json!({"dropout": 0.9}), "dropout"),
            (serde_json::json!({"pooling": "median"}), "pooling"),
        ];
        for (json, message) in bad {
            let error = parse(json.clone()).validate("torch-mlp").unwrap_err();
            assert!(error.contains(message), "{json}: {error}");
        }
        assert!(
            parse(serde_json::json!({"conv": [{"filters": 4}]}))
                .validate("torch-mlp")
                .unwrap_err()
                .contains("only apply to the convolutional")
        );
        assert!(
            parse(serde_json::json!({"conv": [{"filters": 4, "kernel": 4}]}))
                .validate("cnn1d")
                .unwrap_err()
                .contains("odd width")
        );
        assert!(
            parse(serde_json::json!({"conv": []}))
                .validate("cnn1d")
                .unwrap_err()
                .contains("from 1 to")
        );
        assert!(
            parse(serde_json::json!({"hidden": [{"units": 4}]}))
                .validate("logreg")
                .unwrap_err()
                .contains("neural network methods")
        );
        // An unknown setting is not silently ignored.
        assert!(serde_json::from_value::<NetworkSpec>(serde_json::json!({"layers": 3})).is_err());
    }
}
