import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { PAGE_MARKER } from "@wf/shared";

/**
 * Pure-TypeScript, page-tagged PDF text extraction.
 *
 * This is the provenance backbone (CLAUDE.md §Provenance): because the model
 * receives text with explicit page markers, it can cite page numbers, and —
 * critically — we can VERIFY those citations by string-matching the quote back
 * against the page. A model-asserted page number is a claim; a verified one is
 * a fact.
 *
 * `pdf-lib` gives us the object graph and stream decoding; the content-stream
 * lexer, the text-state machine, and the character-code -> Unicode mapping are
 * implemented here. Scope is deliberate:
 *
 *   - ToUnicode CMaps (bfchar/bfrange) — the dominant case for modern PDFs.
 *   - Simple fonts: WinAnsi / MacRoman / Standard base encodings plus
 *     /Differences with glyph-name resolution.
 *   - Type0 / Identity-H composite fonts via their ToUnicode CMap.
 *   - Form XObjects, recursed to a bounded depth.
 *
 * Out of scope (documented, not silently wrong): scanned pages with no text
 * layer (that is OCR — deferred per PRD §2.3), and CID fonts with no ToUnicode.
 * Both surface as an empty or short page, which `pdf.extract_text` reports.
 */

export interface PageText {
  page: number;
  text: string;
}

export interface ExtractionReport {
  pages: PageText[];
  /** 1-indexed pages that yielded no recoverable text — likely scans. */
  emptyPages: number[];
}

const MAX_XOBJECT_DEPTH = 6;

/* ------------------------------------------------------------------ */
/* Byte-level helpers                                                  */
/* ------------------------------------------------------------------ */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isWhite(b: number): boolean {
  return WHITESPACE.has(b);
}
function isDelim(b: number): boolean {
  return DELIMITERS.has(b);
}
function isRegular(b: number): boolean {
  return !isWhite(b) && !isDelim(b);
}
function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

/* ------------------------------------------------------------------ */
/* Content-stream lexer                                                */
/* ------------------------------------------------------------------ */

type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: Uint8Array }
  | { k: "name"; v: string }
  | { k: "arrayStart" }
  | { k: "arrayEnd" }
  | { k: "dictStart" }
  | { k: "dictEnd" }
  | { k: "op"; v: string };

/**
 * Tokenises a decoded content stream. Strings stay as raw bytes because their
 * meaning depends on the font's encoding, which is only known at Tj time.
 */
