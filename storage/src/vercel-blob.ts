import {
  BlobNotFoundError as VercelBlobNotFoundError,
  get as vercelGet,
  head as vercelHead,
  put as vercelPut,
} from "@vercel/blob";

import type { BlobRef } from "@wf/shared";

import { BlobNotFoundError } from "./errors";
import { buildRef, keysFor, parseMeta, toBuffer } from "./sanitize";
import type { BlobMeta, BlobStore } from "./types";
import type { BlobStoreConfig } from "./config";

/**
 * ACCESS MODE. `access: "private"`, and it must stay that way.
 *
 * Public blobs are readable by anyone holding the URL, with no auth. Content
 * addressing makes those URLs unguessable, which is not the same as protected,
 * and these are client documents.
 *
 * An earlier version of this driver used "public" on the theory that private
 * stores require `VERCEL_OIDC_TOKEN`, which only the Vercel runtime mints, and
 * so could never be read by the worker on Render. That was wrong: the SDK
 * prefers an explicitly-passed `token` over OIDC, so a read-write token works
 * from any host. The error that prompted the change was a store/access
 * mismatch, not an auth failure.
 */
/**
 * Vercel Blob driver — the zero-signup production path.
 *
 * It is an ordinary HTTPS API authenticated with a bearer token, NOT a
 * Vercel-runtime binding, so the worker on Render reaches the same store as the
 * app on Vercel with the same single variable. That is the entire reason this
 * driver exists alongside the S3 one: it needs no third-party account.
 *
 * Key layout matches the other two drivers exactly, so all three are one store
 * described three ways:
 *
 *     <sha256>        the raw bytes
 *     <sha256>.json   the BlobRef, JSON
 *
 * `addRandomSuffix: false` IS THE LOAD-BEARING OPTION HERE.
 *
 * Vercel Blob's uploader has historically defaulted to appending a random
 * suffix to the pathname, and the client-side helpers still do. Under content
 * addressing that is not a cosmetic difference, it is total failure: `put` of
 * the same bytes would land at `<sha256>-Xk29fA` and `get(sha256)` would look
 * at `<sha256>` and find nothing, forever. Every document node would fail with
 * BlobNotFoundError on a file that had demonstrably just uploaded. It is passed
 * explicitly rather than relied on as a default precisely because the default
 * has moved between versions.
 *
 * `allowOverwrite` is left at its default of `false`, which turns the SDK into
 * a second enforcement point for immutability: a stored object cannot be
 * replaced even by a caller who tries.
 */

type VercelConfigOf<C> = C extends { driver: "vercel-blob" } ? C : never;
export type VercelBlobStoreConfig = VercelConfigOf<BlobStoreConfig>;

/**
 * Was this a genuine "no such blob", as opposed to an expired token, a
 * suspended store, or a network fault?
 *
 * Only a real absence may become `BlobNotFoundError`. Mapping an auth failure
 * onto it would present a bad token as a missing document, and this store is
 * the audit trail: "the bytes are gone" and "I am not allowed to look" must
 * never read the same. `BlobError` does not set `name`, so `instanceof` is the
 * check, with the message as a fallback for a copy of the SDK loaded twice.
 */
function isNotFound(err: unknown): boolean {
  return (
    err instanceof VercelBlobNotFoundError ||
    (err instanceof Error && err.message.includes("The requested blob does not exist"))
  );
}

export function createVercelBlobStore(config: VercelBlobStoreConfig): BlobStore {
  const token = config.token;

  const head = async (key: string): Promise<boolean> => {
    try {
      await vercelHead(key, { token });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  };

  const write = async (key: string, body: Buffer, contentType: string): Promise<void> => {
    try {
      await vercelPut(key, body, {
        token,
        access: "private",
        // See the module comment. Never remove, never set to true.
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType,
      });
    } catch (err) {
      /*
       * Two processes storing identical bytes at the same instant is normal
       * here — the same document uploaded twice, or a tool re-run producing a
       * deterministic artifact — and `allowOverwrite: false` makes the loser
       * throw. If the object is there now, content addressing guarantees it is
       * byte-for-byte what we were about to write, so this is success, not a
       * conflict.
       */
      if (await head(key)) return;
      throw err;
    }
  };

  const readBody = async (
    key: string,
    opts: { useCache: boolean },
  ): Promise<Buffer | undefined> => {
    let res;
    try {
      res = await vercelGet(key, { token, access: "private", useCache: opts.useCache });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    if (res === null || res.statusCode !== 200) return undefined;
    const buffer = await new Response(res.stream).arrayBuffer();
    return Buffer.from(buffer);
  };

  return {
    driver: "vercel-blob",
    // The token embeds the store id, and the token is a credential — so the
    // location says which store only as far as it can without leaking one.
    location: "vercel-blob (store selected by BLOB_READ_WRITE_TOKEN)",

    async put(bytes: Uint8Array, meta: BlobMeta): Promise<BlobRef> {
      const buffer = toBuffer(bytes);
      const ref = buildRef(buffer, meta);
      const keys = keysFor(ref.sha256);

      if (!(await head(keys.bytes))) {
        await write(keys.bytes, buffer, ref.mime);
      }

      // Metadata is written once; the first store's filename is the one
      // recorded. Same rule as the other two drivers, for the same reason.
      const existingRaw = await readBody(keys.meta, { useCache: false });
      const existing = existingRaw === undefined ? undefined : parseMeta(existingRaw.toString("utf8"));
      if (existing !== undefined) return existing;

      await write(keys.meta, Buffer.from(JSON.stringify(ref), "utf8"), "application/json");
      return ref;
    },

    async get(sha256: string): Promise<Buffer> {
      const keys = keysFor(sha256);
      // The CDN cache is not just safe for the bytes, it is exactly right: the
      // object at `<sha256>` can never change, because a different byte string
      // is a different key.
      const body = await readBody(keys.bytes, { useCache: true });
      if (body === undefined) throw new BlobNotFoundError(sha256);
      return body;
    },

    async stat(sha256: string): Promise<BlobRef> {
      const keys = keysFor(sha256);
      /*
       * `useCache: false` is requested on the sidecar alone, because it is the
       * existence gate for `stat` and a 404 cached at the edge for a blob
       * uploaded a moment later would make a freshly stored document look
       * missing. It is a few hundred bytes, so the origin read costs nothing.
       *
       * NOTE: the SDK only honours this for `access: "private"` — it appends
       * `?cache=0` in that branch and ignores the flag otherwise. While this
       * driver puts with `access: "public"` (see the top of the file) the
       * request is served from the CDN regardless, so the protection above is
       * requested but not in force.
       */
      const raw = await readBody(keys.meta, { useCache: false });
      const ref = raw === undefined ? undefined : parseMeta(raw.toString("utf8"));
      if (ref === undefined) throw new BlobNotFoundError(sha256);
      return ref;
    },

    async exists(sha256: string): Promise<boolean> {
      return head(keysFor(sha256).bytes);
    },
  };
}
