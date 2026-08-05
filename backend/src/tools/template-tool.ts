import { manifestById, parsePageMarked } from "@wf/shared";
import { enumOf } from "./params.js";
import { ToolParamError, type ToolDef } from "./types.js";

/**
 * `template.apply` — lay analysis text out in a firm-standard skeleton.
 *
 * Pure TypeScript, deliberately. This is exactly the kind of deterministic,
 * reproducible text arrangement that must NOT be a model call (CLAUDE.md
 * §Legal-domain rules 3): sending a draft back through a model to reformat it
 * would be slower, costlier, non-reproducible, and would give the model another
 * opportunity to alter a sentence a lawyer is about to rely on. It is also not
 * a job for LibreOffice or a second runtime — headings and section order are
 * string concatenation.
 *
 * WHAT THIS TOOL WILL NOT DO
 *
 * It arranges; it does not author. Every line of body text is text that arrived
 * on an input, copied through unchanged. It writes no conclusion, no
 * recommendation and no risk rating of its own, because a template that
 * invented a heading called "Recommendation" and put text under it would be
 * presenting the tool's arrangement as the author's advice. Sections with
 * nothing to put in them say so rather than being quietly dropped — an empty
 * "Key Risks" heading is information, and a missing one is a silent omission.
 */

const MD = "text/markdown";

type TemplateId = "memo" | "review" | "summary";

interface TemplateSpec {
  title: string;
  /** Section headings, in order. */
  sections: string[];
  /** Shown under the title. Never a conclusion — a statement about provenance. */
  preamble: string;
}

const TEMPLATES: Readonly<Record<TemplateId, TemplateSpec>> = {
  memo: {
    title: "Client Memorandum",
    preamble:
      "Prepared from the analysis below. This is a draft for supervising-solicitor review " +
      "and is not advice.",
    sections: ["Summary", "Background", "Analysis", "Points to Confirm"],
  },
  review: {
    title: "Contract Review",
    preamble:
      "Clause-level review compiled from the upstream analysis. Every statement below " +
      "originates in that analysis; nothing has been added.",
    sections: [
      "Overview",
      "Key Terms",
      "Issues Identified",
      "Clauses Requiring Amendment",
      "Points to Confirm",
    ],
  },
  summary: {
    title: "Deal Summary",
    preamble:
      "Transaction summary compiled from the upstream analysis. A draft for review, not advice.",
    sections: ["Parties", "Commercial Terms", "Conditions and Timing", "Open Items"],
  },
};

/**
 * Split incoming analysis into blocks that can be filed under a heading.
 *
 * Markdown headings in the source are the natural seam; failing that, blank
 * lines. Page markers from `pdf.extract_text` are stripped — they are a
 * transport detail of the extraction format, not something to print in a memo.
 */
interface Block {
  heading: string | null;
  body: string;
}

function toBlocks(text: string): Block[] {
  // If it is page-marked extraction output, drop the markers and keep the text.
  const paged = parsePageMarked(text);
  const flat = paged.length > 0 ? paged.map((p) => p.text).join("\n\n") : text;

  const blocks: Block[] = [];
  let heading: string | null = null;
  let buf: string[] = [];

  const flush = (): void => {
    const body = buf.join("\n").trim();
    if (body !== "" || heading !== null) blocks.push({ heading, body });
    buf = [];
  };

  for (const line of flat.split("\n")) {
    const h = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (h) {
      flush();
      heading = h[2];
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks.filter((b) => b.heading !== null || b.body !== "");
}

/** Score how well a block's heading matches a template section. */
function affinity(section: string, heading: string): number {
  const s = section.toLowerCase();
  const h = heading.toLowerCase();
  if (s === h) return 3;
  if (h.includes(s) || s.includes(h)) return 2;
  const words = s.split(/\W+/).filter((w) => w.length > 3);
  return words.some((w) => h.includes(w)) ? 1 : 0;
}

/**
 * File each block under the best-matching section.
 *
 * A block whose heading matches nothing is NOT discarded — it goes to the last
 * section, which is always the open-questions one. Dropping text the analysis
 * produced because the template had no slot for it would silently lose a
 * caveat, which is the one thing a legal template must never do.
 */
function distribute(blocks: Block[], sections: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(sections.map((s) => [s, []]));
  const fallback = sections[sections.length - 1]!;

  for (const block of blocks) {
    let best = fallback;
    let bestScore = 0;
    if (block.heading !== null) {
      for (const section of sections) {
        const score = affinity(section, block.heading);
        if (score > bestScore) {
          bestScore = score;
          best = section;
        }
      }
    }
    const piece =
      block.heading !== null && bestScore < 3
        ? `**${block.heading}**\n\n${block.body}`.trim()
        : block.body;
    if (piece.trim() !== "") out.get(best)!.push(piece);
  }
  return out;
}

export const templateApply: ToolDef<{ template: TemplateId }> = {
  manifest: manifestById("template.apply"),
  parseParams: (raw) => ({
    template: enumOf(raw, "template", ["memo", "review", "summary"] as const, "memo"),
  }),
  async run(ctx) {
    if (ctx.inputs.length === 0) {
      throw new ToolParamError(
        "template.apply needs at least one text input. Connect the chat node whose analysis " +
          "you want laid out.",
      );
    }

    const spec = TEMPLATES[ctx.params.template];
    const blocks: Block[] = [];

    for (let i = 0; i < ctx.inputs.length; i++) {
      const ref = ctx.inputs[i]!;
      const text = (await ctx.read(ref)).toString("utf8");
      if (text.trim() === "") {
        ctx.log(`WARNING: ${ref.filename} was empty; no section was filled from it.`);
      }
      blocks.push(...toBlocks(text));
      ctx.heartbeat((i + 1) / ctx.inputs.length);
    }

    const filed = distribute(blocks, spec.sections);

    const lines: string[] = [`# ${spec.title}`, "", `_${spec.preamble}_`, ""];
    let empty = 0;
    for (const section of spec.sections) {
      lines.push(`## ${section}`, "");
      const content = filed.get(section)!;
      if (content.length === 0) {
        empty++;
        // Named, not omitted: a heading the analysis had nothing for is a fact
        // about the analysis, and quietly deleting it hides that.
        lines.push("_Nothing in the upstream analysis addressed this section._", "");
      } else {
        lines.push(content.join("\n\n"), "");
      }
    }
    lines.push(
      "---",
      "",
      "_Arranged by template.apply from the analysis above. No content was added, removed or " +
        "rewritten; citations and caveats remain those of the upstream node._",
    );

    const markdown = `${lines.join("\n").trimEnd()}\n`;
    ctx.log(
      `applied "${ctx.params.template}" template: ${spec.sections.length} section(s), ` +
        `${empty} with nothing to fill them, from ${blocks.length} source block(s)`,
    );

    const out = await ctx.write(new TextEncoder().encode(markdown), {
      filename: `${ctx.params.template}.md`,
      mime: MD,
    });
    return { outputs: [out], log: "" };
  },
};
