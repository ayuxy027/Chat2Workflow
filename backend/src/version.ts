/**
 * Worker identity, for the audit trail.
 *
 * Temporal history is the legal audit trail (CLAUDE.md §Temporal rules). Six
 * months on, "which code produced this output?" has to be answerable from the
 * history alone — and an activity result that records only the answer cannot
 * answer it. Three things are stamped:
 *
 *   - WORKER_BUILD_ID  which build of this worker ran the activity. Also passed
 *     to `Worker.create({ buildId })`, so the server records it against every
 *     workflow task too.
 *   - PROMPT VERSIONS  the system prompt is the largest single determinant of a
 *     model's output. Editing SYSTEM in plan-graph.ts or run-chat-node.ts
 *     changes what the tool asserts about a contract, so the constant next to
 *     it must be bumped in the same commit.
 *   - VERIFIER_VERSION the citation matcher's behaviour. `verified: true` means
 *     "this matcher, at this version, found this quote on this page" — widening
 *     or narrowing the match changes what that claim is worth.
 *
 * Nothing here is imported by workflow code: it reads process.env.
 */

import { optionalEnv } from "./env.js";

/**
 * Set WORKER_BUILD_ID to the git SHA in the worker image. It is deliberately
 * not shelled out to `git` at runtime: the deployed image has no repository,
 * and a value that silently degrades to "unknown" in production while looking
 * correct in dev is worse than one that is obviously unset.
 */
export const WORKER_BUILD_ID = optionalEnv("WORKER_BUILD_ID", "dev-unpinned");

/** Bump when the planner system prompt or its output contract changes. */
export const PLAN_PROMPT_VERSION = "plan/2026-08-05.1";

/** Bump when the analysis system prompt or its citation rules change. */
export const ANALYSIS_PROMPT_VERSION = "analysis/2026-08-05.1";

/** Bump when quote normalisation or the match strategy in verifyOne changes. */
export const VERIFIER_VERSION = "verify/2026-08-05.1";

/** Stamped into every activity result that calls a model or runs a tool. */
export interface Provenance {
  workerBuildId: string;
  promptVersion: string;
}

export function provenance(promptVersion: string): Provenance {
  return { workerBuildId: WORKER_BUILD_ID, promptVersion };
}
