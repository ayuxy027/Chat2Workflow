import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { manifestById } from "@wf/shared";
import { extractPages, renderPageMarked } from "./pdf-text.js";
import { enumOf, parsePageRanges, safeName, str, withExt } from "./params.js";
import { runBinary } from "./shell.js";
import { ToolParamError, type ToolDef } from "./types.js";

/**
 * The v1 tool registry (PRD §5.2).
 *
 * Deterministic byte operations run locally; the model does judgment.
 * Compressing a PDF through a model would be slower, costlier,
 * non-reproducible, and would send the document somewhere it did not need to go.
 *
 * Four tools are pure TypeScript and work on any machine:
 *   pdf.extract_text, pdf.split, pdf.merge, template.apply
 * Three shell out and therefore depend on binaries the worker image must pin:
 *   pdf.compress (qpdf | gs), pdf.to_docx (soffice), docx.to_pdf (soffice)
 *
 * Only the EXECUTABLE half lives here. Each manifest — the serializable half
 * the canvas builds its parameter form from — comes from
 * `@wf/shared/tool-manifests`, so the form the user edits and the schema this
 * file validates against cannot drift apart.
 */

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TXT = "text/plain";

async function loadPdf(bytes: Uint8Array, filename: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    throw new ToolParamError(
      `"${filename}" could not be read as a PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* pdf.extract_text — pure TS                                          */
/* ------------------------------------------------------------------ */

export const pdfExtractText: ToolDef<Record<string, never>> = {
  manifest: manifestById("pdf.extract_text"),
  parseParams: () => ({}),
  async run(ctx) {
    const ref = ctx.inputs[0];
    if (ref === undefined) throw new ToolParamError("pdf.extract_text needs one PDF input.");
    const bytes = await ctx.read(ref);
    ctx.heartbeat(0.2);

    const report = await extractPages(bytes);
    ctx.heartbeat(0.8);

    const marked = renderPageMarked(report.pages);
    const chars = report.pages.reduce((n, p) => n + p.text.length, 0);

    ctx.log(`extracted ${chars} characters from ${report.pages.length} page(s)`);
    if (report.emptyPages.length > 0) {
      ctx.log(
        `WARNING: ${report.emptyPages.length} page(s) yielded no text ` +
          `(${report.emptyPages.slice(0, 20).join(", ")}${report.emptyPages.length > 20 ? ", …" : ""}). ` +
          `These are most likely scans with no text layer. OCR is not available in v1, ` +
          `so no citation can be verified against them.`,
      );
    }

    const out = await ctx.write(new TextEncoder().encode(marked), {
      filename: withExt(safeName(ref.filename), ".txt"),
      mime: TXT,
      pages: report.pages.length,
    });
    return { outputs: [out], log: "" };
  },
};

/* ------------------------------------------------------------------ */
/* pdf.split — pure TS                                                 */
/* ------------------------------------------------------------------ */

export const pdfSplit: ToolDef<{ ranges: string }> = {
  manifest: manifestById("pdf.split"),
  parseParams: (raw) => ({ ranges: str(raw, "ranges", "1-") }),
  async run(ctx) {
    const ref = ctx.inputs[0];
    if (ref === undefined) throw new ToolParamError("pdf.split needs one PDF input.");
    const src = await loadPdf(await ctx.read(ref), ref.filename);
    const total = src.getPageCount();
    const groups = parsePageRanges(ctx.params.ranges, total);

    const outputs = [];
    const stem = withExt(safeName(ref.filename), "");
    for (let i = 0; i < groups.length; i++) {
      const pages = groups[i];
      const out = await PDFDocument.create();
      const copied = await out.copyPages(
        src,
        pages.map((p) => p - 1),
      );
      for (const p of copied) out.addPage(p);
      const bytes = await out.save();

      const first = pages[0];
      const last = pages[pages.length - 1];
      const suffix = first === last ? `p${first}` : `p${first}-${last}`;
      outputs.push(
        await ctx.write(bytes, {
          filename: `${stem}_${suffix}.pdf`,
          mime: PDF,
          pages: pages.length,
        }),
      );
      ctx.log(`part ${i + 1}: pages ${first}-${last} (${pages.length} page(s))`);
      ctx.heartbeat((i + 1) / groups.length);
    }

    return { outputs, log: "" };
  },
};

/* ------------------------------------------------------------------ */
/* pdf.merge — pure TS                                                 */
/* ------------------------------------------------------------------ */

export const pdfMerge: ToolDef<{ filename: string }> = {
  manifest: manifestById("pdf.merge"),
  parseParams: (raw) => ({ filename: str(raw, "filename", "merged.pdf") }),
  async run(ctx) {
    if (ctx.inputs.length < 2) throw new ToolParamError("pdf.merge needs at least two PDF inputs.");
    const out = await PDFDocument.create();
    let pages = 0;

    for (let i = 0; i < ctx.inputs.length; i++) {
      const ref = ctx.inputs[i];
      const src = await loadPdf(await ctx.read(ref), ref.filename);
      const copied = await out.copyPages(src, src.getPageIndices());
      for (const p of copied) out.addPage(p);
      pages += copied.length;
      ctx.log(`+ ${ref.filename} (${copied.length} page(s))`);
      ctx.heartbeat((i + 1) / ctx.inputs.length);
    }

    const bytes = await out.save();
    const written = await ctx.write(bytes, {
      filename: withExt(safeName(ctx.params.filename), ".pdf"),
      mime: PDF,
      pages,
    });
    ctx.log(`merged ${ctx.inputs.length} documents into ${pages} page(s)`);
    return { outputs: [written], log: "" };
  },
};

/* ------------------------------------------------------------------ */
/* pdf.compress — qpdf (lossless) or Ghostscript (lossy presets)       */
/* ------------------------------------------------------------------ */

type CompressParams = {
  engine: "qpdf" | "ghostscript";
  quality: "screen" | "ebook" | "printer" | "prepress";
};

export const pdfCompress: ToolDef<CompressParams> = {
  manifest: manifestById("pdf.compress"),
  requiresBinaries: ["qpdf", "gs"],
  parseParams: (raw) => ({
    engine: enumOf(raw, "engine", ["qpdf", "ghostscript"] as const, "qpdf"),
    quality: enumOf(
      raw,
      "quality",
      ["screen", "ebook", "printer", "prepress"] as const,
      "ebook",
    ),
  }),
  async run(ctx) {
    const ref = ctx.inputs[0];
    if (ref === undefined) throw new ToolParamError("pdf.compress needs one PDF input.");

    const inPath = path.join(ctx.scratchDir, "in.pdf");
    const outPath = path.join(ctx.scratchDir, "out.pdf");
    await fs.writeFile(inPath, await ctx.read(ref));
    ctx.heartbeat(0.2);

    if (ctx.params.engine === "qpdf") {
      await runBinary(
        "qpdf",
        [
          "--object-streams=generate",
          "--compress-streams=y",
          "--recompress-flate",
          "--compression-level=9",
          "--stream-data=compress",
          inPath,
          outPath,
        ],
        { cwd: ctx.scratchDir, signal: ctx.signal },
      );
      ctx.log("engine: qpdf (lossless — text layer byte-identical)");
    } else {
      await runBinary(
        "gs",
        [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.7",
          `-dPDFSETTINGS=/${ctx.params.quality}`,
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          "-dSAFER",
          `-sOutputFile=${outPath}`,
          inPath,
        ],
        { cwd: ctx.scratchDir, signal: ctx.signal },
      );
      ctx.log(`engine: ghostscript (lossy, preset /${ctx.params.quality})`);
    }

    ctx.heartbeat(0.9);
    const bytes = await fs.readFile(outPath);
    const pct = ref.bytes > 0 ? Math.round((1 - bytes.byteLength / ref.bytes) * 100) : 0;
    ctx.log(`${ref.bytes} -> ${bytes.byteLength} bytes (${pct}% smaller)`);

    const out = await ctx.write(bytes, {
      filename: withExt(safeName(ref.filename), ".compressed.pdf"),
      mime: PDF,
      ...(ref.pages === undefined ? {} : { pages: ref.pages }),
    });
    return { outputs: [out], log: "" };
  },
};

/* ------------------------------------------------------------------ */
/* pdf.to_docx / docx.to_pdf — LibreOffice headless                    */
/* ------------------------------------------------------------------ */

async function sofficeConvert(
  ctx: Parameters<ToolDef["run"]>[0],
  inName: string,
  filter: string,
  outExt: string,
): Promise<Buffer> {
  const inPath = path.join(ctx.scratchDir, inName);
  const outDir = path.join(ctx.scratchDir, "out");
  await fs.mkdir(outDir, { recursive: true });

  const ref = ctx.inputs[0];
  if (ref === undefined) throw new ToolParamError("A document input is required.");
  await fs.writeFile(inPath, await ctx.read(ref));
  ctx.heartbeat(0.2);

  await runBinary(
    "soffice",
    [
      "--headless",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      "--nofirststartwizard",
      `-env:UserInstallation=file://${path.join(ctx.scratchDir, "lo-profile")}`,
      "--convert-to",
      filter,
      "--outdir",
      outDir,
      inPath,
    ],
    { cwd: ctx.scratchDir, signal: ctx.signal },
  );
  ctx.heartbeat(0.85);

  const produced = (await fs.readdir(outDir)).filter((f) => f.endsWith(outExt));
  const first = produced[0];
  if (first === undefined) {
    throw new Error(
      `LibreOffice reported success but wrote no ${outExt} file. The source document is ` +
        `probably one it cannot parse (encrypted, corrupt, or an unsupported variant).`,
    );
  }
  return fs.readFile(path.join(outDir, first));
}

