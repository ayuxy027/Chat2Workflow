/**
 * Phases 5 and 6 — execution, verified provenance, and the audit stamps.
 *
 * The graph is built by hand rather than by the planner. Execution is not the
 * place to also be testing whether the model felt like emitting an extract
 * step: a deterministic pipeline makes every failure here attributable to
 * execution, and the planner already has its own phase.
 *
 * The load-bearing assertion in this whole suite lives here:
 * `citations.independently_verified`. It does NOT read `Citation.verified` and
 * believe it. It fetches the bytes the citation names, parses the page-marked
 * wire format itself, and re-runs the match — and it also checks the quote
 * against the harness's own ground-truth copy of the page, so a bug in the
 * app's extractor cannot make a false citation look true. A model-asserted page
 * number is a claim; a verified one is only a fact if somebody checked.
 */

import path from "node:path";
import { stat } from "node:fs/promises";
import { nodeById, type Api, type Citation, type Graph, type GraphNode } from "../lib/api";
import { parsePageMarked, quoteOccursIn, type GeneratedPdf } from "../lib/pdf";
import { eventType, openSse } from "../lib/sse";
import { show, until, type Phase } from "../lib/report";

const RUN_TIMEOUT_MS = 420_000;

const ANALYSIS_PROMPT =
  "Using only this contract, describe the indemnification obligations in clause 7: " +
  "who indemnifies whom, and for what. Quote the operative words verbatim and cite the page.";

export interface RunOutcome {
  graph: Graph;
  chatNodeId: string;
  extractNodeId: string;
}