function lex(buf: Uint8Array): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = buf.length;

  while (i < n) {
    const b = buf[i];

    if (isWhite(b)) {
      i++;
      continue;
    }

    // comment
    if (b === 0x25) {
      while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
      continue;
    }

    // literal string ( ... )
    if (b === 0x28) {
      i++;
      const bytes: number[] = [];
      let depth = 1;
      while (i < n) {
        const c = buf[i];
        if (c === 0x5c) {
          // backslash escape
          i++;
          const e = buf[i];
          switch (e) {
            case 0x6e: bytes.push(0x0a); i++; break; // n
            case 0x72: bytes.push(0x0d); i++; break; // r
            case 0x74: bytes.push(0x09); i++; break; // t
            case 0x62: bytes.push(0x08); i++; break; // b
            case 0x66: bytes.push(0x0c); i++; break; // f
            case 0x28: bytes.push(0x28); i++; break;
            case 0x29: bytes.push(0x29); i++; break;
            case 0x5c: bytes.push(0x5c); i++; break;
            case 0x0a: i++; break; // line continuation
            case 0x0d:
              i++;
              if (buf[i] === 0x0a) i++;
              break;
            default: {
              if (e >= 0x30 && e <= 0x37) {
                let oct = 0;
                let count = 0;
                while (count < 3 && buf[i] >= 0x30 && buf[i] <= 0x37) {
                  oct = oct * 8 + (buf[i] - 0x30);
                  i++;
                  count++;
                }
                bytes.push(oct & 0xff);
              } else {
                bytes.push(e);
                i++;
              }
            }
          }
          continue;
        }
        if (c === 0x28) depth++;
        if (c === 0x29) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        bytes.push(c);
        i++;
      }
      out.push({ k: "str", v: Uint8Array.from(bytes) });
      continue;
    }

    // hex string < ... >  /  dict start << >>
    if (b === 0x3c) {
      if (buf[i + 1] === 0x3c) {
        out.push({ k: "dictStart" });
        i += 2;
        continue;
      }
      i++;
      const bytes: number[] = [];
      let hi = -1;
      while (i < n && buf[i] !== 0x3e) {
        const h = hexVal(buf[i]);
        i++;
        if (h < 0) continue;
        if (hi < 0) hi = h;
        else {
          bytes.push((hi << 4) | h);
          hi = -1;
        }
      }
      if (hi >= 0) bytes.push(hi << 4);
      i++; // closing >
      out.push({ k: "str", v: Uint8Array.from(bytes) });
      continue;
    }

    if (b === 0x3e && buf[i + 1] === 0x3e) {
      out.push({ k: "dictEnd" });
      i += 2;
      continue;
    }

    if (b === 0x5b) {
      out.push({ k: "arrayStart" });
      i++;
      continue;
    }
    if (b === 0x5d) {
      out.push({ k: "arrayEnd" });
      i++;
      continue;
    }

    // name /Foo
    if (b === 0x2f) {
      i++;
      let s = "";
      while (i < n && isRegular(buf[i])) {
        if (buf[i] === 0x23 && hexVal(buf[i + 1]) >= 0 && hexVal(buf[i + 2]) >= 0) {
          s += String.fromCharCode((hexVal(buf[i + 1]) << 4) | hexVal(buf[i + 2]));
          i += 3;
        } else {
          s += String.fromCharCode(buf[i]);
          i++;
        }
      }
      out.push({ k: "name", v: s });
      continue;
    }

    // number
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      let s = "";
      while (i < n && isRegular(buf[i])) {
        s += String.fromCharCode(buf[i]);
        i++;
      }
      const v = Number.parseFloat(s);
      out.push({ k: "num", v: Number.isFinite(v) ? v : 0 });
      continue;
    }

    // operator keyword
    {
      let s = "";
      while (i < n && isRegular(buf[i])) {
        s += String.fromCharCode(buf[i]);
        i++;
      }
      if (s === "") {
        i++; // unknown delimiter, skip
        continue;
      }
      if (s === "BI") {
        // Inline image: binary data between ID and EI would wreck the lexer.
        i = skipInlineImage(buf, i);
        continue;
      }
      out.push({ k: "op", v: s });
    }
  }

  return out;
}

