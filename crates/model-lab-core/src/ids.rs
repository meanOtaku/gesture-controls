use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum IdError {
    #[error(
        "a label id starts with a lower-case letter and has only lower-case letters, digits and underscores (at most 48 characters), got '{0}'"
    )]
    Label(String),
    #[error(
        "{kind} id must be 1 to 64 letters, digits, '-' or '_', starting with a letter or digit, got '{value}'"
    )]
    Other { kind: &'static str, value: String },
}

fn valid_label(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 48
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn valid_other(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

macro_rules! id_type {
    ($name:ident, $kind:literal, $label:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                if $label {
                    if !valid_label(&value) {
                        return Err(IdError::Label(value));
                    }
                } else if !valid_other(&value) {
                    return Err(IdError::Other { kind: $kind, value });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = IdError;
            fn try_from(value: String) -> Result<Self, IdError> {
                Self::new(value)
            }
        }

        impl From<$name> for String {
            fn from(id: $name) -> String {
                id.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

// A label id is the same slug the Model Lab label catalogue already uses (`pinch_start`, `wrist_flick`).
id_type!(LabelId, "label", true);
id_type!(ProjectId, "project", false);
id_type!(SnapshotId, "snapshot", false);
id_type!(RunId, "run", false);
id_type!(ModelVersionId, "model version", false);
id_type!(RecordingId, "recording", false);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_ids_match_the_catalogue_slugs_and_reject_anything_else() {
        for ok in ["pinch_start", "swipe_left", "a", "label_2"] {
            assert!(LabelId::new(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "Pinch",
            "2fast",
            "has space",
            "dash-ed",
            "../x",
            &"a".repeat(49),
        ] {
            assert!(LabelId::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn other_ids_allow_dashes_but_not_path_characters() {
        for ok in ["model-1a2b", "Run_7", "0abc"] {
            assert!(ModelVersionId::new(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-lead", "a/b", "a b", "..", &"x".repeat(65)] {
            assert!(RunId::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_invalid_id_cannot_be_deserialised() {
        assert!(serde_json::from_str::<LabelId>("\"Bad Id\"").is_err());
        assert_eq!(
            serde_json::from_str::<LabelId>("\"ok_id\"")
                .unwrap()
                .as_str(),
            "ok_id"
        );
        assert_eq!(
            serde_json::to_string(&LabelId::new("ok_id").unwrap()).unwrap(),
            "\"ok_id\""
        );
    }
}
