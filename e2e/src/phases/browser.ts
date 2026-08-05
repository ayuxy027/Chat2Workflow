/**
 * Phase 8 — browser smoke.
 *
 * This is the check that would have caught the wrong-JSON-key bug. The API was
 * green, the SSE stream was green, the build was green, and the canvas was
 * EMPTY with zero console errors, because the client read `body.nodes` from a
 * response shaped `{ graph: { nodes } }`. No amount of curl sees that: the
 * server was right and the screen was blank.
 *
 * So the assertion is deliberately the crudest possible one — load the page,
 * type into the chat bar, submit, and count the nodes React Flow actually
 * rendered. Anything that stops a node reaching the canvas fails here,
 * whichever layer it lives in.
 */

import { launchBrowser } from "../lib/cdp";
import { show, sleep, until, type Phase } from "../lib/report";

const PROMPT =
  "Summarise the indemnity clauses in this contract, compress it, and give me a Word version.";

const RENDER_TIMEOUT_MS = 240_000;

/** Chatter every React app produces that is not a page error. */
const BENIGN = [
  /Download the React DevTools/i,
  /react-devtools/i,
  /Fast Refresh/i,
];

export async function browserSmoke(
  phase: Phase,
  baseUrl: string,
  screenshotPath?: string,
): Promise<void> {
  let browser;
  try {
    browser = await launchBrowser(baseUrl);
  } catch (err) {
    phase.fail(
      "browser.launch",
      `expected headless chrome to start and expose a page target\n      saw      ${show(err, 600)}`,
    );
    return;
  }

  try {
    phase.pass("browser.launch");

    // The app is a client component behind a Temporal session handshake, so
    // wait for the canvas root rather than for a fixed sleep.
    await until("the React Flow canvas to mount", 60_000, 250, async () => {
      const n = await browser.eval<number>(
        `document.querySelectorAll('.react-flow').length`,
      );
      return n > 0 ? n : undefined;
    }).catch(() => undefined);

    const mounted = await browser.eval<number>(
      `document.querySelectorAll('.react-flow').length`,
    );
    phase.ok(
      "browser.canvas_mounts",
      mounted > 0,
      "the React Flow canvas to be present in the DOM",
      `${mounted} .react-flow element(s)`,
    );

    // Give the session handshake (POST /api/sessions + SSE attach) a moment to
    // settle, so the prompt is not submitted into a disabled chat bar.
    await until("the chat bar to become enabled", 30_000, 250, async () => {
      const ready = await browser.eval<boolean>(
        `!!document.querySelector('input[aria-label], input, textarea')`,
      );
      return ready ? true : undefined;
    }).catch(() => undefined);
    await sleep(1500);

    /*
     * React controls the input's value through its own descriptor, so setting
     * `el.value` directly is silently discarded on the next render. Going
     * through the prototype setter and then dispatching `input` is what makes
     * React see the change.
     */
    const typed = await browser.eval<string>(`(() => {
      const el = document.querySelector('input[aria-label="Describe a workflow"]')
        || document.querySelector('form input')
        || document.querySelector('input, textarea');
      if (!el) return 'no-input';
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(PROMPT)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return 'ok';
    })()`);
    phase.ok(
      "browser.chat_bar_accepts_input",
      typed === "ok",
      "the chat bar input to be present and to accept a value",
      typed,
    );

    await sleep(300);

    const submitted = await browser.eval<string>(`(() => {
      const el = document.querySelector('input[aria-label="Describe a workflow"]')
        || document.querySelector('form input')
        || document.querySelector('input, textarea');
      if (!el) return 'no-input';
      const form = el.closest('form');
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'form'; }
      el.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return 'enter';
    })()`);
    phase.ok(
      "browser.prompt_submitted",
      submitted === "form" || submitted === "enter",
      "the prompt to be submitted through the chat bar's own form",
      submitted,
    );

    /* ---------------- the assertion that matters ---------------- */

    let rendered = 0;
    try {
      rendered = await until(
        "nodes to render on the canvas",
        RENDER_TIMEOUT_MS,
        500,
        async () => {
          const n = await browser.eval<number>(
            `document.querySelectorAll('.react-flow__node').length`,
          );
          return n >= 3 ? n : undefined;
        },
      );
    } catch {
      rendered = await browser
        .eval<number>(`document.querySelectorAll('.react-flow__node').length`)
        .catch(() => 0);
    }

    const state = await browser.eval<string>(`JSON.stringify({
      nodes: document.querySelectorAll('.react-flow__node').length,
      edges: document.querySelectorAll('.react-flow__edge').length,
      labels: [...document.querySelectorAll('.react-flow__node')]
        .map(n => (n.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 40))
    })`).catch(() => "{}");

    phase.ok(
      "browser.nodes_render_on_canvas",
      rendered >= 3,
      `at least 3 .react-flow__node elements on the canvas after a three-step prompt — ` +
        `an empty canvas with a green API is exactly the wrong-JSON-key failure this check exists for`,
      `${rendered} node(s); DOM: ${show(state, 500)}`,
    );

    const edges = await browser
      .eval<number>(`document.querySelectorAll('.react-flow__edge').length`)
      .catch(() => 0);
    phase.ok(
      "browser.edges_render_on_canvas",
      rendered < 2 || edges >= 1,
      "the planned nodes to be rendered CONNECTED (at least one edge drawn)",
      `${edges} edge element(s) for ${rendered} node(s)`,
    );

    /* -------------------- zero console errors -------------------- */

    const errors = browser.errors.filter((e) => !BENIGN.some((re) => re.test(e.text)));
    phase.ok(
      "browser.zero_console_errors",
      errors.length === 0,
      "zero console errors and zero uncaught exceptions on the page",
      errors.length === 0
        ? `clean (${browser.warnings.length} warning(s) ignored)`
        : errors.map((e) => `${e.kind}: ${show(e.text, 220)}`).join("\n      "),
    );

    if (browser.warnings.length > 0) {
      phase.note(
        `browser warnings (not failures): ${browser.warnings
          .slice(0, 5)
          .map((w) => show(w, 140))
          .join(" | ")}`,
      );
    }

    if (screenshotPath !== undefined) {
      await browser.screenshot(screenshotPath).catch(() => undefined);
      phase.note(`canvas screenshot written to ${screenshotPath}`);
    }
  } catch (err) {
    phase.caught("browser.smoke", err);
  } finally {
    await browser.close();
  }
}