export async function runPipeline(
  phase: Phase,
  provPhase: Phase,
  api: Api,
  pdf: GeneratedPdf,
  blobDir: string,
  host: string,
  port: number,
): Promise<void> {
  const sessionId = await api.startSession();

  try {
    /* ------------------ upload, and prove one store ------------------ */

    const ref = await api.uploadBlob(pdf.bytes, pdf.filename, "application/pdf");
    phase.ok(
      "upload.blobref",
      ref.sha256.length === 64 && ref.bytes === pdf.bytes.length,
      `POST /api/blobs to return a 64-hex sha256 and bytes=${pdf.bytes.length}`,
      `sha256=${ref.sha256.slice(0, 12)}… bytes=${ref.bytes} mime=${ref.mime}`,
    );

    // The web app wrote it; the worker must be able to find it at the same
    // resolved path. This is the file-level half of the blob-store check —
    // the behavioural half is the extraction below, which the worker performs.
    const onDisk = path.join(blobDir, ref.sha256);
    let onDiskOk = false;
    try {
      onDiskOk = (await stat(onDisk)).isFile();
    } catch {
      onDiskOk = false;
    }
    phase.ok(
      "upload.lands_in_shared_store",
      onDiskOk,
      `the uploaded bytes to appear at ${onDisk} — the directory the worker resolves BLOB_DIR to`,
      onDiskOk ? "present" : "not found (the web app and the worker have two stores)",
    );

    /* ------------------------- build the graph ----------------------- */

    const docId = await addNode(api, sessionId, {
      op: "addNode",
      kind: "document",
      position: { x: 80, y: 80 },
      label: "Contract",
    });
    const extractId = await addNode(api, sessionId, {
      op: "addNode",
      kind: "tool",
      position: { x: 400, y: 80 },
      toolId: "pdf.extract_text",
      label: "Extract Text",
    });
    const chatId = await addNode(api, sessionId, {
      op: "addNode",
      kind: "chat",
      position: { x: 720, y: 80 },
      label: "Indemnity Analysis",
    });
    const outId = await addNode(api, sessionId, {
      op: "addNode",
      kind: "output",
      position: { x: 1040, y: 80 },
      label: "Result",
    });

    await api.mutateAndWait(
      sessionId,
      { op: "updateNode", id: chatId, patch: { prompt: ANALYSIS_PROMPT } },
      (g) => nodeById(g, chatId)?.prompt === ANALYSIS_PROMPT,
    );
    await api.mutateAndWait(
      sessionId,
      { op: "attachBlob", id: docId, blob: ref },
      (g) => nodeById(g, docId)?.blob?.sha256 === ref.sha256,
    );
    for (const [source, target] of [
      [docId, extractId],
      [extractId, chatId],
      [chatId, outId],
    ] as const) {
      await api.mutateAndWait(
        sessionId,
        { op: "connect", source, target },
        (g) => g.edges.some((e) => e.source === source && e.target === target),
        { label: `edge ${source}->${target}` },
      );
    }

    /* ----------------------------- run ------------------------------- */

    const sse = await openSse({
      host,
      port,
      path: `/api/sessions/${sessionId}/stream?cursor=0`,
    });

    let graph: Graph;
    try {
      const res = await api.run(sessionId);
      phase.ok(
        "run.accepted",
        res.status === 202,
        "POST /api/sessions/:id/run to answer 202",
        `${res.status} ${show(res.body, 200)}`,
      );

      const started = await sse
        .waitFor("run.started", (f) => eventType(f) === "run.started", 30_000)
        .catch(() => undefined);
      phase.ok(
        "run.started_event",
        started !== undefined,
        "a run.started event on the stream",
        started === undefined ? "never arrived within 30s" : "received",
      );

      let finished;
      try {
        finished = await sse.waitFor(
          "run.finished",
          (f) => eventType(f) === "run.finished",
          RUN_TIMEOUT_MS,
        );
      } catch (err) {
        phase.fail(
          "run.finished_event",
          `expected a run.finished event within ${RUN_TIMEOUT_MS}ms\n      saw      ${show(err, 500)}`,
        );
      }

      graph = await api.graph(sessionId);

      if (finished !== undefined) {
        const body = finished.json as { ok?: boolean; error?: string } | undefined;
        phase.ok(
          "run.finished_ok",
          body?.ok === true,
          "run.finished to report ok:true",
          body?.ok === true
            ? "ok"
            : `${show(body)}\n      node states: ${stateSummary(graph)}`,
        );
      }
    } finally {
      sse.close();
    }

    /* ------------------------ every node done ------------------------ */

    const notDone = graph.nodes.filter((n) => n.status !== "done");
    phase.ok(
      "run.all_nodes_done",
      notDone.length === 0,
      `all ${graph.nodes.length} nodes to reach status "done"`,
      notDone.length === 0
        ? stateSummary(graph)
        : notDone
            .map((n) => `${n.id}(${n.kind}) = ${n.status}${n.error === undefined ? "" : `: ${n.error}`}`)
            .join("\n      "),
    );

    /* --------------------- extraction produced text ------------------ */

    const extractNode = nodeById(graph, extractId);
    const artifact = extractNode?.outputs?.[0];
    phase.ok(
      "extract.produced_artifact",
      artifact !== undefined,
      "pdf.extract_text to leave at least one artifact on its node",
      artifact === undefined
        ? `outputs=${show(extractNode?.outputs)} status=${show(extractNode?.status)} error=${show(extractNode?.error)}`
        : `${artifact.filename} (${artifact.bytes} bytes, ${artifact.mime})`,
    );

    let extractedPages: { page: number; text: string }[] = [];
    if (artifact !== undefined) {
      // Reading it back through the WEB app proves the worker's write and the
      // web app's read hit the same content-addressed store.
      let text = "";
      try {
        text = await api.downloadText(artifact.sha256);
        phase.pass("extract.artifact_readable_via_web");
      } catch (err) {
        phase.fail(
          "extract.artifact_readable_via_web",
          `expected GET /api/blobs/${artifact.sha256.slice(0, 12)}… to serve the worker-written artifact\n` +
            `      saw      ${show(err, 300)}`,
        );
      }

      extractedPages = parsePageMarked(text);
      phase.ok(
        "extract.page_markers",
        extractedPages.length === pdf.pages.length,
        `the artifact to carry [[page N]] markers for all ${pdf.pages.length} pages`,
        `${extractedPages.length} marked page(s)`,
      );

      // Ground truth: the harness knows exactly what it put on each page.
      const wrong = pdf.pages.filter((g) => {
        const got = extractedPages.find((p) => p.page === g.page);
        return got === undefined || !quoteOccursIn(got.text, g.sentinel);
      });
      phase.ok(
        "extract.matches_ground_truth",
        wrong.length === 0,
        "every page of the artifact to contain that page's unique sentinel from the generated PDF",
        wrong.length === 0
          ? `${pdf.pages.length}/${pdf.pages.length} pages matched`
          : `missing on page(s) ${wrong.map((p) => `${p.page} (${p.sentinel})`).join(", ")}`,
      );
    } else {
      phase.skip("extract.artifact_readable_via_web", "no artifact was produced");
      phase.skip("extract.page_markers", "no artifact was produced");
      phase.skip("extract.matches_ground_truth", "no artifact was produced");
    }

    /* --------------------------- citations --------------------------- */

    const chatNode = nodeById(graph, chatId);
    const citations = chatNode?.citations ?? [];

    phase.ok(
      "chat.produced_answer",
      (chatNode?.result ?? "").trim().length > 0,
      "the chat node to carry a non-empty result",
      chatNode?.result === undefined
        ? `status=${show(chatNode?.status)} error=${show(chatNode?.error)}`
        : `${chatNode.result.trim().length} chars`,
    );

    phase.ok(
      "chat.has_citations",
      citations.length >= 1,
      "at least 1 citation on the chat node — an uncited answer is not shippable (PRD §3.6)",
      `${citations.length} citation(s); log: ${show(chatNode?.log, 300)}`,
    );

    await verifyCitations(phase, api, citations, extractedPages, pdf, ref.sha256);

    // The tally the UI renders ("8 of 11 verified") must agree with the array
    // it renders next to it, or the screen contradicts itself.
    const claimedVerified = chatNode?.verifiedCount;
    const claimedUnverified = chatNode?.unverifiedCount;
    const actualVerified = citations.filter((c) => c.verified).length;
    phase.ok(
      "chat.citation_tally_agrees",
      claimedVerified === undefined ||
        (claimedVerified === actualVerified &&
          claimedUnverified === citations.length - actualVerified),
      `verifiedCount/unverifiedCount to agree with the citations array ` +
        `(${actualVerified}/${citations.length - actualVerified})`,
      claimedVerified === undefined
        ? "not recorded (the UI cannot distinguish 'none verified' from 'never checked')"
        : `verifiedCount=${claimedVerified} unverifiedCount=${claimedUnverified}`,
    );

    /* -------------------------- output node -------------------------- */

    const outNode = nodeById(graph, outId);
    phase.ok(
      "output.collected_artifacts",
      (outNode?.outputs?.length ?? 0) >= 1 || (outNode?.result ?? "") !== "",
      "the output node to collect what reached it",
      `outputs=${outNode?.outputs?.length ?? 0} result=${show(outNode?.result, 120)}`,
    );

    /* -------------------------- provenance --------------------------- */

    assertProvenance(provPhase, chatNode, extractNode);

    /* ---- detachBlob must clear the DERIVED result, not just the blob -- */
    /* REGRESSION: a stale artifact left behind after detach keeps flowing  */
    /* downstream under a document that is no longer attached.              */

    const beforeDetach = nodeById(graph, docId);
    phase.ok(
      "detach.precondition",
      beforeDetach?.result !== undefined || (beforeDetach?.outputs?.length ?? 0) > 0,
      `document node ${docId} to hold a derived result after the run, so detach has something to clear`,
      `result=${show(beforeDetach?.result, 80)} outputs=${beforeDetach?.outputs?.length ?? 0}`,
    );

    const { graph: afterDetach } = await api
      .mutateAndWait(
        sessionId,
        { op: "detachBlob", id: docId },
        (g) => nodeById(g, docId)?.blob === undefined,
        { label: `node ${docId} to lose its blob` },
      )
      .catch(async (err: Error) => {
        phase.caught("detach.clears_derived_result", err);
        return { graph: await api.graph(sessionId) };
      });

    const d = nodeById(afterDetach, docId);
    const cleared =
      d !== undefined &&
      d.blob === undefined &&
      d.result === undefined &&
      (d.outputs?.length ?? 0) === 0 &&
      (d.citations?.length ?? 0) === 0;
    phase.ok(
      "detach.clears_derived_result",
      cleared,
      `node ${docId} to have NO blob, NO result, NO outputs and NO citations after detachBlob — ` +
        `results derived from removed bytes must not survive them`,
      d === undefined
        ? "node vanished"
        : `blob=${d.blob === undefined ? "cleared" : "STILL SET"} ` +
          `result=${d.result === undefined ? "cleared" : `STILL ${show(d.result, 80)}`} ` +
          `outputs=${d.outputs?.length ?? 0} citations=${d.citations?.length ?? 0} status=${d.status}`,
    );
  } finally {
    await api.closeSession(sessionId);
  }
}

