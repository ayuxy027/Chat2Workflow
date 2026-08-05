import path from "node:path";

import { BlobStoreConfigError } from "./errors";

/**
 * Driver selection.
 *
 * Nothing here runs at import time. `next build` evaluates every route module
 * and everything it imports with whatever environment the build box happens to
 * have — usually none — so a top-level read turns a missing variable into a
 * broken build instead of a clear error at the one endpoint that needs it.
 */

export type BlobStoreConfig =
  | { driver: "filesystem"; dir: string }
  | { driver: "vercel-blob"; token: string }
  | {
      driver: "s3";
      endpoint: string;
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

/** Every variable that selects or configures the S3 driver. */
const S3_REQUIRED = [
  "BLOB_S3_ENDPOINT",
  "BLOB_S3_BUCKET",
  "BLOB_S3_REGION",
  "BLOB_S3_ACCESS_KEY_ID",
  "BLOB_S3_SECRET_ACCESS_KEY",
] as const;

const S3_OPTIONAL = ["BLOB_S3_FORCE_PATH_STYLE"] as const;

/**
 * The prefix every Vercel Blob READ-WRITE token carries. Lives here rather than
 * in the driver so selection never has to load `@vercel/blob` to decide.
 */
export const BLOB_TOKEN_PREFIX = "vercel_blob_rw_";

function isBlobReadWriteToken(token: string): boolean {
  return token.startsWith(BLOB_TOKEN_PREFIX);
}

function read(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** `1`, `true`, `yes`, `on` — anything else is false. */
function readBool(key: string): boolean {
  const raw = read(key)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const BLOB_DIR_HINT =
  "Set BLOB_DIR to an ABSOLUTE path, e.g. BLOB_DIR=/srv/wf/.data/blobs — or configure a " +
  "remote driver with BLOB_READ_WRITE_TOKEN (Vercel Blob) or " +
  `${S3_REQUIRED.join(", ")} (S3).`;

/**
 * Reads the store configuration out of the environment.
 *
 * SELECTION ORDER — first match wins:
 *
 *   1. `BLOB_READ_WRITE_TOKEN`  -> Vercel Blob
 *   2. any `BLOB_S3_*`          -> S3-compatible
 *   3. `BLOB_DIR`               -> local filesystem
 *
 * A partially configured remote driver is a HARD ERROR naming exactly what is
 * missing or malformed, never a quiet fall back to local disk. On Vercel +
 * Render the two processes have no shared filesystem — they do not even have
 * the same disk — so a fallback means the web app writes a document to an
 * ephemeral Vercel filesystem and the worker looks for it on a Render one. The
 * only symptom is a `BlobNotFoundError` minutes later on a file the user
 * watched upload, which is precisely the outage this package exists to prevent.
 *
 * THE CORRESPONDING DEPLOY HAZARD, which no single process can detect: both
 * services must select the SAME driver. Connecting the blob store to the Vercel
 * project injects `BLOB_READ_WRITE_TOKEN` there automatically, and the worker
 * on Render gets only what is set by hand — so set it by hand on Render too,
 * and check the worker's `[worker] blob driver:` line after every deploy.
 */
export function readBlobStoreConfig(): BlobStoreConfig {
  /*
   * Vercel Blob first: one variable, no account to create, and reachable from
   * anywhere because it is a bearer-token HTTP API rather than a
   * Vercel-runtime binding.
   */
  const token = read("BLOB_READ_WRITE_TOKEN");
  if (token !== undefined) {
    if (!isBlobReadWriteToken(token)) {
      throw new BlobStoreConfigError(
        `BLOB_READ_WRITE_TOKEN does not look like a Vercel Blob read-write token: it must ` +
          `start with "${BLOB_TOKEN_PREFIX}". A Vercel ACCESS token, a project token, or a ` +
          `client upload token will not work here, and the difference only shows up as an ` +
          `opaque 403 on the first upload. Copy it from the store's ".env.local" tab, or ` +
          `unset it to select another driver.`,
        ["BLOB_READ_WRITE_TOKEN"],
      );
    }
    return { driver: "vercel-blob", token };
  }

  const present = [...S3_REQUIRED, ...S3_OPTIONAL].filter((k) => read(k) !== undefined);

  if (present.length > 0) {
    const missing = S3_REQUIRED.filter((k) => read(k) === undefined);
    if (missing.length > 0) {
      throw new BlobStoreConfigError(
        `The document store is half-configured for S3: ${present.join(", ")} ` +
          `${present.length === 1 ? "is" : "are"} set but ${missing.join(", ")} ` +
          `${missing.length === 1 ? "is" : "are"} missing. Refusing to fall back to the ` +
          `local filesystem — the web app and the worker run on different hosts in ` +
          `production, so a local store means every document the browser uploads is ` +
          `invisible to the worker. Set the missing variable(s), or unset all BLOB_S3_* ` +
          `variables to use BLOB_DIR.`,
        missing,
      );
    }
    return {
      driver: "s3",
      endpoint: read("BLOB_S3_ENDPOINT")!,
      bucket: read("BLOB_S3_BUCKET")!,
      region: read("BLOB_S3_REGION")!,
      accessKeyId: read("BLOB_S3_ACCESS_KEY_ID")!,
      secretAccessKey: read("BLOB_S3_SECRET_ACCESS_KEY")!,
      // R2 and MinIO address buckets as a path segment; AWS S3 and Supabase
      // use the virtual-hosted style. Getting this wrong surfaces as a 404 or
      // a DNS failure on the very first request, not as data loss.
      forcePathStyle: readBool("BLOB_S3_FORCE_PATH_STYLE"),
    };
  }

  /*
   * Filesystem. `BLOB_DIR` is required and required to be ABSOLUTE.
   *
   * A relative default was the original design and it hid a real outage: the
   * web app and the worker run from different working directories, so
   * `./.data/blobs` silently resolved to two different stores. Every upload
   * landed in one and every activity looked in the other, and the only symptom
   * was a BlobNotFoundError on a document the user had just watched upload.
   * Refusing to guess is the fix.
   */
  const dir = read("BLOB_DIR");
  if (dir === undefined) {
    throw new BlobStoreConfigError(
      `The document store is not configured: BLOB_DIR is not set. ${BLOB_DIR_HINT}`,
      ["BLOB_DIR"],
    );
  }
  if (!path.isAbsolute(dir)) {
    throw new BlobStoreConfigError(
      `BLOB_DIR is set to a relative path (${JSON.stringify(dir)}), which resolves ` +
        `differently in the web app and in the worker and silently splits the store in ` +
        `two. ${BLOB_DIR_HINT}`,
      ["BLOB_DIR"],
    );
  }
  return { driver: "filesystem", dir: path.resolve(dir) };
}

/** One line for the worker's startup log. Never includes a credential. */
export function describeConfig(config: BlobStoreConfig): string {
  switch (config.driver) {
    case "filesystem":
      return config.dir;
    case "vercel-blob":
      return "vercel-blob (store selected by BLOB_READ_WRITE_TOKEN)";
    case "s3":
      return `s3://${config.bucket} @ ${config.endpoint}${
        config.forcePathStyle ? " (path-style)" : ""
      }`;
  }
}
