/**
 * The three failures a caller can meaningfully distinguish. Everything else is
 * an infrastructure error and is rethrown untouched.
 */

/**
 * The store does not hold these bytes.
 *
 * The store LOCATION is deliberately not in this message. It reaches the user:
 * activity failure -> `node.error` -> SSE -> the browser, and into the workflow
 * history. The sha256 is the whole of the actionable information; the operator
 * gets the location from the worker's own startup log.
 */
export class BlobNotFoundError extends Error {
  readonly sha256: string;
  constructor(sha256: string) {
    super(`Blob ${sha256} is not in the document store.`);
    this.name = "BlobNotFoundError";
    this.sha256 = sha256;
  }
}

/** The id is not a 64-character lowercase hex sha256, so it never reaches a driver. */
export class InvalidBlobIdError extends Error {
  constructor() {
    super("Blob id must be a 64-character lowercase hex sha256");
    this.name = "InvalidBlobIdError";
  }
}

/**
 * The store cannot be configured from the environment.
 *
 * Thrown at worker boot and on first use in the web app, NEVER swallowed into a
 * fallback. A half-configured S3 store that quietly degrades to local disk puts
 * documents somewhere the other process cannot read them, which is the exact
 * outage this package exists to prevent — and it presents as
 * `BlobNotFoundError` on a document the user just watched upload.
 *
 * Names variables, never values: two of them are credentials.
 */
export class BlobStoreConfigError extends Error {
  readonly vars: readonly string[];
  constructor(message: string, vars: readonly string[]) {
    super(message);
    this.name = "BlobStoreConfigError";
    this.vars = vars;
  }
}