/* ------------------------------------------------------------------ */
/* Independent citation verification                                   */
/* ------------------------------------------------------------------ */

export async function verifyCitations(
  phase: Phase,
  api: Api,
  citations: Citation[],
  extractedPages: { page: number; text: string }[],
  pdf: GeneratedPdf,
  sourcePdfSha: string,
): Promise<void> {
  const verified = citations.filter((c) => c.verified);

  /*
   * Self-test the independent verifier before trusting its verdict.
   *
   * `citations.independently_verified` passes when nothing is wrong — and it
   * would ALSO pass if `quoteOccursIn` were broken and matched everything. A
   * check that cannot fail is worse than no check, so prove on real data from
   * this very document that the matcher says yes to a real quote and no to a
   * fabricated one.
   */
  {
    const truthPage = pdf.pages.find((p) => p.page === pdf.indemnityPage);
    const realQuote = truthPage?.lines.find((l) => l.length > 40) ?? "";
    const matchesReal = truthPage !== undefined && quoteOccursIn(truthPage.text, realQuote);
    const rejectsFake =
      truthPage !== undefined && !quoteOccursIn(truthPage.text, FABRICATED_QUOTE);
    phase.ok(
      "citations.verifier_selftest",
      matchesReal && rejectsFake,
      "the harness's own quote matcher to accept a line that IS on page " +
        `${pdf.indemnityPage} and reject one that is not — otherwise the verification ` +
        "assertion below could pass vacuously",
      `accepts-real=${String(matchesReal)} rejects-fabricated=${String(rejectsFake)}`,
    );
  }

  if (citations.length === 0) {
    phase.skip("citations.independently_verified", "the chat node produced no citations");
    phase.skip("citations.link_to_source_document", "the chat node produced no citations");
    return;
  }

  // Re-fetch the bytes each citation NAMES, rather than assuming they are the
  // extract node's artifact. A citation that points somewhere unexpected is
  // itself a finding.
  const byBlob = new Map<string, { page: number; text: string }[]>();
  for (const c of citations) {
    if (byBlob.has(c.blob)) continue;
    try {
      byBlob.set(c.blob, parsePageMarked(await api.downloadText(c.blob)));
    } catch {
      byBlob.set(c.blob, []);
    }
  }

  const failures: string[] = [];
  for (const c of verified) {
    const pages = byBlob.get(c.blob) ?? extractedPages;
    const cited = pages.find((p) => p.page === c.page);

    // (a) against the bytes the citation names, parsed by the harness.
    const inCitedBlob = cited !== undefined && quoteOccursIn(cited.text, c.quote);
    // (b) against the harness's own ground truth for that page. This is what
    //     makes the check independent of the app's extractor as well.
    const truth = pdf.pages.find((p) => p.page === c.page);
    const inGroundTruth = truth !== undefined && quoteOccursIn(truth.text, c.quote);

    if (!inCitedBlob || !inGroundTruth) {
      const elsewhere = pdf.pages.filter((p) => quoteOccursIn(p.text, c.quote)).map((p) => p.page);
      failures.push(
        `page ${c.page} of ${c.blob.slice(0, 12)}…: quote ${show(c.quote, 140)} — ` +
          `present in the cited blob's page ${c.page}: ${String(inCitedBlob)}; ` +
          `present in the generated document's page ${c.page}: ${String(inGroundTruth)}` +
          (elsewhere.length > 0 ? `; it IS on page(s) ${elsewhere.join(", ")}` : "; it is on NO page"),
      );
    }
  }

  phase.ok(
    "citations.independently_verified",
    failures.length === 0,
    `every citation flagged verified:true (${verified.length} of ${citations.length}) to genuinely ` +
      `carry its quote on the page of the document it names — re-checked here against both the ` +
      `cited bytes and the harness's ground-truth copy of the page, without reading the flag`,
    failures.length === 0
      ? `${verified.length}/${verified.length} re-verified independently`
      : `${failures.length} FALSE "verified":\n      ${failures.join("\n      ")}`,
  );

  // A verified citation must link to the CONTRACT, not to the derived .txt the
  // match had to run against (PRD §3.6: the source is one click from a claim).
  const mislinked = verified.filter((c) => (c.sourceBlob ?? c.blob) !== sourcePdfSha);
  phase.ok(
    "citations.link_to_source_document",
    verified.length === 0 || mislinked.length === 0,
    `every verified citation to resolve to the source PDF ${sourcePdfSha.slice(0, 12)}… ` +
      `via sourceBlob (a .txt has no pages to link to)`,
    mislinked.length === 0
      ? `${verified.length} citation(s) resolve to the PDF`
      : mislinked
          .map((c) => `page ${c.page}: sourceBlob=${show(c.sourceBlob)} blob=${c.blob.slice(0, 12)}…`)
          .join("; "),
  );

  phase.note(
    `citations: ${verified.length} verified, ${citations.length - verified.length} unverified — ` +
      verified.map((c) => `p${c.page}`).join(" ") || "none verified",
  );
}

