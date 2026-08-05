import "server-only";

/**
 * The document store, for the web app.
 *
 * THE IMPLEMENTATION IS NOT HERE. It lives in `@wf/storage`, which the worker
 * imports too — one interface, two drivers (filesystem for local dev,
 * S3-compatible for deploy), chosen by environment. This file exists for one
 * reason: `import "server-only"` (CLAUDE.md §Conventions). It turns importing
 * the store from a client component into a build error, and a package under
 * `node_modules` cannot carry that marker on the app's behalf.
 *
 * There were previously two independent implementations of this store — this
 * file and `backend/src/blobs.ts` — both `node:fs` against a shared `BLOB_DIR`.
 * They had already drifted, and on Vercel + Render there is no shared
 * filesystem for them to drift within. Do not reintroduce a second one: add
 * a driver to `@wf/storage` instead.
 */

export {
  BlobNotFoundError,
  BlobStoreConfigError,
  InvalidBlobIdError,
  SHA256_RE,
  exists,
  get,
  isSha256,
  put,
  sanitizeFilename,
  sanitizeMime,
  stat,
} from "@wf/storage";
export type { BlobMeta, BlobStore } from "@wf/storage";
