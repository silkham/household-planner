// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.13.1";  // 1.13.1 = fix "Save failed: duplicate key idx_hp_catrules_key" — single category_rule writes now upsert on (household_id, match_key) via store.saveCategoryRule (was insert-by-id, collided with existing rules)
export const BUILD_DATE  = "2026-07-08";
