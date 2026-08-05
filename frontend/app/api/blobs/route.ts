import "server-only";

import { put } from "@/lib/blobs";

import { HttpError, json, withErrors } from "../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The whole part is buffered in memory to hash it, so this is a real ceiling,
 * not a policy knob. A 200-page contract is a few megabytes; 100MB is
 * generous for v1 and small enough that a hostile upload cannot exhaust the
 * process.
 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Accepted part names, in order of preference. */
const FILE_FIELDS = ["file", "document"] as const;

/**
 * `POST /api/blobs` — multipart upload, returns a `BlobRef`.
 *
 * Bytes land in the content-addressed store and only the reference travels on
 * from here: into the graph, into signals, into activity inputs. Nothing about
 * a document ever rides inside a Temporal payload.
 */
export async function POST(request: Request): Promise<Response> {
  return withErrors("POST /api/blobs", async () => {
    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("multipart/form-data")) {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Expected multipart/form-data",
      );
    }

    // Reject on the declared length before buffering anything.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, "too_large", `Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, "invalid_multipart", "Could not parse the multipart body");
    }

    let file: File | undefined;
    for (const field of FILE_FIELDS) {
      const entry = form.get(field);
      if (entry instanceof File) {
        file = entry;
        break;
      }
    }
    if (file === undefined) {
      throw new HttpError(400, "missing_file", 'Expected a "file" part');
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, "too_large", `Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }

    /*
     * A zero-byte upload is never a document.
     *
     * It hashes to the well-known empty digest, so it stores and dedupes
     * happily and comes back as a perfectly valid `BlobRef`. The node then
     * shows a filename and a hash, the canvas looks complete, and the failure
     * only appears much later as an extraction that produced nothing. Refuse it
     * where the user can still see which file they picked.
     */
    if (file.size === 0) {
      throw new HttpError(
        400,
        "empty_file",
        "That file is empty (0 bytes) — nothing was uploaded",
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // `put` sanitises the filename and the media type — both come straight from
    // the browser and both end up in a response header later.
    const ref = await put(bytes, { filename: file.name, mime: file.type });

    return json(ref, { status: 201 });
  });
}
