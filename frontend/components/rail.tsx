"use client";

/**
 * The 56px rail — PRD §3.3.
 *
 * Two 36px circular buttons. Active is a filled `fg` disc with a white glyph;
 * inactive is a 1px `line` ring with an `fg` glyph. Circles here, on the node
 * handles, and on the Run control are the same motif (§3.5).
 */

export type RailTab = "chat" | "build";

const TABS: { id: RailTab; glyph: string; label: string }[] = [
  { id: "chat", glyph: "◐", label: "Chat" },
  { id: "build", glyph: "⊞", label: "Build" },
];

export function Rail({
  active,
  onSelect,
}: {
  active: RailTab | null;
  onSelect(tab: RailTab): void;
}) {
  return (
    <nav
      aria-label="Workspace"
      className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-faint bg-surface-2 pt-3"
    >
      {TABS.map((tab) => {
        const on = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={on}
            aria-label={tab.label}
            title={tab.label}
            onClick={() => onSelect(tab.id)}
            className={`grid h-9 w-9 place-items-center rounded-full text-[14px] leading-none transition-colors ${
              on
                ? "bg-fg text-bg"
                : "border border-line text-fg hover:border-line-strong"
            }`}
          >
            <span aria-hidden="true">{tab.glyph}</span>
          </button>
        );
      })}
    </nav>
  );
}
