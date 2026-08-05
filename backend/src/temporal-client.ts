import { Client, Connection } from "@temporalio/client";
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from "./env.js";

/**
 * A Temporal client for ACTIVITIES that need to signal their own workflow.
 *
 * An activity cannot return incrementally — it returns once, at the end. The
 * streaming planner needs the opposite: each node on the canvas the moment the
 * model has finished generating it, seconds before the plan as a whole exists.
 * Signalling the parent workflow from inside the activity is the standard
 * Temporal answer to that, and it needs a client of its own: the worker's
 * NativeConnection serves task polling, not the workflow service API.
 *
 * One lazily-created, cached connection per worker process. Creating one per
 * activity would open a gRPC channel per planning call.
 *
 * Never imported from workflow code — it opens sockets.
 */

let cached: Promise<Client> | undefined;

export function temporalClient(): Promise<Client> {
  cached ??= (async () => {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS() });
    return new Client({ connection, namespace: TEMPORAL_NAMESPACE() });
  })();
  return cached;
}

/**
 * Best-effort signal. A failed progressive-render signal must never fail the
 * activity: the plan still arrives in the activity's return value, and the
 * workflow reconciles anything that did not stream. Losing a signal costs the
 * animation, not the graph.
 */
export async function trySignal(
  workflowId: string,
  runId: string | undefined,
  signal: string,
  arg: unknown,
): Promise<boolean> {
  try {
    const client = await temporalClient();
    await client.workflow.getHandle(workflowId, runId).signal(signal, arg);
    return true;
  } catch {
    return false;
  }
}
