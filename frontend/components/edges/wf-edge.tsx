"use client";

/**
 * The only edge type. 1px `line`, bezier, arrowhead at the target (PRD §3.4).
 *
 * The "data is flowing" treatment is not here: it is the `.wf-edge-active`
 * class in globals.css, applied by the adapter when the edge's source node is
 * running. Keeping it in CSS means the dash animation is a property of the
 * document, so `prefers-reduced-motion` can switch it off in one place.
 */

import { memo } from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

export const WfEdge = memo(function WfEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return <BaseEdge path={path} markerEnd={markerEnd} style={style} />;
});
