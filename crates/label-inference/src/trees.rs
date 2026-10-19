//! A tree-ensemble model file (`model.trees`), as the trainer's `trees.py` writes it, and its evaluation.
//!
//! Little-endian: `b"PPGTREES"`, `u32` version (1), `u32` features, `u32` trees; then per tree a `u32` node count and per
//! node `i32` feature (-1 for a leaf), `f64` threshold, `u32` left, `u32` right, `f32` probability. A sample goes left when
//! its feature, rounded to single precision, is at most the threshold (as scikit-learn compares); the positive class's
//! probability is the mean over the trees of the leaf each reaches.
//!
//! Every index is checked when the file is read, and every path is checked to end at a leaf without revisiting a node, so
//! evaluation can neither go out of bounds nor loop.

use thiserror::Error;

pub const MAGIC: &[u8; 8] = b"PPGTREES";
pub const VERSION: u32 = 1;
const NODE_BYTES: usize = 4 + 8 + 4 + 4 + 4;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TreesError {
    #[error("the model file is not a tree ensemble (it does not start with PPGTREES)")]
    NotTrees,
    #[error("the tree ensemble's version is {0}; this app reads version {VERSION}")]
    Version(u32),
    #[error("the tree ensemble file ends too early")]
    Truncated,
    #[error("the tree ensemble file has bytes after its last tree")]
    TrailingBytes,
    #[error("the tree ensemble has no trees")]
    Empty,
    #[error("tree {tree} is malformed: {detail}")]
    Malformed { tree: usize, detail: String },
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Node {
    /// `None` for a leaf.
    feature: Option<u32>,
    threshold: f64,
    left: u32,
    right: u32,
    probability: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TreeEnsemble {
    features: usize,
    trees: Vec<Vec<Node>>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], TreesError> {
        let end = self.at.checked_add(N).ok_or(TreesError::Truncated)?;
        let slice = self.bytes.get(self.at..end).ok_or(TreesError::Truncated)?;
        self.at = end;
        Ok(slice.try_into().expect("N bytes"))
    }
    fn u32(&mut self) -> Result<u32, TreesError> {
        self.take::<4>().map(u32::from_le_bytes)
    }
}

impl TreeEnsemble {
    pub fn parse(bytes: &[u8]) -> Result<Self, TreesError> {
        let mut r = Reader { bytes, at: 0 };
        if &r.take::<8>().map_err(|_| TreesError::NotTrees)? != MAGIC {
            return Err(TreesError::NotTrees);
        }
        let version = r.u32()?;
        if version != VERSION {
            return Err(TreesError::Version(version));
        }
        let features = r.u32()? as usize;
        let count = r.u32()? as usize;
        if count == 0 {
            return Err(TreesError::Empty);
        }
        let mut trees = Vec::with_capacity(count.min(10_000));
        for tree in 0..count {
            let nodes = r.u32()? as usize;
            if nodes == 0 {
                return Err(TreesError::Malformed { tree, detail: "it has no nodes".into() });
            }
            let needed = nodes.checked_mul(NODE_BYTES).ok_or(TreesError::Truncated)?;
            if bytes.len().saturating_sub(r.at) < needed {
                return Err(TreesError::Truncated);
            }
            let mut out = Vec::with_capacity(nodes);
            for _ in 0..nodes {
                let feature = i32::from_le_bytes(r.take::<4>()?);
                let threshold = f64::from_le_bytes(r.take::<8>()?);
                let left = r.u32()?;
                let right = r.u32()?;
                let probability = f32::from_le_bytes(r.take::<4>()?);
                out.push(Node {
                    feature: u32::try_from(feature).ok(),
                    threshold,
                    left,
                    right,
                    probability,
                });
            }
            check_tree(tree, &out, features)?;
            trees.push(out);
        }
        if r.at != bytes.len() {
            return Err(TreesError::TrailingBytes);
        }
        Ok(Self { features, trees })
    }

    pub fn features(&self) -> usize {
        self.features
    }

    pub fn trees(&self) -> usize {
        self.trees.len()
    }

    /// The positive class's probability. `x` must have [`Self::features`] values (checked by the caller's contract).
    pub fn predict(&self, x: &[f64]) -> f64 {
        let mut total = 0.0f64;
        for tree in &self.trees {
            let mut node = &tree[0];
            while let Some(feature) = node.feature {
                let value = f64::from(x[feature as usize] as f32);
                node = &tree[if value <= node.threshold { node.left } else { node.right } as usize];
            }
            total += f64::from(node.probability);
        }
        total / self.trees.len() as f64
    }
}

/// Every child index in range, every feature in range, every probability in [0, 1], and every node reached once from the
/// root (so a walk ends at a leaf).
fn check_tree(tree: usize, nodes: &[Node], features: usize) -> Result<(), TreesError> {
    let bad = |detail: String| TreesError::Malformed { tree, detail };
    let mut seen = vec![false; nodes.len()];
    let mut stack = vec![0usize];
    while let Some(index) = stack.pop() {
        if std::mem::replace(&mut seen[index], true) {
            return Err(bad(format!("node {index} is reached twice")));
        }
        let node = &nodes[index];
        match node.feature {
            None => {
                if !(0.0..=1.0).contains(&node.probability) {
                    return Err(bad(format!("leaf {index} has probability {}", node.probability)));
                }
            }
            Some(feature) => {
                if feature as usize >= features {
                    return Err(bad(format!("node {index} reads feature {feature} of {features}")));
                }
                if !node.threshold.is_finite() {
                    return Err(bad(format!("node {index} has threshold {}", node.threshold)));
                }
                for child in [node.left, node.right] {
                    if child as usize >= nodes.len() {
                        return Err(bad(format!("node {index} points at node {child} of {}", nodes.len())));
                    }
                    stack.push(child as usize);
                }
            }
        }
    }
    if seen.iter().any(|reached| !reached) {
        return Err(bad("some nodes are never reached".into()));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// One node: (feature or -1, threshold, left, right, probability).
    type RawNode = (i32, f64, u32, u32, f32);

    /// A file of `trees`, each a list of nodes.
    pub fn file(features: u32, trees: &[Vec<RawNode>]) -> Vec<u8> {
        let mut out = MAGIC.to_vec();
        for v in [VERSION, features, trees.len() as u32] {
            out.extend(v.to_le_bytes());
        }
        for tree in trees {
            out.extend((tree.len() as u32).to_le_bytes());
            for &(f, t, l, r, p) in tree {
                out.extend(f.to_le_bytes());
                out.extend(t.to_le_bytes());
                out.extend(l.to_le_bytes());
                out.extend(r.to_le_bytes());
                out.extend(p.to_le_bytes());
            }
        }
        out
    }

    fn stump(feature: i32, threshold: f64, low: f32, high: f32) -> Vec<RawNode> {
        vec![(feature, threshold, 1, 2, 0.0), (-1, 0.0, 0, 0, low), (-1, 0.0, 0, 0, high)]
    }

    #[test]
    fn it_averages_the_leaves_each_tree_reaches() {
        let model = TreeEnsemble::parse(&file(2, &[stump(0, 0.5, 0.0, 1.0), stump(1, 0.0, 0.2, 0.6)])).unwrap();
        assert_eq!((model.features(), model.trees()), (2, 2));
        // Leaves are single precision.
        assert!((model.predict(&[0.4, 1.0]) - 0.3).abs() < 1e-7); // left of 0.5 -> 0, right of 0 -> 0.6
        assert!((model.predict(&[0.9, -1.0]) - 0.6).abs() < 1e-7);
    }

    #[test]
    fn a_value_is_compared_in_single_precision_as_scikit_learn_does() {
        // 0.1 as f32 is 0.100000001490116..., above the f64 threshold 0.1: it goes right, as in scikit-learn.
        let model = TreeEnsemble::parse(&file(1, &[stump(0, 0.1, 0.0, 1.0)])).unwrap();
        assert_eq!(model.predict(&[0.1]), 1.0);
    }

    #[test]
    fn broken_files_are_refused() {
        let good = file(1, &[stump(0, 0.5, 0.0, 1.0)]);
        assert_eq!(TreeEnsemble::parse(b"ONNX....").unwrap_err(), TreesError::NotTrees);
        assert_eq!(TreeEnsemble::parse(&good[..good.len() - 3]).unwrap_err(), TreesError::Truncated);
        let mut extra = good.clone();
        extra.push(0);
        assert_eq!(TreeEnsemble::parse(&extra).unwrap_err(), TreesError::TrailingBytes);
        let looping = file(1, &[vec![(0, 0.5, 0, 0, 0.0)]]);
        assert!(matches!(TreeEnsemble::parse(&looping), Err(TreesError::Malformed { .. })));
        let out_of_range = file(1, &[stump(3, 0.5, 0.0, 1.0)]);
        assert!(matches!(TreeEnsemble::parse(&out_of_range), Err(TreesError::Malformed { .. })));
        let child_out = file(1, &[vec![(0, 0.5, 1, 7, 0.0), (-1, 0.0, 0, 0, 0.5)]]);
        assert!(matches!(TreeEnsemble::parse(&child_out), Err(TreesError::Malformed { .. })));
        let bad_leaf = file(1, &[stump(0, 0.5, 0.0, 1.5)]);
        assert!(matches!(TreeEnsemble::parse(&bad_leaf), Err(TreesError::Malformed { .. })));
    }
}
