//! The v2 CNN's model file (`model.cnn`, format `ppg-imu-cnn-branches`), as the trainer's `cnn_v2.py` writes it, and its
//! evaluation.
//!
//! JSON: `{"format": "ppg-imu-cnn-branches", "version": 1, "channels", "length", "members": [{"branches": [{"channels":
//! [...], "conv": [...]}, ...], "shared": [...], "dense": [...]}, ...]}`: one to five networks, averaged. In each, every
//! branch reads the input channels it names (indices, in order) through its own convolutions; the branches' outputs, side
//! by side in branch order, go through the shared convolutions. The pooled values (each channel's maximum over time, then
//! its mean) of every branch, in order, then of the shared convolutions go side by side into the dense layers. Each
//! convolution and dense layer is as in the first CNN's file ([`crate::cnn`]): zero padding to keep the length, a ReLU
//! after each convolution and after every dense layer but the last, whose one value goes through a sigmoid.
//!
//! A multi-gesture file names its outputs (`"outputs": ["nothing", gesture, ...]`): the last dense layer gives one value
//! for each, through a softmax, and a gesture's model reads its own output ([`BranchCnn::reading`]): the probability of
//! that gesture, averaged over the networks.
//!
//! Every size and weight is checked when the file is read, so evaluation cannot go out of bounds.

use serde::Deserialize;

use crate::cnn::{
    CnnError, Conv, Dense, MAX_LAYERS, MAX_MEMBERS, MAX_WIDTH, check_convs, check_dense_to,
    malformed, pooled, run_convs, run_dense_raw,
};

pub const FORMAT: &str = "ppg-imu-cnn-branches";
pub const VERSION: u32 = 1;
const MAX_BRANCHES: usize = 8;
/// The first output of a multi-gesture file.
pub const NOTHING: &str = "nothing";
/// At most this many gestures in one file.
pub const MAX_GESTURES: usize = 6;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Branch {
    channels: Vec<usize>,
    conv: Vec<Conv>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    branches: Vec<Branch>,
    shared: Vec<Conv>,
    dense: Vec<Dense>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    format: String,
    version: u32,
    channels: usize,
    length: usize,
    #[serde(default)]
    outputs: Option<Vec<String>>,
    members: Vec<Member>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BranchCnn {
    channels: usize,
    length: usize,
    /// A multi-gesture file's outputs, "nothing" first; `None` for one gesture (one output, a sigmoid).
    outputs: Option<Vec<String>>,
    /// The output [`BranchCnn::predict`] gives: 1 (the gesture) unless [`BranchCnn::reading`] chose another.
    read: usize,
    members: Vec<Member>,
}

impl BranchCnn {
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
        if let Some(outputs) = &file.outputs {
            let named = outputs
                .iter()
                .skip(1)
                .all(|o| !o.is_empty() && o != NOTHING);
            let distinct = outputs
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == outputs.len();
            if !(3..=MAX_GESTURES + 1).contains(&outputs.len())
                || outputs[0] != NOTHING
                || !named
                || !distinct
            {
                return Err(malformed(format!(
                    "a multi-gesture file names '{NOTHING}' and then 2 to {MAX_GESTURES} different gestures as its outputs"
                )));
            }
        }
        let width = file.outputs.as_ref().map_or(1, Vec::len);
        for member in &file.members {
            check_member(member, file.channels, width)?;
        }
        Ok(Self {
            channels: file.channels,
            length: file.length,
            outputs: file.outputs,
            read: 1,
            members: file.members,
        })
    }

    /// A multi-gesture file's outputs, "nothing" first; `None` for a one-gesture file.
    pub fn outputs(&self) -> Option<&[String]> {
        self.outputs.as_deref()
    }

    /// The same networks giving output `index` (a gesture's: 1 or more) from [`BranchCnn::predict`]. A one-gesture file
    /// has only output 1.
    pub fn reading(mut self, index: usize) -> Result<Self, CnnError> {
        let count = self.outputs.as_ref().map_or(2, Vec::len);
        if index == 0 || index >= count {
            return Err(malformed(format!(
                "output {index} is not one of its gestures' (1 to {})",
                count - 1
            )));
        }
        self.read = index;
        Ok(self)
    }

    /// How many inputs it reads: channels x length.
    pub fn features(&self) -> usize {
        self.channels * self.length
    }

    /// The probability of its gesture (output [`BranchCnn::reading`] chose) for `input` (channel by channel): the
    /// networks' probabilities averaged.
    pub fn predict(&self, input: &[f64]) -> f64 {
        self.predict_all(input)[self.read]
    }

    /// Every output's probability for `input`, the networks' averaged: [nothing, gesture] for a one-gesture file, and
    /// for a multi-gesture file [nothing, each gesture...], which sum to 1. One pass of the networks gives every
    /// gesture's score.
    pub fn predict_all(&self, input: &[f64]) -> Vec<f64> {
        assert_eq!(input.len(), self.features(), "checked by the caller");
        let width = self.outputs.as_ref().map_or(2, Vec::len);
        let mut total = vec![0.0; width];
        for m in &self.members {
            let raw = m.predict(input, self.length);
            if self.outputs.is_none() {
                let p = 1.0 / (1.0 + (-raw[0]).exp());
                total[0] += 1.0 - p;
                total[1] += p;
            } else {
                let top = raw.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let sum: f64 = raw.iter().map(|v| (v - top).exp()).sum();
                for (slot, v) in total.iter_mut().zip(&raw) {
                    *slot += (v - top).exp() / sum;
                }
            }
        }
        let n = self.members.len() as f64;
        total.iter().map(|v| v / n).collect()
    }
}