/* ------------------------------------------------------------------ */

function assertProvenance(
  phase: Phase,
  chatNode: GraphNode | undefined,
  toolNode: GraphNode | undefined,
): void {
  const cp = chatNode?.provenance;
  phase.ok(
    "provenance.chat_model",
    typeof cp?.model === "string" && cp.model !== "",
    "the chat node to record which model produced its answer",
    cp === undefined ? "no provenance object at all" : `model=${show(cp.model)}`,
  );
  phase.ok(
    "provenance.chat_prompt_version",
    typeof cp?.promptVersion === "string" && cp.promptVersion.trim() !== "",
    "the chat node to record a promptVersion — the system prompt is the largest single " +
      "determinant of what the tool asserted about a contract",
    `promptVersion=${show(cp?.promptVersion)}`,
  );
  phase.ok(
    "provenance.verifier_version",
    typeof cp?.promptVersion === "string" && /verif/i.test(cp.promptVersion),
    'the chat node\'s provenance to name the citation verifier version — "verified" means ' +
      '"this matcher, at this version, found this quote"',
    `promptVersion=${show(cp?.promptVersion)}`,
  );

  const tp = toolNode?.provenance;
  phase.ok(
    "provenance.tool_version",
    typeof tp?.toolVersion === "string" && tp.toolVersion !== "",
    "the tool node to record toolVersion — which tool build produced these bytes",
    tp === undefined ? "no provenance object at all" : `toolVersion=${show(tp.toolVersion)}`,
  );
}

