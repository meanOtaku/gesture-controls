//! A small 1-D convolutional network model file (`model.cnn`), as the trainer's `cnn.py` writes it, and its evaluation.
//!
//! The file is JSON: `{"format": "ppg-imu-cnn", "version": 1, "channels", "length", "members": [{"conv": [...], "dense":
//! [...]}, ...]}`: one to five networks, whose probabilities are averaged. In each network, each convolution has `in`, `out`, an odd `kernel`, a `dilation`, `weight` (`out` x `in` x `kernel`, flattened in that order)
//! and `bias` (`out`); it pads its input with zeros to keep the length (`dilation` x (`kernel` - 1) / 2 each side), and a
//! ReLU follows it (batch normalisation is folded into the weights). The last convolution's channels are pooled over time,
//! their maxima then their means, into the first dense layer. Each dense layer has `in`, `out`, `weight` (`out` x `in`) and
//! `bias`; a ReLU follows every one but the last, whose single output goes through a sigmoid: the positive class's
//! probability.
//!
//! The input is `channels` x `length` values, channel by channel (`pinch_inference::cnn_input`). Every size and weight is
//! checked when the file is read, so evaluation cannot go out of bounds, and the network is plain data: weights, not code.

use serde::Deserialize;
use thiserror::Error;

pub const FORMAT: &str = "ppg-imu-cnn";
pub const VERSION: u32 = 1;
/// The largest layer, kernel and dilation a file may have: far more than the trainer uses, small enough that a decision
/// stays cheap.
const MAX_WIDTH: usize = 256;
const MAX_KERNEL: usize = 15;
const MAX_DILATION: usize = 32;
const MAX_LAYERS: usize = 8;
const MAX_MEMBERS: usize = 5;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CnnError {
    #[error("the model file is not a CNN: {0}")]
    NotCnn(String),
    #[error("the CNN's version is {0}; this app reads version {VERSION}")]
    Version(u32),
    #[error("the CNN is malformed: {0}")]
    Malformed(String),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Conv {
    #[serde(rename = "in")]
    input: usize,
    out: usize,
    kernel: usize,
    dilation: usize,
    weight: Vec<f64>,
    bias: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Dense {
    #[serde(rename = "in")]
    input: usize,
    out: usize,
    weight: Vec<f64>,
    bias: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    conv: Vec<Conv>,
    dense: Vec<Dense>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    format: String,
    version: u32,
    channels: usize,
    length: usize,
    members: Vec<Member>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cnn {
    channels: usize,
    length: usize,
    members: Vec<Member>,
}

fn malformed(detail: impl Into<String>) -> CnnError {
    CnnError::Malformed(detail.into())
}

impl Cnn {
    pub fn parse(bytes: &[u8]) -> Result<Self, CnnError> {
        let file: File =
            serde_json::from_slice(bytes).map_err(|e| CnnError::NotCnn(e.to_string()))?;
        if file.format != FORMAT {
            return Err(CnnError::NotCnn(format!(
                "its format is '{}', not '{FORMAT}'",
                file.format
            )));
        }
        if file.version != VERSION {
            return Err(CnnError::Version(file.version));
        }
        if file.channels == 0 || file.channels > MAX_WIDTH || file.length == 0 || file.length > 4096
        {
            return Err(malformed(
                "the input must have 1 to 256 channels and 1 to 4096 values each",
            ));
        }
        if file.members.is_empty() || file.members.len() > MAX_MEMBERS {
            return Err(malformed("it needs one to five networks"));
        }
        for member in &file.members {
            check_member(member, file.channels)?;
        }
        Ok(Self {
            channels: file.channels,
            length: file.length,
            members: file.members,
        })
    }

    /// How many inputs it reads: channels x length.
    pub fn features(&self) -> usize {
        self.channels * self.length
    }

    /// The positive class's probability for `input` (channel by channel): the networks' probabilities averaged. `input`
    /// must have [`Cnn::features`] values.
    pub fn predict(&self, input: &[f64]) -> f64 {
        assert_eq!(input.len(), self.features(), "checked by the caller");
        self.members
            .iter()
            .map(|m| m.predict(input, self.length))
            .sum::<f64>()
            / self.members.len() as f64
    }
}

/// Checks one network's shapes chain from `channels` inputs to one output, and its weights are finite.
fn check_member(file: &Member, channels: usize) -> Result<(), CnnError> {
    if file.conv.is_empty()
        || file.dense.is_empty()
        || file.conv.len() + file.dense.len() > MAX_LAYERS
    {
        return Err(malformed(
            "each network needs at least one convolution and one dense layer, and at most 8 layers",
        ));
    }
    let mut width = channels;
    for (i, c) in file.conv.iter().enumerate() {
        if c.input != width {
            return Err(malformed(format!(
                "convolution {i} takes {} channels, but {width} reach it",
                c.input
            )));
        }
        if c.out == 0
            || c.out > MAX_WIDTH
            || c.kernel % 2 == 0
            || c.kernel > MAX_KERNEL
            || c.dilation == 0
            || c.dilation > MAX_DILATION
        {
            return Err(malformed(format!(
                "convolution {i} has an unsupported shape"
            )));
        }
        if c.weight.len() != c.out * c.input * c.kernel || c.bias.len() != c.out {
            return Err(malformed(format!(
                "convolution {i} has the wrong number of weights"
            )));
        }
        width = c.out;
    }
    width *= 2; // maxima, then means
    for (i, d) in file.dense.iter().enumerate() {
        if d.input != width {
            return Err(malformed(format!(
                "dense layer {i} takes {} values, but {width} reach it",
                d.input
            )));
        }
        if d.out == 0
            || d.out > MAX_WIDTH
            || d.weight.len() != d.out * d.input
            || d.bias.len() != d.out
        {
            return Err(malformed(format!(
                "dense layer {i} has an unsupported shape or the wrong number of weights"
            )));
        }
        width = d.out;
    }
    if width != 1 {
        return Err(malformed("the last dense layer must give one value"));
    }
    let finite = |v: &[f64]| v.iter().all(|w| w.is_finite());
    if !file
        .conv
        .iter()
        .all(|c| finite(&c.weight) && finite(&c.bias))
        || !file
            .dense
            .iter()
            .all(|d| finite(&d.weight) && finite(&d.bias))
    {
        return Err(malformed("a weight is not a finite number"));
    }
    Ok(())
}

impl Member {
    /// One network's probability for `input`.
    fn predict(&self, input: &[f64], length: usize) -> f64 {
        let mut x: Vec<f64> = input.to_vec();
        for c in &self.conv {
            // Each input channel with its zero padding, so every tap reads a contiguous run.
            let pad = c.dilation * (c.kernel - 1) / 2;
            let wide = length + 2 * pad;
            let mut padded = vec![0.0; c.input * wide];
            for i in 0..c.input {
                padded[i * wide + pad..][..length].copy_from_slice(&x[i * length..][..length]);
            }
            let mut y = vec![0.0; c.out * length];
            for (o, out) in y.chunks_exact_mut(length).enumerate() {
                out.fill(c.bias[o]);
                for i in 0..c.input {
                    let row = &padded[i * wide..][..wide];
                    for (k, weight) in c.weight[(o * c.input + i) * c.kernel..][..c.kernel].iter().enumerate() {
                        for (value, tap) in out.iter_mut().zip(&row[k * c.dilation..][..length]) {
                            *value += weight * tap;
                        }
                    }
                }
                for value in out.iter_mut() {
                    *value = value.max(0.0);
                }
            }
            x = y;
        }
        let channels = x.len() / length;
        let mut h: Vec<f64> = (0..channels)
            .map(|c| {
                x[c * length..][..length]
                    .iter()
                    .copied()
                    .fold(f64::NEG_INFINITY, f64::max)
            })
            .collect();
        h.extend(
            (0..channels).map(|c| x[c * length..][..length].iter().sum::<f64>() / length as f64),
        );
        for (n, d) in self.dense.iter().enumerate() {
            let last = n + 1 == self.dense.len();
            h = (0..d.out)
                .map(|o| {
                    let v = d.bias[o]
                        + d.weight[o * d.input..][..d.input]
                            .iter()
                            .zip(&h)
                            .map(|(w, v)| w * v)
                            .sum::<f64>();
                    if last { v } else { v.max(0.0) }
                })
                .collect();
        }
        1.0 / (1.0 + (-h[0]).exp())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One convolution (2 channels in, 1 out, kernel 3, dilation 2) and one dense layer, small enough to work out by hand.
    fn tiny() -> serde_json::Value {
        serde_json::json!({
            "format": FORMAT, "version": 1, "channels": 2, "length": 4,
            "members": [{
                "conv": [{"in": 2, "out": 1, "kernel": 3, "dilation": 2,
                          "weight": [1.0, 0.0, -1.0,   0.5, 0.5, 0.5], "bias": [0.1]}],
                "dense": [{"in": 2, "out": 1, "weight": [1.0, -2.0], "bias": [0.0]}],
            }],
        })
    }

    #[test]
    fn a_tiny_network_gives_the_value_worked_out_by_hand() {
        let cnn = Cnn::parse(tiny().to_string().as_bytes()).unwrap();
        assert_eq!(cnn.features(), 8);
        // Channel a = [1, 2, 3, 4], channel b = [0, 1, 0, 1]. Padding 2 each side; output t reads inputs t-2, t, t+2.
        // t=0: a: 1*0 + 0*1 - 1*3 = -3; b: .5*(0 + 0 + 0) = 0; + .1 -> -2.9 -> relu 0
        // t=1: a: 0 + 0 - 4 = -4; b: .5*(0 + 1 + 1) = 1; + .1 -> -2.9 -> 0
        // t=2: a: 1 - 0 = 1; b: .5*(0 + 0 + 0) = 0; + .1 -> 1.1
        // t=3: a: 2 - 0 = 2; b: .5*(1 + 1 + 0) = 1; + .1 -> 3.1
        // max 3.1, mean 1.05; dense 3.1 - 2.1 = 1.0 -> sigmoid(1.0)
        let p = cnn.predict(&[1.0, 2.0, 3.0, 4.0, 0.0, 1.0, 0.0, 1.0]);
        assert!((p - 1.0 / (1.0 + (-1.0f64).exp())).abs() < 1e-12, "{p}");
        // A second network that always answers 0 (a bias of minus infinity is refused, so a large one): the average.
        let mut two = tiny();
        let mut quiet = two["members"][0].clone();
        quiet["dense"][0]["weight"] = serde_json::json!([0.0, 0.0]);
        quiet["dense"][0]["bias"] = serde_json::json!([0.0]);
        two["members"].as_array_mut().unwrap().push(quiet);
        let averaged = Cnn::parse(two.to_string().as_bytes())
            .unwrap()
            .predict(&[1.0, 2.0, 3.0, 4.0, 0.0, 1.0, 0.0, 1.0]);
        assert!((averaged - (p + 0.5) / 2.0).abs() < 1e-12, "{averaged}");
    }

    #[test]
    fn a_file_with_the_wrong_shapes_or_weights_is_refused() {
        let refused = |edit: fn(&mut serde_json::Value)| {
            let mut file = tiny();
            edit(&mut file);
            Cnn::parse(file.to_string().as_bytes()).unwrap_err()
        };
        assert!(matches!(
            refused(|f| f["format"] = "trees".into()),
            CnnError::NotCnn(_)
        ));
        assert_eq!(refused(|f| f["version"] = 2.into()), CnnError::Version(2));
        assert!(matches!(
            refused(|f| f["members"][0]["conv"][0]["in"] = 3.into()),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| f["members"][0]["conv"][0]["kernel"] = 2.into()),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| {
                f["members"][0]["conv"][0]["weight"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| f["members"][0]["dense"][0]["in"] = 1.into()),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| f["members"][0]["dense"][0]["out"] = 2.into()),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| f["extra"] = 1.into()),
            CnnError::NotCnn(_)
        ));
        assert!(matches!(
            refused(|f| f["members"] = serde_json::json!([])),
            CnnError::Malformed(_)
        ));
        assert!(matches!(Cnn::parse(b"PPGTREES"), Err(CnnError::NotCnn(_))));
    }
}
