"use client";

/**
 * A tool's form, generated entirely from its `ParamSpec[]`.
 *
 * This file knows about four control types and nothing else — no tool id, no
 * parameter name, no option list appears anywhere in `frontend`. That is the
 * whole point of PRD §5.3: `template.apply` gets a working three-option
 * template picker here without a line of bespoke UI, and so does the next tool
 * somebody adds.
 *
 * Commit timing differs by control, deliberately. A select or a checkbox
 * commits on change, because the interaction IS the decision. Text and number
 * fields commit on blur, because committing per keystroke would put one signal
 * — and one entry in the audit trail — on every character typed.
 */

import { useEffect, useState } from "react";
import type { ParamSpec } from "@wf/shared";
import { paramValue } from "@/lib/use-tools";

export interface ParamFormProps {
  specs: ParamSpec[];
  params: Record<string, unknown>;
  disabled?: boolean;
  onChange(name: string, value: unknown): void;
}

const FIELD =
  "w-full rounded-[4px] border border-line bg-surface px-2 py-1 text-[11px] text-fg placeholder:text-muted focus:border-line-strong focus:outline-none disabled:text-muted";

export function ParamForm({ specs, params, disabled, onChange }: ParamFormProps) {
  if (specs.length === 0) {
    return <p className="text-[11px] text-muted">This tool takes no parameters.</p>;
  }

  return (
    <div className="space-y-2.5">
      {specs.map((spec) => (
        <Field
          key={spec.name}
          spec={spec}
          params={params}
          disabled={disabled === true}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function Field({
  spec,
  params,
  disabled,
  onChange,
}: {
  spec: ParamSpec;
  params: Record<string, unknown>;
  disabled: boolean;
  onChange(name: string, value: unknown): void;
}) {
  const id = `param-${spec.name}`;
  const current = paramValue(spec, params);

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[10px] text-muted">
        {spec.label}
      </label>

      {spec.type === "enum" && (
        <select
          id={id}
          disabled={disabled}
          value={typeof current === "string" ? current : (spec.default ?? "")}
          onChange={(event) => onChange(spec.name, event.target.value)}
          className={FIELD}
        >
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}

      {spec.type === "boolean" && (
        <label className="flex items-center gap-2 text-[11px]">
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            checked={current === true || current === "true"}
            onChange={(event) => onChange(spec.name, event.target.checked)}
            className="h-3.5 w-3.5 accent-fg"
          />
          <span className="text-muted">{spec.label}</span>
        </label>
      )}

      {spec.type === "text" && (
        <DeferredInput
          id={id}
          disabled={disabled}
          value={typeof current === "string" ? current : ""}
          placeholder={spec.placeholder}
          onCommit={(next) => onChange(spec.name, next)}
        />
      )}

      {spec.type === "number" && (
        <DeferredInput
          id={id}
          disabled={disabled}
          numeric
          min={spec.min}
          max={spec.max}
          value={current === undefined ? "" : String(current)}
          onCommit={(next) => {
            // An empty field means "unset", not zero — `Number("")` is 0, and a
            // silently-zeroed page count or quality setting is exactly the kind
            // of wrong-but-plausible parameter nobody notices until the output
            // is wrong.
            if (next.trim() === "") {
              onChange(spec.name, undefined);
              return;
            }
            const parsed = Number(next);
            if (Number.isFinite(parsed)) onChange(spec.name, parsed);
          }}
        />
      )}
    </div>
  );
}

/**
 * A field that keeps its own draft and reports on blur or Enter.
 *
 * The authoritative value can change under the user — the planner rewrites
 * params, a reconnect replays the log — so the draft re-adopts it whenever it
 * changes, which is correct everywhere except mid-edit. Committing on blur
 * makes "mid-edit" and "adopted" mutually exclusive in practice.
 */
function DeferredInput({
  id,
  value,
  onCommit,
  disabled,
  placeholder,
  numeric,
  min,
  max,
}: {
  id: string;
  value: string;
  onCommit(next: string): void;
  disabled: boolean;
  placeholder?: string;
  numeric?: boolean;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      id={id}
      type={numeric === true ? "number" : "text"}
      inputMode={numeric === true ? "decimal" : undefined}
      min={min}
      max={max}
      disabled={disabled}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={FIELD}
    />
  );
}
