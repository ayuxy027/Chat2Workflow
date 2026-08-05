/**
 * Environment access. Every read goes through here so a missing variable fails
 * with an actionable message at the point of use rather than as `undefined`
 * three frames deeper.
 *
 * Nothing in this module is imported by workflow code — the workflow sandbox
 * has no `process`.
 */

export class MissingEnvError extends Error {
  readonly name = "MissingEnvError";
  constructor(key: string, hint: string) {
    super(`Environment variable ${key} is not set. ${hint}`);
  }
}

export function requireEnv(key: string, hint: string): string {
  const v = process.env[key];
  if (v === undefined || v.trim() === "") throw new MissingEnvError(key, hint);
  return v;
}

export function optionalEnv(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? fallback : v;
}

export function optionalIntEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const TEMPORAL_ADDRESS = (): string => optionalEnv("TEMPORAL_ADDRESS", "localhost:7233");
export const TEMPORAL_NAMESPACE = (): string => optionalEnv("TEMPORAL_NAMESPACE", "default");
export const TEMPORAL_TASK_QUEUE = (): string => optionalEnv("TEMPORAL_TASK_QUEUE", "workflows");
