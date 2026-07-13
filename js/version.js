// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.21.1";  // 1.21.1 = project-linking fixes: (1) transaction-side "Add to project" now lists each of a merchant's payments with a per-payment Link/Move (pick the single £531 B&Q, not all B&Q); optional "link all unlinked". (2) A payment already linked to another project/item is no longer hidden — it shows where it sits and linking MOVES it (both surfaces: Spending categorise sheet + line-item search). (3) Moving a payment recomputes BOTH the source and target item actual_cost (was leaving the source overstated). // 1.21.0 = V2 step 1: navigation + routing rework. New Home dashboard (three equal pillars — Forecast/Spending/Projects — each taps through), regrouped nav (Home + Plan/Spend/Set up) driven by one definition, mobile bottom nav (Home·Forecast·Spending·Projects) + a "More" grouped drawer, hash-based router (back button works; sub-route slot ready for project detail). Reports + Merchants added as stub screens. Tasks temporarily lives under Plan until it folds into Projects (step 2).
export const BUILD_DATE  = "2026-07-14";
