import { exists } from "@wf/storage";

/**
 * Cheap, fast blob-store reads that run as LOCAL activities.
 *
 * A local activity executes inside the workflow task rather than going out to
 * the task queue and back — no scheduling round trip, no separate history
 * events beyond a marker. That is the right trade for a stat() call: as a
 * regular activity the round trip costs more than the work, and it puts a
 * ScheduleActivityTask/Started/Completed triple in a history that is also the
 * audit trail.
 *
 * They must stay short and idempotent, because a local activity is retried
 * inside the same workflow task and a slow one stalls the whole workflow.
 */

/** Does the content-addressed store still hold these bytes? */
export async function documentPresent(sha256: string): Promise<boolean> {
  return exists(sha256);
}