/** Advances past an inline image's binary payload, returning the index after EI. */
function skipInlineImage(buf: Uint8Array, from: number): number {
  const n = buf.length;
  let i = from;
  // find "ID"
  while (i < n - 1 && !(buf[i] === 0x49 && buf[i + 1] === 0x44)) i++;
  i += 2;
  if (i < n && isWhite(buf[i])) i++;
  // find whitespace-delimited "EI"
  while (i < n - 2) {
    if (buf[i] === 0x45 && buf[i + 1] === 0x49 && (i + 2 >= n || isWhite(buf[i + 2]) || isDelim(buf[i + 2]))) {
      return i + 2;
    }
    i++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Encodings                                                           */
/* ------------------------------------------------------------------ */

/** CP1252 high range (0x80-0x9F). Below 0x80 WinAnsi is ASCII; above 0x9F it is Latin-1. */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function winAnsi(code: number): string {
  if (code >= 0x80 && code <= 0x9f) return String.fromCharCode(CP1252_HIGH[code - 0x80]);
  return String.fromCharCode(code);
}

/**
 * Glyph-name -> Unicode for the names that actually turn up in /Differences.
 * Alphanumerics resolve structurally; this table covers punctuation and the
 * common ligatures. Anything unknown resolves to "" rather than to a guess.
 *
 * Ligatures resolve to their DECOMPOSED letters ("fi", not U+FB01). A ligature
 * is a typesetting artefact, not content: the page says "notification" and the
 * model will echo "notification", so emitting U+FB01 here would make every
 * otherwise-correct citation on a serif-set document fail verification. See the
 * matching pass in `tidy()`, which catches the ToUnicode-CMap route as well.
 */
const GLYPH_NAMES: Readonly<Record<string, string>> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%",
  ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*",
  plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", colon: ":", semicolon: ";",
  less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[",
  backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
  quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”",
  quotesinglbase: "‚", quotedblbase: "„", endash: "–", emdash: "—",
  bullet: "•", ellipsis: "…", dagger: "†", daggerdbl: "‡",
  perthousand: "‰", guilsinglleft: "‹", guilsinglright: "›",
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl",
  section: "§", paragraph: "¶", copyright: "©", registered: "®",
  trademark: "™", degree: "°", plusminus: "±", multiply: "×",
  divide: "÷", sterling: "£", euro: "€", yen: "¥", cent: "¢",
  currency: "¤", nbspace: " ", minus: "−", fraction: "⁄",
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

function glyphToUnicode(name: string): string {
  const direct = GLYPH_NAMES[name];
  if (direct !== undefined) return direct;
  if (name.length === 1) return name;
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(Number.parseInt(uni[1], 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(Number.parseInt(u[1], 16));
  return "";
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

interface FontInfo {
  /** code -> unicode string; consulted first. */
  toUnicode: Map<number, string>;
  /** Number of bytes per character code. 1 for simple fonts, 2 for Identity-H. */
  codeBytes: 1 | 2;
  /** Simple-font encoding overrides from /Differences. */
  differences: Map<number, string>;
  /** Base encoding for simple fonts. */
  baseEncoding: "WinAnsi" | "MacRoman" | "Standard";
}

const FALLBACK_FONT: FontInfo = {
  toUnicode: new Map(),
  codeBytes: 1,
  differences: new Map(),
  baseEncoding: "Standard",
};

/**
 * pdf-lib's `lookupMaybe(key, Type)` THROWS when the value exists but is a
 * different type — `/Encoding` is a name on one font and a dict on the next,
 * so every probe must be instanceof-narrowed instead.
 */
function look(dict: PDFDict | undefined, key: string): unknown {
  if (dict === undefined) return undefined;
  try {
    return dict.lookup(PDFName.of(key));
  } catch {
    return undefined;
  }
}

function lookDict(dict: PDFDict | undefined, key: string): PDFDict | undefined {
  const v = look(dict, key);
  return v instanceof PDFDict && !(v instanceof PDFStream) ? v : undefined;
}

function lookStream(dict: PDFDict | undefined, key: string): PDFStream | undefined {
  const v = look(dict, key);
  return v instanceof PDFStream ? v : undefined;
}

function lookName(dict: PDFDict | undefined, key: string): string | undefined {
  const v = look(dict, key);
  return v instanceof PDFName ? v.asString() : undefined;
}

function lookArray(dict: PDFDict | undefined, key: string): PDFArray | undefined {
  const v = look(dict, key);
  return v instanceof PDFArray ? v : undefined;
}

function decodeStreamBytes(stream: PDFStream | undefined): Uint8Array | undefined {
  if (stream === undefined) return undefined;
  try {
    if (stream instanceof PDFRawStream) {
      return decodePDFRawStream(stream).decode();
    }
    return stream.getContents();
  } catch {
    return undefined;
  }
}

/**
 * Parses a ToUnicode CMap. Only the bfchar/bfrange sections matter for text
 * recovery; codespace ranges are read solely to learn the code width.
 */
function parseToUnicode(bytes: Uint8Array): { map: Map<number, string>; codeBytes: 1 | 2 } {
  const map = new Map<number, string>();
  const tokens = lex(bytes);
  let codeBytes: 1 | 2 = 1;

  const asString = (t: Token | undefined): Uint8Array | undefined =>
    t !== undefined && t.k === "str" ? t.v : undefined;

  const beInt = (b: Uint8Array): number => {
    let v = 0;
    for (const x of b) v = (v << 8) | x;
    return v >>> 0;
  };
  const utf16be = (b: Uint8Array): string => {
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    if (b.length === 1) s = String.fromCharCode(b[0]);
    return s;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k !== "op") continue;

    if (t.v === "begincodespacerange") {
      const lo = asString(tokens[i + 1]);
      if (lo && lo.length >= 2) codeBytes = 2;
      continue;
    }

    if (t.v === "beginbfchar") {
      let j = i + 1;
      while (j + 1 < tokens.length) {
        const src = tokens[j];
        const dst = tokens[j + 1];
        if (src.k !== "str" || dst.k !== "str") break;
        if (src.v.length >= 2) codeBytes = 2;
        map.set(beInt(src.v), utf16be(dst.v));
        j += 2;
      }
      i = j;
      continue;
    }

    if (t.v === "beginbfrange") {
      let j = i + 1;
      while (j + 2 < tokens.length) {
        const lo = tokens[j];
        const hi = tokens[j + 1];
        const dst = tokens[j + 2];
        if (lo.k !== "str" || hi.k !== "str") break;
        if (lo.v.length >= 2) codeBytes = 2;
        const loI = beInt(lo.v);
        const hiI = beInt(hi.v);
        if (hiI - loI > 0xffff) break; // malformed; refuse to allocate

        if (dst.k === "str") {
          // Destination is a base string; the last UTF-16 unit increments.
          const base = utf16be(dst.v);
          const head = base.slice(0, -1);
          const tailCode = base.length > 0 ? base.charCodeAt(base.length - 1) : 0;
          for (let c = loI; c <= hiI; c++) {
            map.set(c, head + String.fromCharCode(tailCode + (c - loI)));
          }
          j += 3;
          continue;
        }

        if (dst.k === "arrayStart") {
          let k = j + 3;
          let c = loI;
          while (k < tokens.length && tokens[k].k === "str") {
            const el = tokens[k];
            if (el.k === "str") map.set(c, utf16be(el.v));
            c++;
            k++;
          }
          j = k + 1; // past arrayEnd
          continue;
        }
        break;
      }
      i = j;
      continue;
    }
  }

  return { map, codeBytes };
}

function buildFont(fontDict: PDFDict): FontInfo {
  const info: FontInfo = {
    toUnicode: new Map(),
    codeBytes: 1,
    differences: new Map(),
    baseEncoding: "Standard",
  };

  const subtype = lookName(fontDict, "Subtype");
  const isType0 = subtype === "/Type0";
  if (isType0) info.codeBytes = 2;

  const uniBytes = decodeStreamBytes(lookStream(fontDict, "ToUnicode"));
  if (uniBytes !== undefined) {
    const parsed = parseToUnicode(uniBytes);
    info.toUnicode = parsed.map;
    info.codeBytes = isType0 ? 2 : parsed.codeBytes;
  }

  const encName = lookName(fontDict, "Encoding");
  if (encName === "/WinAnsiEncoding") info.baseEncoding = "WinAnsi";
  else if (encName === "/MacRomanEncoding") info.baseEncoding = "MacRoman";

  const encDict = lookDict(fontDict, "Encoding");
  if (encDict !== undefined) {
    const base = lookName(encDict, "BaseEncoding");
    if (base === "/WinAnsiEncoding") info.baseEncoding = "WinAnsi";
    else if (base === "/MacRomanEncoding") info.baseEncoding = "MacRoman";

    const diffs = lookArray(encDict, "Differences");
    if (diffs !== undefined) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const el = diffs.lookup(i);
        if (el instanceof PDFNumber) code = el.asNumber();
        else if (el instanceof PDFName) {
          info.differences.set(code, el.asString().replace(/^\//, ""));
          code++;
        }
      }
    }
  }

  return info;
}

function decodeShownBytes(bytes: Uint8Array, font: FontInfo): string {
  let out = "";
  const step = font.codeBytes;
  for (let i = 0; i + step - 1 < bytes.length; i += step) {
    const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];

    const mapped = font.toUnicode.get(code);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }

    if (step === 2) {
      // Identity-H with no ToUnicode: the codes are glyph indices, not
      // characters. Emitting a guess here would corrupt citation verification,
      // so emit nothing and let the page report as short.
      continue;
    }

    const diff = font.differences.get(code);
    if (diff !== undefined) {
      out += glyphToUnicode(diff);
      continue;
    }

    out += font.baseEncoding === "WinAnsi" ? winAnsi(code) : String.fromCharCode(code);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Text-state machine                                                  */
/* ------------------------------------------------------------------ */

interface Emitter {
  out: string[];
  lastY: number | null;
  lastWasSpace: boolean;
}

function push(em: Emitter, s: string): void {
  if (s === "") return;
  em.out.push(s);
  em.lastWasSpace = /\s$/.test(s);
}

function newline(em: Emitter): void {
  if (em.out.length === 0) return;
  if (em.out[em.out.length - 1].endsWith("\n")) return;
  em.out.push("\n");
  em.lastWasSpace = true;
}

function fontsOf(resources: PDFDict | undefined): PDFDict | undefined {
  return lookDict(resources, "Font");
}

function runContent(
  content: Uint8Array,
  resources: PDFDict | undefined,
  em: Emitter,
  depth: number,
  fontCache: Map<PDFDict, FontInfo>,
): void {
  const tokens = lex(content);
  const fontDicts = fontsOf(resources);
  const xobjects = lookDict(resources, "XObject");

  let font: FontInfo = FALLBACK_FONT;
  const operands: Token[] = [];

  // Text-line origin tracking, enough to decide where lines break.
  let lineY: number | null = null;
  let leading = 0;

  const resolveFont = (name: string): FontInfo => {
    if (fontDicts === undefined) return FALLBACK_FONT;
    const d = lookDict(fontDicts, name);
    if (d === undefined) return FALLBACK_FONT;
    const hit = fontCache.get(d);
    if (hit !== undefined) return hit;
    const built = buildFont(d);
    fontCache.set(d, built);
    return built;
  };

  const moveTo = (y: number): void => {
    if (lineY !== null && Math.abs(y - lineY) > 0.5) newline(em);
    lineY = y;
  };

  const nums = (count: number): number[] => {
    const vals: number[] = [];
    for (let i = operands.length - count; i < operands.length; i++) {
      const t = operands[i];
      vals.push(t !== undefined && t.k === "num" ? t.v : 0);
    }
    return vals;
  };

  const showString = (bytes: Uint8Array): void => {
    push(em, decodeShownBytes(bytes, font));
  };

  const showArray = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      const t = tokens[i];
      if (t.k === "str") showString(t.v);
      else if (t.k === "num" && t.v <= -120 && !em.lastWasSpace) push(em, " ");
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.k === "arrayStart") {
      // Only TJ consumes arrays; find its extent and let the operator handle it.
      let j = i + 1;
      while (j < tokens.length && tokens[j].k !== "arrayEnd") j++;
      const op = tokens[j + 1];
      if (op !== undefined && op.k === "op" && op.v === "TJ") {
        showArray(i + 1, j);
        i = j + 1;
        operands.length = 0;
        continue;
      }
      i = j;
      operands.length = 0;
      continue;
    }

    if (t.k !== "op") {
      operands.push(t);
      if (operands.length > 16) operands.shift();
      continue;
    }

    switch (t.v) {
      case "BT":
        lineY = null;
        break;
      case "ET":
        newline(em);
        lineY = null;
        break;
      case "Tf": {
        const nameTok = operands[operands.length - 2];
        if (nameTok !== undefined && nameTok.k === "name") font = resolveFont(nameTok.v);
        break;
      }
      case "TL":
        leading = nums(1)[0];
        break;
      case "Td": {
        const [, ty] = nums(2);
        moveTo((lineY ?? 0) + ty);
        break;
      }
      case "TD": {
        const [, ty] = nums(2);
        leading = -ty;
        moveTo((lineY ?? 0) + ty);
        break;
      }
      case "Tm": {
        const v = nums(6);
        moveTo(v[5]);
        break;
      }
      case "T*":
        moveTo((lineY ?? 0) - leading);
        break;
      case "Tj": {
        const s = operands[operands.length - 1];
        if (s !== undefined && s.k === "str") showString(s.v);
        break;
      }
      case "'": {
        moveTo((lineY ?? 0) - leading);
        const s = operands[operands.length - 1];
        if (s !== undefined && s.k === "str") showString(s.v);
        break;
      }
      case '"': {
        moveTo((lineY ?? 0) - leading);
        const s = operands[operands.length - 1];
        if (s !== undefined && s.k === "str") showString(s.v);
        break;
      }
      case "Do": {
        if (depth >= MAX_XOBJECT_DEPTH || xobjects === undefined) break;
        const nameTok = operands[operands.length - 1];
        if (nameTok === undefined || nameTok.k !== "name") break;
        const xo = lookStream(xobjects, nameTok.v);
        if (xo === undefined) break;
        if (lookName(xo.dict, "Subtype") !== "/Form") break;
        const bytes = decodeStreamBytes(xo);
        if (bytes === undefined) break;
        const formRes = lookDict(xo.dict, "Resources") ?? resources;
        runContent(bytes, formRes, em, depth + 1, fontCache);
        break;
      }
      default:
        break;
    }

    operands.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function pageContentBytes(contents: PDFStream | PDFArray | undefined): Uint8Array[] {
  if (contents === undefined) return [];
  if (contents instanceof PDFArray) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < contents.size(); i++) {
      const el = contents.lookup(i);
      if (el instanceof PDFStream) {
        const b = decodeStreamBytes(el);
        if (b !== undefined) parts.push(b);
      }
    }
    return parts;
  }
  const b = decodeStreamBytes(contents);
  return b === undefined ? [] : [b];
}

/**
 * Precomposed ligatures -> the letters they stand for.
 *
 * These reach us through a font's ToUnicode CMap (a WinAnsi or /Differences
 * route is already decomposed by GLYPH_NAMES). They are typesetting artefacts,
 * not content: the page reads "notification" and the model quotes
 * "notification", so leaving U+FB01 in the extracted text marks a correct
 * citation UNVERIFIED. CLAUDE.md §Provenance is explicit that a false
 * "unverified" costs as much trust as a false "verified", and serif legal
 * documents produce these constantly.
 */
const LIGATURES: Readonly<Record<string, string>> = {
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
};

/** Soft hyphen, zero-width space/non-joiner/joiner, BOM. */
const INVISIBLE = /[\u00ad\u200b\u200c\u200d\ufeff]/g;

/**
 * Collapses the runs of whitespace the layout heuristic inevitably produces,
 * and removes the invisible characters that would otherwise sit inside a quote
 * and break an exact match: soft hyphens (a hint about where a word MAY break,
 * with no glyph), zero-width spaces, and BOMs.
 */
function tidy(s: string): string {
  return s
    .replace(/[\ufb00-\ufb06]/g, (c) => LIGATURES[c] ?? c)
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPages(bytes: Uint8Array): Promise<ExtractionReport> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  const pages: PageText[] = [];
  const emptyPages: number[] = [];
  const fontCache = new Map<PDFDict, FontInfo>();

  const list = doc.getPages();
  for (let idx = 0; idx < list.length; idx++) {
    const leaf = list[idx].node;
    const em: Emitter = { out: [], lastY: null, lastWasSpace: true };
    const resources = leaf.Resources();

    for (const chunk of pageContentBytes(leaf.Contents())) {
      try {
        runContent(chunk, resources, em, 0, fontCache);
      } catch {
        // A malformed content stream costs us one page, not the document.
      }
    }

    const text = tidy(em.out.join(""));
    const page = idx + 1;
    if (text.length === 0) emptyPages.push(page);
    pages.push({ page, text });
  }

  return { pages, emptyPages };
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

/**
 * Renders pages as the `[[page N]]`-marked plain text the model consumes.
 *
 * The marker is written on its own line, which is what `parsePageMarked` in
 * @wf/shared requires. That function is the ONLY reader of this format — the
 * worker writes it and the web app resolves citations back through it, and a
 * second local copy would eventually drift from this producer.
 */
export function renderPageMarked(pages: PageText[]): string {
  return pages.map((p) => `${PAGE_MARKER(p.page)}\n${defuseMarkers(p.text)}`).join("\n\n");
}

/**
 * A page's OWN text can contain a line that looks like a page marker — a filing
 * that quotes this format, or a document crafted to forge provenance. Left
 * alone, `parsePageMarked` reads it as a real marker and invents a page that
 * does not exist in the PDF: a two-page document acquires a "page 50", the
 * model cites page 50, and the verifier finds the quote there and sets
 * `verified: true`. That is precisely the guarantee the citation mechanism
 * exists to make — a verified page number is a fact — so the marker vocabulary
 * has to be reserved for the extractor.
 *
 * Indenting the offending line by one space is enough: `parsePageMarked`
 * anchors its regex to the start of a line, while both the model's echo and the
 * verifier run every comparison through `normalizeForMatch`, which collapses
 * whitespace — so the text stays quotable and verifiable, character for
 * character, and the page numbering stays ours. Idempotent: re-rendering
 * already-defused text changes nothing.
 */
const EMBEDDED_MARKER = /^(\[\[page \d+\]\])$/gm;

function defuseMarkers(text: string): string {
  return text.replace(EMBEDDED_MARKER, " $1");
}

// Referenced so the import stays honest about what a PDF string can be; both
// types show up when reading document metadata for filenames.
export type PdfTextual = PDFString | PDFHexString;
