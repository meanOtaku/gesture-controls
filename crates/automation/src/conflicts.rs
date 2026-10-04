use std::collections::BTreeSet;

use serde::Serialize;

use crate::recipe::Recipe;

/// Two enabled recipes trying to drive the same resource.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub resource: String,
    pub first: String,
    pub second: String,
}

/// Every pair of enabled recipes that drive the same resource. Disabled recipes never conflict.
pub fn find_conflicts(recipes: &[Recipe]) -> Vec<Conflict> {
    let enabled: Vec<&Recipe> = recipes.iter().filter(|recipe| recipe.enabled).collect();
    let mut conflicts = Vec::new();
    for (index, first) in enabled.iter().enumerate() {
        for second in &enabled[index + 1..] {
            if first.action.resource() == second.action.resource() {
                conflicts.push(Conflict {
                    resource: first.action.resource().to_string(),
                    first: first.id.clone(),
                    second: second.id.clone(),
                });
            }
        }
    }
    conflicts
}

/// The recipes held off because of a conflict: none of the conflicting ones run until the clash is resolved.
pub fn blocked_recipes(recipes: &[Recipe]) -> BTreeSet<String> {
    find_conflicts(recipes)
        .into_iter()
        .flat_map(|conflict| [conflict.first, conflict.second])
        .collect()
}
