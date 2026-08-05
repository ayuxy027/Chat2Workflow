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
  "Set BLOB_DIR to an ABSOLUTE path, e.g. BLOB_DIR=/srv/wf/.data/blobs — or configure the " +
  `S3 driver with ${S3_REQUIRED.join(", ")}.`;

/**
 * Reads the store configuration out of the environment.
 *
 * Any `BLOB_S3_*` variable selects the S3 driver, and then ALL of the required
 * ones must be present. A partially configured S3 store is a hard error naming
 * exactly what is missing, never a quiet fall back to local disk: on Vercel +
 * Render the two processes have no shared filesystem, so a silent fallback
 * means the web app writes a document the worker cannot read, and the only
 * symptom is a `BlobNotFoundError` minutes later on a file the user watched
 * upload.
 */
export function readBlobStoreConfig(): BlobStoreConfig {
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
  return config.driver === "filesystem"
    ? config.dir
    : `s3://${config.bucket} @ ${config.endpoint}${config.forcePathStyle ? " (path-style)" : ""}`;
}