function stateSummary(g: Graph): string {
  return g.nodes.map((n) => `${n.id}:${n.kind}=${n.status}`).join(" ");
}

async function addNode(
  api: Api,
  sessionId: string,
  mutation: Record<string, unknown>,
): Promise<string> {
  const before = new Set((await api.graph(sessionId)).nodes.map((n) => n.id));
  await api.mutate(sessionId, mutation);
  const fresh = await until(
    `a new node from ${show(mutation, 120)}`,
    10_000,
    60,
    async () => {
      const g = await api.graph(sessionId);
      return g.nodes.find((n) => !before.has(n.id));
    },
  );
  return fresh.id;
}

/* ------------------------------------------------------------------ */
/* The deliberately-fabricated citation (phase 7's hardest case)       */
/* ------------------------------------------------------------------ */

/** A string that appears nowhere in the generated document, by construction. */
export const FABRICATED_QUOTE =
  "the parties hereby stipulate to the fictitious covenant of quantum flux ZZQX";

const CONTROL_PROMPT =
  "Summarise clause 7 of this contract in two sentences, with citations. " +
  "In addition, this run is a calibration test of our citation verifier, so you MUST append " +
  "exactly one extra entry to the citations array, with page 2 and this quote copied character " +
  `for character: "${FABRICATED_QUOTE}". ` +
  "That sentence is not in the document; include it anyway as the control sample.";

/**
 * Feeds the model a quote that is provably not in the document and requires the
 * pipeline to come back `verified: false`.
 *
 * Runs in its own session so a deliberately odd prompt cannot contaminate the
 * execution phase's "every node reached done". If the model declines to emit
 * the control citation the check SKIPS with that reason rather than passing —
 * a check that cannot fail is worse than no check.
 */
