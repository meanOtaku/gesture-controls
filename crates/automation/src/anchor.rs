//! Where on the screen a recipe's overlay (its knob or slider) is shown.
//!
//! By default it is where the user looks to use the recipe: a recipe that starts by looking at the top-left corner
//! shows its slider in the top-left corner, so the eyes are already on it. A location is only a name and a head pose,
//! so the screen position is read from its id (`topLeft`, `bottomEdge`, `rightSide`, `center`); a recipe can also
//! name a position of its own, and one that looks nowhere and names none uses the top right.

use serde::{Deserialize, Serialize};

use crate::recipe::{Recipe, Stage};

/// One of nine places on the screen: its corners, the middle of its edges, and its centre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenAnchor {
    TopLeft,
    Top,
    #[default]
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

impl ScreenAnchor {
    pub const ALL: [ScreenAnchor; 9] = [
        Self::TopLeft,
        Self::Top,
        Self::TopRight,
        Self::Left,
        Self::Center,
        Self::Right,
        Self::BottomLeft,
        Self::Bottom,
        Self::BottomRight,
    ];

    /// Across and down the screen, each 0 (left or top), 0.5 (middle) or 1 (right or bottom).
    pub fn fractions(self) -> (f64, f64) {
        let across = match self {
            Self::TopLeft | Self::Left | Self::BottomLeft => 0.0,
            Self::Top | Self::Center | Self::Bottom => 0.5,
            Self::TopRight | Self::Right | Self::BottomRight => 1.0,
        };
        let down = match self {
            Self::TopLeft | Self::Top | Self::TopRight => 0.0,
            Self::Left | Self::Center | Self::Right => 0.5,
            Self::BottomLeft | Self::Bottom | Self::BottomRight => 1.0,
        };
        (across, down)
    }

    /// The screen position a location's id names, if it names one: `topLeft`, `bottom_right`, `leftEdge`, `top`,
    /// `center`, `middle`. Words other than top, bottom, left, right, center, centre and middle are ignored; an id
    /// that names both top and bottom (or left and right) names nothing.
    pub fn for_location(id: &str) -> Option<Self> {
        let mut words = Vec::new();
        let mut word = String::new();
        for c in id.chars() {
            // A word ends at anything but a lowercase letter: `topLeft`, `top_left`, `left2`.
            if !c.is_ascii_lowercase() && !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            if c.is_ascii_alphabetic() {
                word.push(c.to_ascii_lowercase());
            }
        }
        if !word.is_empty() {
            words.push(word);
        }
        let has = |name: &str| words.iter().any(|w| w == name);
        let middle = has("center") || has("centre") || has("middle");
        let vertical = match (has("top"), has("bottom")) {
            (true, false) => Some(0),
            (false, true) => Some(2),
            (false, false) => None,
            (true, true) => return None,
        };
        let horizontal = match (has("left"), has("right")) {
            (true, false) => Some(0),
            (false, true) => Some(2),
            (false, false) => None,
            (true, true) => return None,
        };
        let (row, column) = match (vertical, horizontal) {
            (None, None) if middle => (1, 1),
            (None, None) => return None,
            (row, column) => (row.unwrap_or(1), column.unwrap_or(1)),
        };
        Some(Self::ALL[row * 3 + column])
    }
}

impl Recipe {
    /// Where this recipe's overlay goes: the position it names, else where its look-at location is, else the top
    /// right. With several locations in its chain, the first that names a position counts.
    pub fn overlay_anchor(&self) -> ScreenAnchor {
        self.overlay_at
            .or_else(|| {
                self.stages.iter().find_map(|stage| match stage {
                    Stage::HeadAt { location } => ScreenAnchor::for_location(location),
                    _ => None,
                })
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_location_id_names_its_place_on_the_screen() {
        use ScreenAnchor::*;
        for (id, anchor) in [
            ("topLeft", Some(TopLeft)),
            ("topRight", Some(TopRight)),
            ("bottom_right", Some(BottomRight)),
            ("leftEdge", Some(Left)),
            ("rightSide2", Some(Right)),
            ("top", Some(Top)),
            ("bottomMiddle", Some(Bottom)),
            ("center", Some(Center)),
            ("screenCentre", Some(Center)),
            ("monitor", None),
            ("desk", None),
            ("topBottom", None),
            ("leftRight", None),
        ] {
            assert_eq!(ScreenAnchor::for_location(id), anchor, "{id}");
        }
    }

    #[test]
    fn every_anchor_sits_on_a_three_by_three_grid() {
        assert_eq!(ScreenAnchor::TopLeft.fractions(), (0.0, 0.0));
        assert_eq!(ScreenAnchor::Center.fractions(), (0.5, 0.5));
        assert_eq!(ScreenAnchor::BottomRight.fractions(), (1.0, 1.0));
        assert_eq!(ScreenAnchor::Left.fractions(), (0.0, 0.5));
        for anchor in ScreenAnchor::ALL {
            let json = serde_json::to_string(&anchor).unwrap();
            assert_eq!(serde_json::from_str::<ScreenAnchor>(&json).unwrap(), anchor);
        }
        assert_eq!(
            serde_json::to_string(&ScreenAnchor::BottomLeft).unwrap(),
            "\"bottomLeft\""
        );
    }
}