fn check_member(m: &Member, channels: usize, outputs: usize) -> Result<(), CnnError> {
    if m.branches.is_empty() || m.branches.len() > MAX_BRANCHES {
        return Err(malformed("each network needs one to eight branches"));
    }
    let layers =
        m.branches.iter().map(|b| b.conv.len()).max().unwrap_or(0) + m.shared.len() + m.dense.len();
    if m.shared.is_empty() || m.dense.is_empty() || layers > MAX_LAYERS {
        return Err(malformed(
            "each network needs shared convolutions and a dense layer, and at most 8 layers deep",
        ));
    }
    let mut joined = 0;
    let mut pooled_width = 0;
    for (i, b) in m.branches.iter().enumerate() {
        if b.channels.is_empty() || b.channels.iter().any(|&c| c >= channels) || b.conv.is_empty() {
            return Err(malformed(format!(
                "branch {i} names no channels, a channel the input does not have, or no convolution"
            )));
        }
        let out = check_convs(&b.conv, b.channels.len())?;
        joined += out;
        pooled_width += 2 * out;
    }
    let shared = check_convs(&m.shared, joined)?;
    check_dense_to(&m.dense, pooled_width + 2 * shared, outputs)
}

impl Member {
    fn predict(&self, input: &[f64], length: usize) -> Vec<f64> {
        let mut maps = Vec::new();
        let mut values = Vec::new();
        for b in &self.branches {
            let x: Vec<f64> = b
                .channels
                .iter()
                .flat_map(|&c| input[c * length..][..length].iter().copied())
                .collect();
            let y = run_convs(&b.conv, x, length);
            values.extend(pooled(&y, length));
            maps.extend(y);
        }
        let shared = run_convs(&self.shared, maps, length);
        values.extend(pooled(&shared, length));
        run_dense_raw(&self.dense, values)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two branches of one channel each (1 -> 1, kernel 1), a shared 2 -> 1 convolution (kernel 1) and one dense layer.
    fn tiny() -> serde_json::Value {
        let conv = |input: usize, weight: Vec<f64>, bias: f64| serde_json::json!({"in": input, "out": 1, "kernel": 1, "dilation": 1, "weight": weight, "bias": [bias]});
        serde_json::json!({
            "format": FORMAT, "version": 1, "channels": 2, "length": 3,
            "members": [{
                "branches": [{"channels": [0], "conv": [conv(1, vec![2.0], 0.0)]},
                             {"channels": [1], "conv": [conv(1, vec![1.0], -1.0)]}],
                "shared": [conv(2, vec![1.0, 1.0], 0.0)],
                "dense": [{"in": 6, "out": 1, "weight": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0], "bias": [0.0]}],
            }],
        })
    }

    #[test]
    fn a_tiny_branch_network_gives_the_value_worked_out_by_hand() {
        let cnn = BranchCnn::parse(tiny().to_string().as_bytes()).unwrap();
        assert_eq!(cnn.features(), 6);
        // a = [1, 2, 3] -> branch 0: [2, 4, 6] (max 6, mean 4); b = [0, 2, 4] -> branch 1: [0, 1, 3] (max 3, mean 4/3).
        // shared: [2, 5, 9] (max 9, mean 16/3). Pooled: [6, 4, 3, 4/3, 9, 16/3]; dense picks 6 + 16/3.
        let p = cnn.predict(&[1.0, 2.0, 3.0, 0.0, 2.0, 4.0]);
        let want = 1.0 / (1.0 + (-(6.0 + 16.0 / 3.0f64)).exp());
        assert!((p - want).abs() < 1e-12, "{p} vs {want}");
    }

