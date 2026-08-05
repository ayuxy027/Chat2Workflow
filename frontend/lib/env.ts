import "server-only";

import { z } from "zod";

/**
 * Environment access, validated with zod.
 *
 * Two rules govern this module, and both exist because of `next build`:
 *
 * 1. **Nothing is read or validated at import time.** The build evaluates route
 *    modules (and everything they import) during static analysis, with whatever
 *    environment the CI box happens to have — usually none. A top-level
 *    `throw`, or even a bare `process.env.MAKORA_API_KEY!` handed to a constructor,
 *    turns a missing secret into a broken build instead of a clear runtime
 *    error at the one endpoint that actually needs it.
 * 2. **Validation is grouped and lazy.** Uploading a PDF must not fail because
 *    `MAKORA_API_KEY` is unset, so each subsystem validates only its own vars, on
 *    first use, and memoises the result.
 *
 * Errors name the variables that are missing. They never include a value —
 * these vars hold an API key.
 */

/** Thrown on first use of a subsystem whose environment is missing or invalid. */
export class EnvError extends Error {
  readonly group: string;
  readonly vars: readonly string[];

  constructor(group: string, vars: readonly string[], detail: string) {
    super(
      `Missing or invalid environment for ${group}: ${detail}. ` +
        `Set ${vars.join(", ")} — see .env.example.`,
    );
    this.name = "EnvError";
    this.group = group;
    this.vars = vars;
  }
}

/**
 * Reads the named keys out of `process.env`, normalising blank strings to
 * `undefined` so that zod `.default()` applies to `FOO=` the same way it
 * applies to an unset `FOO`.
 */
function rawEnv<K extends string>(keys: readonly K[]): Record<K, string | undefined> {
  const out = {} as Record<K, string | undefined>;
  for (const key of keys) {
    const value = process.env[key];
    out[key] = value === undefined || value.trim() === "" ? undefined : value;
  }
  return out;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const name = issue.path.join(".") || "(root)";
      return `${name} (${issue.message})`;
    })
    .join(", ");
}

/**
 * Builds a memoised accessor. The schema is only run on first call, and a
 * failure is re-thrown on every subsequent call rather than being retried —
 * the environment does not change under a running process.
 */
function lazyGroup<S extends z.ZodType>(
  group: string,
  keys: readonly string[],
  schema: S,
): () => z.infer<S> {
  let cached: { ok: true; value: z.infer<S> } | { ok: false; error: EnvError } | undefined;

  return () => {
    if (cached === undefined) {
      const parsed = schema.safeParse(rawEnv(keys));
      cached = parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: new EnvError(group, keys, describeIssues(parsed.error)) };
    }
    if (!cached.ok) throw cached.error;
    return cached.value;
  };
}

/* -------------------------------------------------------------------------- */
/* LLM                                                                        */
/* -------------------------------------------------------------------------- */

const LLM_KEYS = ["MAKORA_BASE_URL", "MAKORA_API_KEY", "MAKORA_MODEL"] as const;

const LlmEnv = z.object({
  MAKORA_BASE_URL: z.string().url(),
  MAKORA_API_KEY: z.string().min(1),
  MAKORA_MODEL: z.string().min(1),
});
export type LlmEnv = z.infer<typeof LlmEnv>;

/**
 * The LLM lives behind an OpenAI-compatible gateway at `MAKORA_BASE_URL`.
 * No defaults: there is no sane guess for an endpoint, a key, or a model id.
 */
export const llmEnv = lazyGroup("the LLM provider", LLM_KEYS, LlmEnv);

/* -------------------------------------------------------------------------- */
/* Temporal                                                                   */
/* -------------------------------------------------------------------------- */

const TEMPORAL_KEYS = [
  "TEMPORAL_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_TASK_QUEUE",
] as const;

const TemporalEnv = z.object({
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default("workflows"),
});
export type TemporalEnv = z.infer<typeof TemporalEnv>;

/**
 * Defaulted to the values in `.env.example` / `docker-compose.yml`. A wrong
 * address or namespace fails loudly at connect time; a wrong task queue means
 * no worker polls the session — both are visible immediately, unlike a
 * defaulted blob directory (see below).
 */
export const temporalEnv = lazyGroup("Temporal", TEMPORAL_KEYS, TemporalEnv);

/* -------------------------------------------------------------------------- */
/* Blob store                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * Not here. The document store owns its own environment, in `@wf/storage`,
 * because the worker reads the same variables and a second copy of the rules is
 * exactly how the two stores drifted apart in the first place. It validates
 * lazily for the same reason this module does, and throws
 * `BlobStoreConfigError` — which `app/api/_http.ts` maps to a 500 naming the
 * missing variables.
 */
