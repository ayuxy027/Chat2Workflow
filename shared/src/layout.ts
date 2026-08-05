import type { GraphEdge, Position } from "./graph";

export const COL_PITCH = 336; // 24 * 14
export const ROW_PITCH = 192; // 24 * 8
export const ORIGIN: Position = { x: 96, y: 96 }; // 24 * 4

/** The canvas dot grid and drag snap. Layout must be a multiple of this or
 *  planner-placed nodes sit fractionally off the grid that dragged ones snap
 *  to, and the misalignment is visible the first time a user moves anything. */
export const GRID = 24;

/**
 * Deterministic left-to-right layered layout.
 *
 * This runs INSIDE the Temporal workflow, so it must be pure: no Date, no
 * Math.random, no iteration over unordered collections. Same inputs always
 * produce the same coordinates, which is what makes workflow replay safe.
 *
 * Nodes are placed in columns by topological depth (longest path from a root)
 * and centred vertically within their column. User drags emit `node.updated`
 * and take precedence — layout only ever assigns initial positions.
 */
export function layout(
  nodeIds: string[],
  edges: Pick<GraphEdge, "source" | "target">[],
): Record<string, Position> {
  const incoming = new Map<string, string[]>();
  for (const id of nodeIds) incoming.set(id, []);
  for (const e of edges) {
    if (incoming.has(e.target) && incoming.has(e.source)) {
      incoming.get(e.target)!.push(e.source);
    }
  }

  // Longest-path depth. Iterating to a fixed point tolerates cycles by
  // capping at nodeIds.length passes rather than hanging.
  const depth = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (let pass = 0; pass < nodeIds.length; pass++) {
    let changed = false;
    for (const id of nodeIds) {
      const preds = incoming.get(id)!;
      if (preds.length === 0) continue;
      const d = Math.max(...preds.map((p) => depth.get(p)! + 1));
      if (d > depth.get(id)!) {
        depth.set(id, d);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, string[]>();
  for (const id of nodeIds) {
    const d = depth.get(id)!;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(id);
  }

  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const out: Record<string, Position> = {};

  for (const [col, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const offset = ((tallest - ids.length) * ROW_PITCH) / 2;
    ids.forEach((id, row) => {
      out[id] = {
        x: ORIGIN.x + col * COL_PITCH,
        y: ORIGIN.y + offset + row * ROW_PITCH,
      };
    });
  }

  return out;
}
