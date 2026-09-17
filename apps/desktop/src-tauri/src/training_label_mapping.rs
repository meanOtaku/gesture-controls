//! Explicit label-to-training-target mapping, owned by a training selection.
//!
//! Collection labels (`label_registry.rs`) carry no training semantics by
//! themselves: whether a given label becomes a trained target class, a
//! negative/background example, or is excluded from training is decided per
//! training run by this mapping. A label with no entry here is neither
//! trained on nor silently folded into "negative" — [`validate_mapping_covers`]
//! rejects the run instead. This mirrors `pinch_classifier.labels.LabelMapping`
//! on the Python side, which is the mapping's actual consumer during training.
//!
//! [`legacy_compatibility_mapping`] is the one sanctioned exception: it
//! reproduces the pre-M1-B fixed vocabulary (pinch_start/pinch_release as
//! targets, every other original recorder label as negative, pinch_hold
//! excluded — matching the desktop's existing default of never passing
//! `--hold-handling`) so CSVs recorded before per-label training roles
//! existed keep training without requiring an explicit mapping file. Any
//! other label is deliberately left uncovered by it.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub const LABEL_MAPPING_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum LabelMappingEntry {
    #[serde(rename = "target")]
    Target { target: String },
    #[serde(rename = "negative")]
    Negative,
    #[serde(rename = "exclude")]
    Exclude,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelMapping {
    pub version: u32,
    pub entries: BTreeMap<String, LabelMappingEntry>,
}