    #[test]
    fn a_branch_file_with_the_wrong_shapes_is_refused() {
        let refused = |edit: fn(&mut serde_json::Value)| {
            let mut file = tiny();
            edit(&mut file);
            BranchCnn::parse(file.to_string().as_bytes()).unwrap_err()
        };
        assert!(matches!(
            refused(|f| f["format"] = "ppg-imu-cnn".into()),
            CnnError::NotCnn(_)
        ));
        assert!(matches!(
            refused(|f| f["members"][0]["branches"][1]["channels"] = serde_json::json!([2])),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| f["members"][0]["shared"][0]["in"] = 3.into()),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| f["members"][0]["dense"][0]["in"] = 4.into()),
            CnnError::Malformed(_)
        ));
        assert!(matches!(
            refused(|f| f["members"][0]["branches"] = serde_json::json!([])),
            CnnError::Malformed(_)
        ));
    }

    /// A tiny file with three outputs: the dense layer gives [6 + 16/3, 4, 0] (see the hand-worked test above).
    fn tiny_multi() -> serde_json::Value {
        let mut file = tiny();
        file["outputs"] = serde_json::json!(["nothing", "pinch_in", "pinch_out"]);
        file["members"][0]["dense"] = serde_json::json!([{"in": 6, "out": 3,
            "weight": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0,  0.0, 1.0, 0.0, 0.0, 0.0, 0.0,  0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "bias": [0.0, 0.0, 0.0]}]);
        file
    }

    #[test]
    fn a_multi_gesture_file_gives_each_gesture_its_share_of_a_softmax() {
        let input = [1.0, 2.0, 3.0, 0.0, 2.0, 4.0];
        let file = tiny_multi().to_string();
        let raw = [6.0 + 16.0 / 3.0, 4.0, 0.0];
        let sum: f64 = raw.iter().map(|v: &f64| v.exp()).sum();
        let cnn = BranchCnn::parse(file.as_bytes()).unwrap();
        assert_eq!(cnn.outputs().unwrap(), ["nothing", "pinch_in", "pinch_out"]);
        for index in [1, 2] {
            let p = cnn.clone().reading(index).unwrap().predict(&input);
            assert!((p - raw[index].exp() / sum).abs() < 1e-12);
        }
        assert!(cnn.clone().reading(0).is_err() && cnn.reading(3).is_err());
        let one = BranchCnn::parse(tiny().to_string().as_bytes()).unwrap();
        assert!(
            one.outputs().is_none() && one.clone().reading(1).is_ok() && one.reading(2).is_err()
        );
    }

    #[test]
    fn a_multi_gesture_file_must_name_its_outputs_and_give_one_value_for_each() {
        let refused = |edit: fn(&mut serde_json::Value)| {
            let mut file = tiny_multi();
            edit(&mut file);
            BranchCnn::parse(file.to_string().as_bytes()).is_err()
        };
        assert!(refused(
            |f| f["outputs"] = serde_json::json!(["nothing", "pinch_in"])
        ));
        assert!(refused(
            |f| f["outputs"] = serde_json::json!(["pinch_in", "nothing", "pinch_out"])
        ));
        assert!(refused(
            |f| f["outputs"] = serde_json::json!(["nothing", "pinch_in", "pinch_in"])
        ));
        assert!(refused(
            |f| f["outputs"] = serde_json::json!(["nothing", "a", "b", "c"])
        ));
        assert!(refused(|f| {
            f.as_object_mut().unwrap().remove("outputs");
        }));
    }

    #[test]
    fn the_runtime_gives_each_gesture_the_output_the_trainer_gave() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/cnn_v2_multi_gesture");
        let bytes = std::fs::read(dir.join("model.cnn")).unwrap();
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("expected.json")).unwrap()).unwrap();
        let cnn = BranchCnn::parse(&bytes).unwrap();
        for (input, outputs) in expected["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .zip(expected["outputs"].as_array().unwrap())
        {
            let input: Vec<f64> = input
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            for index in [1, 2] {
                let p = cnn.clone().reading(index).unwrap().predict(&input);
                assert!(
                    (p - outputs[index].as_f64().unwrap()).abs() < 1e-5,
                    "output {index}: {p}"
                );
            }
        }
    }
}
