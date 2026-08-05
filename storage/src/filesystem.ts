import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BlobRef } from "@wf/shared";

import { BlobNotFoundError, InvalidBlobIdError } from "./errors";
import { buildRef, keysFor, parseMeta, toBuffer } from "./sanitize";
import type { BlobMeta, BlobStore } from "./types";

/**
 * Filesystem driver — local development, or a single host with a real volume.
 *
 *     <BLOB_DIR>/<sha256>         raw bytes
 *     <BLOB_DIR>/<sha256>.json    the BlobRef, JSON
 *
 * Every `node:fs` call carries `turbopackIgnore: true`. The store lives
 * wherever `BLOB_DIR` points — outside the project, ideally on a volume the
 * worker also mounts — so the bundler's static file tracing has nothing useful
 * to do here. Left alone it concludes it must trace and ship the entire
 * project, `public/` included, into the server bundle.
 */

/**
 * Read flags for everything in the store.
 *
 * `O_NOFOLLOW` applies to the FINAL path component only, so a `BLOB_DIR` that
 * is itself a symlink still works — what it refuses is a *blob* that is a
 * symlink. Without it, dropping `<sha256> -> /etc/passwd` into the store makes
 * `GET /api/blobs/<sha256>` serve that file with a 200 (verified). Nothing this
 * app does can create such a link — writes always go to a fresh temp file and
 * rename over the target — so this is not remotely reachable; it is here
 * because the promise content addressing makes is that a hash names *those*
 * bytes, and a symlink is precisely a hash that names something else.
 *
 * Checked by the open itself rather than by an `lstat` first, so there is no
 * window between the check and the read.
 */
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

async function present(target: string): Promise<boolean> {
  try {
    await access(/*turbopackIgnore: true*/ target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Write-then-rename so a crashed write never leaves a half-written blob. */
async function atomicWrite(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.${randomUUID()}.part`;
  await writeFile(/*turbopackIgnore: true*/ tmp, data, { mode: 0o600 });
  try {
    await rename(/*turbopackIgnore: true*/ tmp, target);
  } catch (err) {
    await unlink(/*turbopackIgnore: true*/ tmp).catch(() => undefined);
    throw err;
  }
}

export function createFilesystemStore(dir: string): BlobStore {
  const root = path.resolve(dir);

  /**
   * Resolves the two paths for a blob. `keysFor` has already rejected anything
   * that is not lowercase hex — which makes `..`, `/`, and NUL unrepresentable
   * — and the resolved path is then re-checked to sit directly inside the
   * store. Belt and braces on purpose: this store holds privileged client
   * documents.
   */
  const pathsFor = (sha256: string): { bytes: string; meta: string } => {
    const keys = keysFor(sha256);
    const bytes = path.resolve(root, keys.bytes);
    if (path.dirname(bytes) !== root) throw new InvalidBlobIdError();
    return { bytes, meta: `${bytes}.json` };
  };

  const readMeta = async (sha256: string): Promise<BlobRef | undefined> => {
    const { meta } = pathsFor(sha256);
    try {
      const raw = await readFile(/*turbopackIgnore: true*/ meta, {
        encoding: "utf8",
        flag: READ_FLAGS,
      });
      return parseMeta(raw);
    } catch {
      return undefined;
    }
  };

  return {
    driver: "filesystem",
    location: root,

    async put(bytes: Uint8Array, meta: BlobMeta): Promise<BlobRef> {
      await mkdir(/*turbopackIgnore: true*/ root, { recursive: true });

      const buffer = toBuffer(bytes);
      const ref = buildRef(buffer, meta);
      const paths = pathsFor(ref.sha256);

      if (!(await present(paths.bytes))) {
        await atomicWrite(paths.bytes, buffer);
      }

      // Metadata is written ONCE — the first store's filename is the one
      // recorded. That is the correct reading of content addressing (same
      // bytes, same object) and it keeps `put`, `stat`, and the download route
      // from ever disagreeing about what a hash names. The worker's old copy
      // rewrote the sidecar on every write, which made a stored object mutable.
      const existing = await readMeta(ref.sha256);
      if (existing !== undefined) return existing;

      await atomicWrite(paths.meta, Buffer.from(JSON.stringify(ref), "utf8"));
      return ref;
    },

    async get(sha256: string): Promise<Buffer> {
      const paths = pathsFor(sha256);
      try {
        return await readFile(/*turbopackIgnore: true*/ paths.bytes, { flag: READ_FLAGS });
      } catch {
        throw new BlobNotFoundError(sha256);
      }
    },

    async stat(sha256: string): Promise<BlobRef> {
      const ref = await readMeta(sha256);
      if (ref === undefined) throw new BlobNotFoundError(sha256);
      return ref;
    },

    async exists(sha256: string): Promise<boolean> {
      return present(pathsFor(sha256).bytes);
    },
  };
}