enum LegacyRole {
    Target(&'static str),
    Negative,
    Exclude,
}

/// The fixed vocabulary this desktop app recorded before per-label training roles existed. Desktop-triggered
/// training never passes `--hold-handling`, so pinch_hold mirrors that path's existing default: `exclude`.
const LEGACY_LABEL_ROLES: &[(&str, LegacyRole)] = &[
    ("idle", LegacyRole::Negative),
    ("pinch_start", LegacyRole::Target("pinch_start")),
    ("pinch_hold", LegacyRole::Exclude),
    ("pinch_release", LegacyRole::Target("pinch_release")),
    ("walking", LegacyRole::Negative),
    ("typing", LegacyRole::Negative),
    ("using_mouse", LegacyRole::Negative),
    ("touching_face", LegacyRole::Negative),
    ("adjusting_headphones", LegacyRole::Negative),
    ("picking_up_cup", LegacyRole::Negative),
    ("scratching", LegacyRole::Negative),
    ("normal_wrist_rotation", LegacyRole::Negative),
    ("standing", LegacyRole::Negative),
    ("sitting", LegacyRole::Negative),
];

pub fn legacy_compatibility_mapping() -> LabelMapping {
    let entries = LEGACY_LABEL_ROLES
        .iter()
        .map(|(label, role)| {
            let entry = match role {
                LegacyRole::Target(target) => LabelMappingEntry::Target {
                    target: (*target).to_string(),
                },
                LegacyRole::Negative => LabelMappingEntry::Negative,
                LegacyRole::Exclude => LabelMappingEntry::Exclude,
            };
            ((*label).to_string(), entry)
        })
        .collect();
    LabelMapping {
        version: LABEL_MAPPING_VERSION,
        entries,
    }
}

/// Merges an optional caller-supplied mapping on top of the legacy compatibility defaults: explicit entries
/// win, so a caller can override pinch_hold's handling or add roles for entirely new labels. Passing `None`
/// preserves training exactly as it worked before per-label mapping existed, for the legacy vocabulary only.
pub fn effective_mapping(explicit: Option<LabelMapping>) -> Result<LabelMapping, String> {
    let mut merged = legacy_compatibility_mapping();
    if let Some(explicit) = explicit {
        if explicit.version != LABEL_MAPPING_VERSION {
            return Err(format!(
                "unsupported label mapping version {} (expected {})",
                explicit.version, LABEL_MAPPING_VERSION
            ));
        }
        merged.entries.extend(explicit.entries);
    }
    Ok(merged)
}

/// The tflite backend's exported model is hard-pinned to this fixed three-class deployment contract
/// (mirrors `model_registry::DEPLOYABLE_CLASS_LABELS` minus "negative", which every `negative`-role entry
/// already maps to regardless of its label). A mapping trained through that backend must not be able to
/// target any other class.
pub const TFLITE_DEPLOYABLE_TARGETS: [&str; 2] = ["pinch_start", "pinch_release"];

/// Rejects a mapping whose `target` role entries would train toward a class outside `allowed_targets`,
/// naming exactly which disallowed target(s) were requested. Used to keep the tflite backend's training
/// run pinned to its fixed deployable class set before the trainer subprocess ever starts.
pub fn validate_mapping_targets(
    mapping: &LabelMapping,
    allowed_targets: &[&str],
) -> Result<(), String> {
    let disallowed: BTreeSet<&str> = mapping
        .entries
        .values()
        .filter_map(|entry| match entry {
            LabelMappingEntry::Target { target }
                if !allowed_targets.contains(&target.as_str()) =>
            {
                Some(target.as_str())
            }
            _ => None,
        })
        .collect();
    if disallowed.is_empty() {
        return Ok(());
    }
    Err(format!(
        "label mapping targets {disallowed:?} are not in the deployable class set {allowed_targets:?}; \
         use role 'negative' or 'exclude' for any label that must not train one of these target classes"
    ))
}

/// Rejects a mapping that does not cover every label in `required_labels`, naming exactly which ones are
/// missing so the caller can assign each an explicit target/negative/exclude role before training starts.
pub fn validate_mapping_covers(
    mapping: &LabelMapping,
    required_labels: &BTreeSet<String>,
) -> Result<(), String> {
    let missing: Vec<&str> = required_labels
        .iter()
        .filter(|label| !mapping.entries.contains_key(label.as_str()))
        .map(String::as_str)
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "the following collection label(s) have no training role mapping (target/negative/exclude): {}. \
         Assign a role for each before starting training.",
        missing.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn legacy_mapping_covers_the_original_fixed_vocabulary() {
        let mapping = legacy_compatibility_mapping();
        let required = labels(&["idle", "pinch_start", "pinch_hold", "pinch_release", "walking"]);
        assert!(validate_mapping_covers(&mapping, &required).is_ok());
    }

    #[test]
    fn rejects_a_label_absent_from_both_legacy_and_explicit_mappings() {
        let mapping = effective_mapping(None).expect("legacy-only mapping is always valid");
        let required = labels(&["idle", "double_tap"]);
        let error = validate_mapping_covers(&mapping, &required).expect_err("double_tap has no entry");
        assert!(error.contains("double_tap"));
        assert!(!error.contains("idle"));
    }

    #[test]
    fn explicit_entry_covers_a_new_label_and_overrides_legacy_defaults() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "double_tap".to_string(),
            LabelMappingEntry::Target {
                target: "double_tap".to_string(),
            },
        );
        entries.insert("pinch_hold".to_string(), LabelMappingEntry::Negative);
        let explicit = LabelMapping {
            version: LABEL_MAPPING_VERSION,
            entries,
        };
        let merged = effective_mapping(Some(explicit)).expect("versions match");
        assert_eq!(
            merged.entries.get("pinch_hold"),
            Some(&LabelMappingEntry::Negative)
        );
        let required = labels(&["idle", "pinch_hold", "double_tap"]);
        assert!(validate_mapping_covers(&merged, &required).is_ok());
    }

    #[test]
    fn validate_mapping_targets_accepts_only_allowed_targets() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "pinch_start".to_string(),
            LabelMappingEntry::Target {
                target: "pinch_start".to_string(),
            },
        );
        entries.insert("idle".to_string(), LabelMappingEntry::Negative);
        let mapping = LabelMapping {
            version: LABEL_MAPPING_VERSION,
            entries,
        };
        assert!(validate_mapping_targets(&mapping, &TFLITE_DEPLOYABLE_TARGETS).is_ok());
    }

    #[test]
    fn validate_mapping_targets_rejects_a_target_outside_the_deployable_set() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "double_tap".to_string(),
            LabelMappingEntry::Target {
                target: "double_tap".to_string(),
            },
        );
        let mapping = LabelMapping {
            version: LABEL_MAPPING_VERSION,
            entries,
        };
        let error = validate_mapping_targets(&mapping, &TFLITE_DEPLOYABLE_TARGETS)
            .expect_err("double_tap is not a deployable tflite target");
        assert!(error.contains("double_tap"));
    }

    #[test]
    fn rejects_an_unsupported_mapping_version() {
        let explicit = LabelMapping {
            version: LABEL_MAPPING_VERSION + 1,
            entries: BTreeMap::new(),
        };
        assert!(effective_mapping(Some(explicit)).is_err());
    }
}