export const pdfToDocx: ToolDef<Record<string, never>> = {
  manifest: manifestById("pdf.to_docx"),
  requiresBinaries: ["soffice"],
  parseParams: () => ({}),
  async run(ctx) {
    const ref = ctx.inputs[0];
    if (ref === undefined) throw new ToolParamError("pdf.to_docx needs one PDF input.");
    const bytes = await sofficeConvert(ctx, "in.pdf", "docx:MS Word 2007 XML", ".docx");
    ctx.log(`converted ${ref.filename} to .docx via LibreOffice`);
    const out = await ctx.write(bytes, {
      filename: withExt(safeName(ref.filename), ".docx"),
      mime: DOCX,
    });
    return { outputs: [out], log: "" };
  },
};

export const docxToPdf: ToolDef<Record<string, never>> = {
  manifest: manifestById("docx.to_pdf"),
  requiresBinaries: ["soffice"],
  parseParams: () => ({}),
  async run(ctx) {
    const ref = ctx.inputs[0];
    if (ref === undefined) throw new ToolParamError("docx.to_pdf needs one .docx input.");
    const bytes = await sofficeConvert(ctx, "in.docx", "pdf:writer_pdf_Export", ".pdf");
    ctx.log(`converted ${ref.filename} to PDF via LibreOffice`);

    let pages: number | undefined;
    try {
      pages = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
    } catch {
      pages = undefined;
    }

    const out = await ctx.write(bytes, {
      filename: withExt(safeName(ref.filename), ".pdf"),
      mime: PDF,
      ...(pages === undefined ? {} : { pages }),
    });
    return { outputs: [out], log: "" };
  },
};
