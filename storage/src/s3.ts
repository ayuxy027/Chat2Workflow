import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { BlobRef } from "@wf/shared";

import { BlobNotFoundError } from "./errors";
import { buildRef, keysFor, parseMeta, toBuffer } from "./sanitize";
import type { BlobMeta, BlobStore } from "./types";
import type { BlobStoreConfig } from "./config";

/**
 * S3-compatible driver — production, and anywhere the web app and the worker
 * are not on the same machine.
 *
 * Object layout mirrors the filesystem driver exactly, so the two are one store
 * described two ways and a migration is `aws s3 sync`:
 *
 *     <bucket>/<sha256>         raw bytes
 *     <bucket>/<sha256>.json    the BlobRef, JSON
 *
 * ONE driver covers AWS S3, Cloudflare R2, Supabase Storage, MinIO and
 * Backblaze B2, because the only thing that differs between them is the
 * endpoint and whether the bucket is addressed as a path segment
 * (`BLOB_S3_FORCE_PATH_STYLE` — R2 and MinIO need it). Nothing in here uses an
 * API outside the common subset: PutObject, GetObject, HeadObject. There is no
 * DeleteObject and no CopyObject, deliberately — a stored object is immutable
 * (see `BlobStore`).
 */

type S3ConfigOf<C> = C extends { driver: "s3" } ? C : never;
export type S3StoreConfig = S3ConfigOf<BlobStoreConfig>;

/**
 * Was this a 404, as opposed to auth, network, or a bad bucket?
 *
 * Only a genuine "no such object" may become `BlobNotFoundError`. Mapping a 403
 * onto it would present an expired credential as a missing document, and this
 * store is the audit trail: "the bytes are gone" and "I am not allowed to look"
 * must never read the same. Providers differ on the error NAME (`NoSuchKey` on
 * GetObject, `NotFound` on HeadObject, and R2 has used both), so the HTTP
 * status is the reliable signal.
 */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.$metadata?.httpStatusCode === 404 || e?.name === "NoSuchKey" || e?.name === "NotFound"
  );
}

export function createS3Store(config: S3StoreConfig): BlobStore {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    /*
     * Recent AWS SDK releases compute a CRC32 checksum on every upload and send
     * it as an `x-amz-trailer`, which several S3-compatible services reject
     * outright (R2 and older MinIO among them) — the symptom is a 400 on the
     * first PutObject and nothing else. `WHEN_REQUIRED` keeps the SDK's default
     * behaviour for the operations that mandate a checksum and leaves plain
     * uploads alone. Integrity is not weakened: every object in this store is
     * named by the sha256 of its own bytes and is verified by that name.
     */
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const bucket = config.bucket;

  const getText = async (key: string): Promise<string | undefined> => {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await res.Body?.transformToString("utf8");
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  };

  const head = async (key: string): Promise<boolean> => {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  };

  return {
    driver: "s3",
    location: `s3://${bucket} @ ${config.endpoint}`,

    async put(bytes: Uint8Array, meta: BlobMeta): Promise<BlobRef> {
      const buffer = toBuffer(bytes);
      const ref = buildRef(buffer, meta);
      const keys = keysFor(ref.sha256);

      // Never overwrite bytes that are already there. PutObject is atomic — an
      // object appears whole or not at all — so there is no torn-write case to
      // guard, only the immutability rule.
      if (!(await head(keys.bytes))) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: keys.bytes,
            Body: buffer,
            ContentLength: buffer.byteLength,
            ContentType: ref.mime,
          }),
        );
      }

      // Metadata is written once; the first store's filename is the one
      // recorded. Same rule as the filesystem driver, for the same reason.
      const existingRaw = await getText(keys.meta);
      const existing = existingRaw === undefined ? undefined : parseMeta(existingRaw);
      if (existing !== undefined) return existing;

      const body = Buffer.from(JSON.stringify(ref), "utf8");
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keys.meta,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: "application/json",
        }),
      );
      return ref;
    },

    async get(sha256: string): Promise<Buffer> {
      const keys = keysFor(sha256);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keys.bytes }));
        const body = await res.Body?.transformToByteArray();
        if (body === undefined) throw new BlobNotFoundError(sha256);
        return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      } catch (err) {
        if (err instanceof BlobNotFoundError || isNotFound(err)) {
          throw new BlobNotFoundError(sha256);
        }
        throw err;
      }
    },

    async stat(sha256: string): Promise<BlobRef> {
      const keys = keysFor(sha256);
      const raw = await getText(keys.meta);
      const ref = raw === undefined ? undefined : parseMeta(raw);
      if (ref === undefined) throw new BlobNotFoundError(sha256);
      return ref;
    },

    async exists(sha256: string): Promise<boolean> {
      return head(keysFor(sha256).bytes);
    },
  };
}
