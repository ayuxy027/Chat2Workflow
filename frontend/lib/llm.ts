import "server-only";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { llmEnv } from "./env";

/**
 * The single module that owns the LLM provider, so swapping endpoints later is
 * a one-file change.
 *
 * `CLAUDE.md` sketches this as two top-level `const`s. It cannot be, here:
 * `next build` evaluates this module during static analysis with no
 * environment, and `llmEnv()` throws on a missing key by design. So the
 * provider is constructed lazily and memoised — same one-file ownership, no
 * build-time dependency on secrets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ENDPOINT: an OpenAI-compatible gateway serving DeepSeek-V4-Flash, a
 * REASONING model. Three behaviours were verified against the live endpoint and
 * each one is load-bearing.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. `supportsStructuredOutputs` stays FALSE (the default — note it is never
 *    passed below, deliberately). The endpoint ACCEPTS `response_format:
 *    json_schema` and then ignores it: generation is not constrained, and a
 *    probe returned malformed JSON after 11,308 tokens. With the flag false the
 *    AI SDK sends `response_format: { type: "json_object" }`, which the endpoint
 *    honours correctly. `generateObject` / `streamObject` will emit an
 *    "unsupported-setting" warning about the schema; that warning is expected,
 *    and the zod schema still validates the parsed result client-side. Do not
 *    "fix" it by setting the flag true.
 *
 * 2. Reasoning tokens are drawn from the SAME budget as the answer. Run out and
 *    the response is `content: null` with `finish_reason: "length"` — a silent
 *    empty answer, not an error. Hence a generous `maxOutputTokens` floor.
 *
 * 3. `reasoning_effort` is the main cost lever on this model, not a tuning
 *    detail: the same task cost ~11,300 completion tokens at the default versus
 *    118 at `"low"`. Structured calls (planning, extraction) default to `"low"`.
 *
 * Structured output goes through `generateObject` / `streamObject` with the zod
 * schemas from `@wf/shared` (`PlanResult`, `AnalysisResult`). Do not hand-roll
 * JSON parsing or prompt for "output only JSON".
 */

type Provider = ReturnType<typeof createOpenAICompatible>;

/**
 * Provider name, and therefore the `providerOptions` key: the AI SDK routes
 * `providerOptions.makora.*` to this provider and nothing else.
 */
const PROVIDER_NAME = "makora";

/**
 * Floor for `maxOutputTokens`. Reasoning eats into this before a single
 * character of answer is produced, so a value tuned for the answer alone
 * truncates silently. Long extractions should raise it further.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export type ReasoningEffort = "low" | "medium" | "high";

/** Structured calls do not need deep deliberation; they need valid JSON. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

let provider: Provider | undefined;
let model: LanguageModel | undefined;

export function getProvider(): Provider {
  if (provider === undefined) {
    const env = llmEnv();
    provider = createOpenAICompatible({
      name: PROVIDER_NAME,
      baseURL: env.MAKORA_BASE_URL,
      apiKey: env.MAKORA_API_KEY,
      // supportsStructuredOutputs is intentionally left at its false default.
      // See note 1 above.
    });
  }
  return provider;
}

/** The chat model every model call in the web app goes through. */
export function getModel(): LanguageModel {
  if (model === undefined) {
    model = getProvider().chatModel(llmEnv().MAKORA_MODEL);
  }
  return model;
}

/**
 * The configured model id — safe to record in results and surface in the UI.
 * The audit trail requires the model id on every model-backed activity result.
 */
export function getModelId(): string {
  return llmEnv().MAKORA_MODEL;
}

/**
 * `providerOptions` for a call, carrying the reasoning-effort dial.
 *
 * ```ts
 * const { object } = await generateObject({
 *   model: getModel(),
 *   schema: PlanResult,
 *   maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
 *   providerOptions: reasoningOptions(),
 *   prompt,
 * });
 * ```
 */
export function reasoningOptions(
  effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): Record<string, Record<string, string>> {
  return { [PROVIDER_NAME]: { reasoningEffort: effort } };
}

/** Defaults every call should spread in unless it has a reason not to. */
export function defaultCallOptions(
  effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): {
  maxOutputTokens: number;
  providerOptions: Record<string, Record<string, string>>;
} {
  return {
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    providerOptions: reasoningOptions(effort),
  };
}
