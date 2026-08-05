import "server-only";

import { get, isSha256, stat } from "@/lib/blobs";

import { HttpError, withErrors } from "../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ASCII fallback for `Content-Disposition: filename=`. Anything outside
 * printable ASCII — plus the quote and backslash that would break out of the
 * quoted-string — becomes an underscore. The real name travels in `filename*`.
 */
function asciiFilename(name: string): string {
  const mapped = Array.from(name)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const printable = code >= 0x20 && code <= 0x7e;
      const structural = code === 0x22 || code === 0x5c;
      return printable && !structural ? ch : "_";
    })
    .join("");
  return mapped === "" ? "download.bin" : mapped;
}

/**
 * Media types safe to render in place, and only these.
 *
 * PRD §3.6 requires the source document to be one click from any claim made
 * about it, and a citation link carries a `#page=N` fragment that only means
 * anything to a viewer — served as an attachment the browser downloads the file
 * and the fragment is lost, which is not "one click from the source".
 *
 * The allowlist is exhaustive rather than a deny-list because this store holds
 * files uploaded from outside the firm. `text/html` and `image/svg+xml` render
 * as documents with script, so an inline response would be stored XSS on this
 * origin; anything not named here keeps `attachment`, and `nosniff` still
 * prevents the browser from second-guessing the declared type either way.
 * Neither type on the list can execute script against this origin, which is why
 * the allowlist — not a CSP — is the control here: a restrictive
 * `object-src`/`sandbox` policy is exactly what stops the browser's own PDF
 * viewer from rendering, and would silently turn the citation link back into a
 * download.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "text/plain",
]);

/**
 * `GET /api/blobs/:sha256` — the bytes behind a `BlobRef`.
 *
 * The path parameter is a security boundary: it is checked against
 * `/^[a-f0-9]{64}$/` before anything touches the filesystem. `lib/blobs`
 * re-checks it, because a store of privileged client documents deserves two
 * locks on the same door.
 *
 * Disposition is `attachment` unless the type is on `INLINE_TYPES`, and
 * `?download=1` forces `attachment` regardless. Download links on the canvas
 * also carry the `download` attribute, which wins over `inline` for a
 * same-origin response, so making PDFs viewable does not turn artifact
 * downloads into navigations.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ sha256: string }> },
): Promise<Response> {
  return withErrors("GET /api/blobs/:sha256", async () => {
    const { sha256 } = await ctx.params;
    if (!isSha256(sha256)) {
      throw new HttpError(
        400,
        "bad_blob_id",
        "Blob id must be a 64-character lowercase hex sha256",
      );
    }

    const ref = await stat(sha256);

    // Content addressing makes the hash a perfect validator: the bytes behind
    // it can never change, so a match is always safe to serve from cache.
    const etag = `"${ref.sha256}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const bytes = await get(sha256);

    const forced = new URL(request.url).searchParams.get("download") !== null;
    const disposition =
      !forced && INLINE_TYPES.has(ref.mime) ? "inline" : "attachment";

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": ref.mime,
        "content-length": String(bytes.byteLength),
        "content-disposition":
          `${disposition}; filename="${asciiFilename(ref.filename)}"; ` +
          `filename*=UTF-8''${encodeURIComponent(ref.filename)}`,
        "x-content-type-options": "nosniff",
        etag,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });
}