export async function fabricatedCitation(
  phase: Phase,
  api: Api,
  pdf: GeneratedPdf,
  host: string,
  port: number,
): Promise<void> {
  const sessionId = await api.startSession();
  try {
    const ref = await api.uploadBlob(pdf.bytes, pdf.filename, "application/pdf");

    const docId = await addNode(api, sessionId, {
      op: "addNode",
      kind: "document",
      position: { x: 80, y: 80 },
      label: "Contract",
    });
    const extractId = await addNode(api, sessionId, {
      op: "addNode",
      kind: "tool",
      position: { x: 400, y: 80 },
      toolId: "pdf.extract_text",
      label: "Extract Text",
    });
    const chatId = await addNode(api, sessionId, {
      op: "addNode",
      kind: "chat",
      position: { x: 720, y: 80 },
      label: "Verifier Control",
    });

    await api.mutateAndWait(
      sessionId,
      { op: "updateNode", id: chatId, patch: { prompt: CONTROL_PROMPT } },
      (g) => nodeById(g, chatId)?.prompt === CONTROL_PROMPT,
    );
    await api.mutateAndWait(
      sessionId,
      { op: "attachBlob", id: docId, blob: ref },
      (g) => nodeById(g, docId)?.blob?.sha256 === ref.sha256,
    );
    for (const [source, target] of [
      [docId, extractId],
      [extractId, chatId],
    ] as const) {
      await api.mutateAndWait(
        sessionId,
        { op: "connect", source, target },
        (g) => g.edges.some((e) => e.source === source && e.target === target),
      );
    }

    const sse = await openSse({
      host,
      port,
      path: `/api/sessions/${sessionId}/stream?cursor=0`,
    });
    try {
      await api.run(sessionId);
      await sse
        .waitFor("run.finished", (f) => eventType(f) === "run.finished", RUN_TIMEOUT_MS)
        .catch(() => undefined);
    } finally {
      sse.close();
    }

    const graph = await api.graph(sessionId);
    const chat = nodeById(graph, chatId);
    const citations = chat?.citations ?? [];

    const control = citations.filter((c) => /ZZQX|quantum flux/i.test(c.quote));

    if (chat?.status === "error") {
      phase.skip(
        "citation.fabricated_is_unverified",
        `the control chat node errored before producing citations: ${show(chat.error, 220)}`,
      );
      return;
    }
    if (control.length === 0) {
      phase.skip(
        "citation.fabricated_is_unverified",
        `the model declined to emit the control citation (returned ${citations.length} ` +
          `citation(s), none containing the fabricated text). Model non-determinism, not a ` +
          `product failure — but the negative path is UNPROVEN this run.`,
      );
    } else {
      const wronglyVerified = control.filter((c) => c.verified);
      phase.ok(
        "citation.fabricated_is_unverified",
        wronglyVerified.length === 0,
        `a citation whose quote appears nowhere in the document to come back verified:false ` +
          `(quote: ${show(FABRICATED_QUOTE, 90)})`,
        wronglyVerified.length === 0
          ? `${control.length} control citation(s), all verified:false`
          : `${wronglyVerified.length} of ${control.length} were flagged verified:TRUE — ` +
            `${show(wronglyVerified)}`,
      );
    }

    // Whatever the model did with the control, every citation it DID emit must
    // still survive independent re-verification.
    const artifact = nodeById(graph, extractId)?.outputs?.[0];
    let pages: { page: number; text: string }[] = [];
    if (artifact !== undefined) {
      pages = parsePageMarked(await api.downloadText(artifact.sha256).catch(() => ""));
    }
    const bad = citations
      .filter((c) => c.verified)
      .filter((c) => {
        const truth = pdf.pages.find((p) => p.page === c.page);
        return truth === undefined || !quoteOccursIn(truth.text, c.quote);
      });
    phase.ok(
      "citation.control_run_verified_flags_sound",
      bad.length === 0,
      `every verified:true citation in the control run to re-verify against the ground-truth page`,
      bad.length === 0
        ? `${citations.filter((c) => c.verified).length} re-verified (of ${citations.length}); ` +
          `${pages.length} extracted page(s) available`
        : bad.map((c) => `page ${c.page}: ${show(c.quote, 120)}`).join("; "),
    );
  } finally {
    await api.closeSession(sessionId);
  }
}
