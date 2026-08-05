"use client";

/**
 * The tool registry, fetched once per page from `GET /api/tools`.
 *
 * PRD §5.3: "`params` drives the node's form UI from the same definition — no
 * separate frontend registration." This hook is what makes that literally true.
 * Nothing in `frontend` names a tool, a parameter, or an option; a tool added to
 * `@wf/shared` gets an editable form on the canvas with no frontend change at
 * all.
 *
 * Module-scoped promise rather than per-component state: every tool node on the
 * canvas needs the same list, and one fetch is enough. It is not revalidated —
 * the registry is a build artifact of the deployed code, not live data.
 */

import { useEffect, useState } from "react";
import { ToolManifest, type ParamSpec } from "@wf/shared";

export interface ToolRegistry {
  tools: ToolManifest[];
  byId: Map<string, ToolManifest>;
  /** Undefined while loading; a message once it has failed. */
  error?: string;
  loading: boolean;
}

const EMPTY: ToolRegistry = { tools: [], byId: new Map(), loading: true };

let cached: Promise<{ tools: ToolManifest[]; error?: string }> | undefined;

async function load(): Promise<{ tools: ToolManifest[]; error?: string }> {
  try {
    const response = await fetch("/api/tools", { cache: "no-store" });
    if (!response.ok) return { tools: [], error: `registry unavailable (${response.status})` };

    const body = (await response.json()) as { tools?: unknown };
    // Validated, not cast. A manifest whose `params` do not match `ParamSpec`
    // would otherwise render as a form with missing or uncontrolled fields —
    // and a tool parameter that silently fails to reach the workflow is the
    // same class of bug as an input node whose text never arrives.
    const parsed = ToolManifest.array().safeParse(body.tools);
    if (!parsed.success) return { tools: [], error: "registry did not match ToolManifest" };

    return { tools: parsed.data };
  } catch {
    return { tools: [], error: "could not reach the tool registry" };
  }
}

export function useToolRegistry(): ToolRegistry {
  const [state, setState] = useState<ToolRegistry>(EMPTY);

  useEffect(() => {
    let live = true;
    cached ??= load();
    void cached.then((result) => {
      if (!live) return;
      setState({
        tools: result.tools,
        byId: new Map(result.tools.map((t) => [t.id, t])),
        error: result.error,
        loading: false,
      });
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}

/**
 * The value a control should show: what the node holds, else the spec's
 * default, else empty.
 *
 * Reading the default here rather than writing it into `params` on render
 * matters — writing would fire a signal for every tool node the planner
 * produces, and would make "the user chose the default" indistinguishable from
 * "nobody has touched this" in the audit trail.
 */
export function paramValue(spec: ParamSpec, params: Record<string, unknown>): unknown {
  const held = params[spec.name];
  if (held !== undefined && held !== null && held !== "") return held;
  return "default" in spec ? spec.default : undefined;
}
