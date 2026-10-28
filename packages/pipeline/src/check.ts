import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { allNodes, type BaseFiles, type DocumentFile, type Loaded, type StatementFile, type TopicFile, topicStatements } from "./files";

// Checks a transcription against the PDF it was made from, word for word.
//
// Each statement, heading and label must appear in the PDF's own text layer
// for its pages: the same characters in the same order, case, signs and all.
// Only spacing, list markers and layout are ignored, and notation is compared
// in its plain form (2³ reads as 23), because that is how the text layer holds
// it. Then every run of text on those pages that nothing accounts for is
// reported, so an omission shows up as surely as an addition.

export interface Finding {
  level: "error" | "warning";
  where: string;
  message: string;
}

/**
 * Every printed character but spacing, after Unicode compatibility folding
 * (2³ reads as 23), with each kept character's place in the original. Signs
 * matter in mathematics, so they are kept: dashes of every width count as one
 * minus sign, and curly quotes as straight ones.
 */
export function normalise(s: string): { chars: string; at: number[] } {
  let chars = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    // A cube or fourth root's index is printed as a small digit in the text layer.
    const folded = ch === "∛" ? "3√" : ch === "∜" ? "4√" : ch.normalize("NFKC");
    for (const f of folded) {
      // Spacing, and the fraction slash a transcription writes for a printed fraction line.
      if (/\s/u.test(f) || f === "\u2044") continue;
      chars += /[\u2010-\u2015\u2212-]/u.test(f) ? "-" : /[\u2018\u2019]/u.test(f) ? "'" : /[\u201C\u201D]/u.test(f) ? '"' : f;
      at.push(i);
    }
    i += ch.length;
  }
  return { chars, at };
}

/** List markers at the start of a printed line: bullets, which a transcription leaves out, and letters such as "a)", which it keeps but which are not checked. */
const marker = /^(\s*)(•|--|-|♦♦|♦|[a-z]\))(\s+|$)/gmu;
/** A letter such as "a)" opening a transcribed line. */
const letter = /^[a-z]\)\s+/u;

/**
 * A transcription with the brackets it writes for printed layout taken out:
 * a bracket straight after a root sign, or round a numerator or denominator
 * beside the fraction slash, stands for the root's bar or the fraction line,
 * which the text layer does not hold. Other brackets are printed and stay.
 */
export function withoutLayoutBrackets(s: string): string {
  const chars = [...s];
  const drop = new Set<number>();
  const stack: number[] = [];
  const partner = new Map<number, number>();
  chars.forEach((ch, i) => {
    if (ch === "(") stack.push(i);
    else if (ch === ")" && stack.length) partner.set(stack.pop()!, i);
  });
  for (const [open, close] of partner) {
    const before = chars[open - 1];
    if (before === "√" || before === "∛" || before === "∜" || before === "\u2044" || chars[close + 1] === "\u2044") {
      drop.add(open);
      drop.add(close);
    }
  }
  return chars.filter((_, i) => !drop.has(i)).join("");
}

/** Root signs, whose index the text layer may hold apart from its line. */
function rootCount(s: string): number {
  return [...s].filter((ch) => ch === "√" || ch === "∛" || ch === "∜").length;
}

interface Match {
  pieces: [number, number][];
  /** Pieces that could only be placed on text another statement already holds. */
  claimed: number;
  /** Who holds it. */
  holders: string[];
  missing?: string;
}

/** Raised and lowered characters: ², ᵐ, ⁺, ₙ. A text layer may hold them apart from their line. */
const raised = /[\u00B2\u00B3\u00B9\u2070-\u209F\u1D2C-\u1D6A\u02B0-\u02FF]/u;

interface Page {
  printed: number;
  text: string;
  /** Where this page starts in the topic's combined stream. */
  offset: number;
}

class Stream {
  readonly chars: string;
  readonly covered: Uint8Array;
  /** Who accounts for each character: an index into `owners`. */
  private readonly owner: Int32Array;
  private readonly owners: string[] = [];
  private readonly at: number[];
  private readonly origin: string;

  constructor(readonly pages: Page[]) {
    let origin = "";
    for (const p of pages) {
      p.offset = origin.length;
      origin += `${withoutPageNumber(p.text, p.printed).replace(marker, "$1")}\n`;
    }
    const n = normalise(origin);
    this.chars = n.chars;
    this.at = n.at;
    this.origin = origin;
    this.covered = new Uint8Array(n.chars.length);
    this.owner = new Int32Array(n.chars.length).fill(-1);
  }

  /** Who already accounts for any of [a, b). */
  heldBy(a: number, b: number): string[] {
    return [...new Set([...this.owner.subarray(a, b)].filter((o) => o >= 0).map((o) => this.owners[o]!))];
  }

  /**
   * Marks a piece of furniture on each page where it stands on a line of its
   * own, as running heads and headings do: every occurrence of a long one, and only
   * the first not yet accounted for of a short one, so that "1.1" does not
   * hide the 11 in 110, nor a code that is not printed take a digit.
   */
  coverFurniture(text: string) {
    const t = normalise(text).chars;
    if (!t) return;
    for (const [start, end] of this.pageRanges()) {
      for (let i = this.chars.indexOf(t, start); i >= 0 && i + t.length <= end; i = this.chars.indexOf(t, i + 1)) {
        if (!this.onItsOwnLine(i, i + t.length)) continue;
        if (t.length < 6 && this.covered.subarray(i, i + t.length).some((c) => c === 1)) continue;
        this.covered.fill(1, i, i + t.length);
        if (t.length < 6) break;
      }
    }
  }

  /** Each page's range in the normalised stream. */
  private pageRanges(): [number, number][] {
    const starts = this.pages.map((p) => {
      const i = this.at.findIndex((a) => a >= p.offset);
      return i < 0 ? this.chars.length : i;
    });
    return starts.map((s, k) => [s, starts[k + 1] ?? this.chars.length]);
  }

  /**
   * Finds a transcribed text in order, in as few pieces as possible: each
   * piece the longest stretch found anywhere on the topic's pages from where
   * the last one ended. The pieces are then placed longest first, each where
   * it is not yet accounted for, never overlapping another piece of the text,
   * and nearest a piece already placed (the first: nearest `near`). So short
   * pieces ("b)", a root's index) and repeated headings find their own place
   * whatever order the text layer holds them in. Returns the pieces in the
   * text's order, or the part not found.
   */
  match(
    text: string,
    near?: number,
    opts: { scope?: [number, number]; alone?: boolean; dryRun?: boolean; by?: string; fromEnd?: boolean } = {},
  ): Match {
    const t = normalise(text).chars;
    const scope = opts.scope ?? [0, this.chars.length];
    const alone = opts.alone ?? false;
    const parts: [number, number][] = [];
    if (alone) {
      if (this.occurrences(t, [], false, scope, true).next().done) return { pieces: [], claimed: 0, holders: [], missing: t };
      parts.push([0, t.length]);
    } else if (opts.fromEnd) {
      // Cut from the end: the longest stretch that ends where the last one began.
      for (let j = t.length; j > 0; ) {
        const len = this.longestBack(t, j, scope);
        if (len === 0) return { pieces: [], claimed: 0, holders: [], missing: t.slice(Math.max(0, j - 24), j) };
        parts.unshift([j - len, j]);
        j -= len;
      }
    } else {
      for (let i = 0; i < t.length; ) {
        const len = this.longest(t, i, scope);
        if (len === 0) return { pieces: [], claimed: 0, holders: [], missing: t.slice(i, i + 24) };
        parts.push([i, i + len]);
        i += len;
      }
    }

    const at: number[] = parts.map(() => -1);
    const size = (k: number) => parts[k]![1] - parts[k]![0];
    const order = parts.map((_, k) => k).sort((a, b) => size(b) - size(a) || a - b);
    let claimed = 0;
    const holders: string[] = [];
    for (const k of order) {
      const piece = t.slice(parts[k]![0], parts[k]![1]);
      const taken = at.flatMap((p, j) => (p < 0 ? [] : [[p, p + size(j)] as [number, number]]));
      const ref = this.neighbour(at, size, k) ?? near ?? 0;
      // A text found whole is best where it stands as a line of its own, as
      // printed, rather than inside a longer sentence that repeats it.
      let p = parts.length === 1 && !alone ? this.place(piece, taken, ref, true, scope, "line") : -1;
      if (p < 0) p = this.place(piece, taken, ref, true, scope, alone);
      if (p < 0) {
        claimed++;
        p = this.place(piece, taken, ref, false, scope, alone);
        if (p < 0) p = this.place(piece, [], ref, false, scope, alone);
        holders.push(...this.heldBy(p, p + piece.length));
      }
      at[k] = p;
    }
    const pieces = parts.map((_, k) => [at[k]!, at[k]! + size(k)] as [number, number]);
    if (!opts.dryRun) {
      const who = this.owners.push(opts.by ?? "") - 1;
      for (const [a, b] of pieces) {
        this.covered.fill(1, a, b);
        this.owner.fill(who, a, b);
      }
    }
    return { pieces, claimed, holders: [...new Set(holders)] };
  }

  /**
   * Where the nearest already placed piece of the text sits (the end of one
   * before, the start of one after); of two equally near, the longer.
   */
  private neighbour(at: number[], size: (k: number) => number, k: number): number | undefined {
    for (let d = 1; d < at.length; d++) {
      const options: [number, number][] = [];
      const before = at[k - d];
      if (before !== undefined && before >= 0) options.push([size(k - d), before + size(k - d)]);
      const after = at[k + d];
      if (after !== undefined && after >= 0) options.push([size(k + d), after]);
      if (options.length) return options.sort((x, y) => y[0] - x[0])[0]![1];
    }
    return undefined;
  }

  /**
   * Occurrences of a piece within the scope that overlap none of `taken`; if
   * `free`, not yet accounted for; if `alone`, standing on their own in the
   * text layer, with spacing on either side.
   */
  private *occurrences(piece: string, taken: [number, number][], free: boolean, [lo, hi]: [number, number], alone: boolean | "line" = false) {
    for (let i = this.chars.indexOf(piece, lo); i >= 0 && i + piece.length <= hi; i = this.chars.indexOf(piece, i + 1)) {
      if (taken.some(([a, b]) => i < b && i + piece.length > a)) continue;
      if (free && this.covered.subarray(i, i + piece.length).some((c) => c === 1)) continue;
      const gap = alone === "line" ? /\n/u : /\s/u;
      if (alone && !(this.gapBefore(i, gap) && this.gapBefore(i + piece.length, gap))) continue;
      yield i;
    }
  }

  /** Whether [a, b) is a line of its own in the text layer. */
  private onItsOwnLine(a: number, b: number): boolean {
    return this.gapBefore(a, /\n/u) && this.gapBefore(b, /\n/u);
  }

  /** Whether [a, b) stands on its own in the text layer, with spacing on either side. */
  standsAlone(a: number, b: number): boolean {
    return this.gapBefore(a, /\s/u) && this.gapBefore(b, /\s/u);
  }

  /** Whether a gap of this kind (spacing, a line break), or the start or end of the text, comes before the character at `i`. */
  private gapBefore(i: number, gap: RegExp): boolean {
    if (i <= 0 || i >= this.chars.length) return true;
    return gap.test(this.origin.slice(this.at[i - 1]! + 1, this.at[i]!));
  }

  /** The longest stretch of `t` from `i` that occurs within the scope. */
  private longest(t: string, i: number, [lo, hi]: [number, number]): number {
    const within = this.chars.slice(Math.max(0, lo), hi);
    let a = 0;
    let b = t.length - i;
    while (a < b) {
      const mid = Math.ceil((a + b) / 2);
      if (within.includes(t.substr(i, mid))) a = mid;
      else b = mid - 1;
    }
    return a;
  }

  /**
   * Takes a text's characters one by one, each the nearest to the last that
   * is not yet accounted for: for a text checked by eye, whose order the text
   * layer does not keep. Returns the characters it could not find.
   */
  takeChars(text: string, scopes: [number, number][], near: number, by: string): { missing: string; holders: string[] } {
    const who = this.owners.push(by) - 1;
    let missing = "";
    const holders = new Set<string>();
    const [lo, hi] = [Math.min(...scopes.map((r) => r[0])), Math.max(...scopes.map((r) => r[1]))];
    for (const ch of normalise(text).chars) {
      // From the first scope that has one free (its own page, then the next), the nearest.
      let best = -1;
      for (const [a, b] of scopes) {
        for (let i = this.chars.indexOf(ch, Math.max(0, a)); i >= 0 && i < b; i = this.chars.indexOf(ch, i + 1)) {
          if (!this.covered[i] && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
        }
        if (best >= 0) break;
      }
      if (best < 0) {
        missing += ch;
        for (let i = this.chars.indexOf(ch, Math.max(0, lo)); i >= 0 && i < hi; i = this.chars.indexOf(ch, i + 1)) {
          if (Math.abs(i - near) < 80) this.heldBy(i, i + 1).forEach((h) => holders.add(h));
        }
        continue;
      }
      this.covered[best] = 1;
      this.owner[best] = who;
      near = best;
    }
    return { missing, holders: [...holders] };
  }

  /** The longest stretch of `t` ending at `j` that occurs within the scope. */
  private longestBack(t: string, j: number, [lo, hi]: [number, number]): number {
    const within = this.chars.slice(Math.max(0, lo), hi);
    let a = 0;
    let b = j;
    while (a < b) {
      const mid = Math.ceil((a + b) / 2);
      if (within.includes(t.slice(j - mid, j))) a = mid;
      else b = mid - 1;
    }
    return a;
  }

  /** The stream range of the printed page that holds character `index`. */
  pageRangeAt(index: number): [number, number] {
    const page = this.pageAt(index);
    const ranges = this.pageRanges();
    return ranges[this.pages.findIndex((p) => p.printed === page)]!;
  }

  /** The occurrence nearest `ref`; -1 if there is none. */
  private place(piece: string, taken: [number, number][], ref: number, free: boolean, scope: [number, number], alone: boolean | "line"): number {
    let best = -1;
    for (const i of this.occurrences(piece, taken, free, scope, alone)) {
      if (best < 0 || Math.abs(i - ref) < Math.abs(best - ref)) best = i;
    }
    return best;
  }

  /**
   * The stream range of a printed page, and with `andNext` the one after it,
   * where a statement said to start on that page may run on to.
   */
  pageScope(printed: number, andNext = true): [number, number] | undefined {
    const ranges = this.pageRanges();
    const k = this.pages.findIndex((p) => p.printed === printed);
    if (k < 0) return undefined;
    return [ranges[k]![0], ((andNext && ranges[k + 1]) || ranges[k]!)[1]];
  }

  /** What is accounted for so far, and by whom, to try a match and take it back. */
  save(): { covered: Uint8Array; owner: Int32Array } {
    return { covered: this.covered.slice(), owner: this.owner.slice() };
  }

  restore(saved: { covered: Uint8Array; owner: Int32Array }) {
    this.covered.set(saved.covered);
    this.owner.set(saved.owner);
  }

  pageAt(index: number): number {
    const at = this.at[index] ?? 0;
    let page = this.pages[0]!.printed;
    for (const p of this.pages) if (p.offset <= at) page = p.printed;
    return page;
  }

  /** Runs of characters that nothing has accounted for, as printed: even one, since a dropped sign matters. */
  uncovered(): { page: number; text: string }[] {
    const out: { page: number; text: string }[] = [];
    for (let i = 0; i < this.chars.length; ) {
      if (this.covered[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < this.chars.length && !this.covered[j]) j++;
      const from = this.at[i]!;
      const to = this.at[j - 1]! + 1;
      let snippet = this.origin.slice(from, to).replace(/\s+/g, " ");
      if (snippet.length > 100) snippet = `${snippet.slice(0, 97)}...`;
      // A few characters are found more easily with what stands around them.
      if (j - i < 4) {
        const around = (s: string) => s.replace(/\s+/g, " ").trim();
        snippet = `${snippet}" in "…${around(this.origin.slice(Math.max(0, from - 20), from))}[${snippet}]${around(this.origin.slice(to, to + 20))}…`;
      }
      out.push({ page: this.pageAt(i), text: snippet });
      i = j;
    }
    return out;
  }
}

interface Line {
  statement: StatementFile;
  /** The line as transcribed, and as matched: without a list letter such as "a)". */
  printed: string;
  text: string;
  /** Where to look first: its stated page and the next, if the line is there at all. */
  scope?: [number, number];
}

/** Whether a match is word for word: one or two pieces (a page break), more only for a root's index; none on text another statement holds. */
function verdict(stream: Stream, m: Match, text: string): string | undefined {
  const allowed = 2 * rootCount(text);
  // A short piece inside a word, or a lone character, is a sign of
  // characters found scattered; a short phrase standing on its own, like
  // "or x" set as a block of its own, is not.
  const short = m.pieces.filter(([a, b]) => b - a < 4 && (b - a < 2 || !stream.standsAlone(a, b))).length;
  if (m.claimed > 0) return `"${text.slice(0, 40)}" is found only where ${m.holders.join(", ") || "another statement"} already is`;
  if (m.pieces.length > 2 + allowed || short > allowed) {
    return `not word for word: "${text.slice(0, 40)}" found only as ${m.pieces.length} scattered pieces (${m.pieces.map(([a, b]) => stream.chars.slice(a, b)).join(" | ").slice(0, 100)})`;
  }
  return undefined;
}

const label = (line: Line) => line.statement.code ?? `"${line.printed.slice(0, 30)}"`;

const longestPiece = (m: Match) => m.pieces.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x))[0];

/** The line as printed, word for word; or nothing, leaving the text as it was. */
function matchWhole(stream: Stream, line: Line): number | undefined {
  for (const fromEnd of [false, true]) {
    const saved = stream.save();
    const m = stream.match(line.text, undefined, { scope: line.scope, by: label(line), fromEnd });
    if (!m.missing && !verdict(stream, m, line.text)) return longestPiece(m);
    stream.restore(saved);
  }
  return undefined;
}

/**
 * The line with its raised characters apart, as a text layer may hold them:
 * the rest of the line word for word, and each run of raised characters
 * standing on its own nearby. Or nothing, leaving the text as it was.
 */
function matchApart(stream: Stream, line: Line): number | undefined {
  if (!raised.test(line.text)) return undefined;
  const base = [...line.text].filter((ch) => !raised.test(ch)).join("");
  const runs = line.text.match(new RegExp(`${raised.source}+`, "gu")) ?? [];
  for (const fromEnd of [false, true]) {
    const saved = stream.save();
    const rest = stream.match(base, undefined, { scope: line.scope, by: label(line), fromEnd });
    if (!rest.missing && !verdict(stream, rest, base)) {
      // Each run of raised characters on its own, on the same page.
      const near = longestPiece(rest);
      const page = stream.pageRangeAt(near);
      const placed = runs.every((run) => {
        const m = stream.match(run, near, { scope: page, alone: true, by: label(line) });
        return !m.missing && m.claimed === 0;
      });
      if (placed) return near;
    }
    stream.restore(saved);
  }
  return undefined;
}

/** The printed page number stands on a line of its own; it is not the page's content. */
function withoutPageNumber(text: string, printed: number): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== String(printed))
    .join("\n");
}

/**
 * Checks one topic file against the text of its pages, keyed by printed page.
 * Furniture is text on every page that is not content: running heads, column
 * headings, the document's own headings.
 */
export function checkTopic(
  topic: Loaded<TopicFile>,
  pageTexts: Map<number, string>,
  furniture: string[],
): Finding[] {
  const findings: Finding[] = [];
  const pages = topic.data.pages.map((printed) => {
    const text = pageTexts.get(printed);
    if (text === undefined) throw new Error(`${topic.name}: no text for page ${printed}`);
    return { printed, text, offset: 0 };
  });
  const stream = new Stream(pages);

  const where = (code: string | undefined, text: string) => `${topic.name} ${code ?? ""} "${text.slice(0, 50)}"`.replace("  ", " ");
  // Statements first: their long texts find their own place; headings and
  // labels, being short, then take what is left.
  const placed = topicStatements(topic.data);
  // Line by line, since the text layer may hold each printed line as a block
  // of its own, in any order; and in rounds, so that lines found word for word
  // take their own text before lines whose notation is held apart, and those
  // before lines only checked by eye, which may be found in scattered pieces.
  const lines: Line[] = placed.flatMap(({ statement }) =>
    statement.text.split("\n").map((printed) => {
      const text = withoutLayoutBrackets(printed.replace(letter, ""));
      const scope = stream.pageScope(statement.page);
      const onPage = scope && !stream.match(text, undefined, { scope, dryRun: true }).missing;
      return { statement, printed, text, scope: onPage ? scope : undefined };
    }),
  );
  const anchors = new Map<StatementFile, number>();
  const found = (line: Line, at: number | undefined) => {
    if (at !== undefined && !anchors.has(line.statement)) anchors.set(line.statement, at);
    return at !== undefined;
  };
  const failed = new Set<StatementFile>();
  let left = lines.filter((line) => {
    const m = stream.match(line.text, undefined, { dryRun: true });
    if (m.missing) {
      if (!failed.has(line.statement)) {
        failed.add(line.statement);
        findings.push({ level: "error", where: where(line.statement.code, line.statement.text), message: `not in the PDF from "${m.missing}"` });
      }
      return false;
    }
    return true;
  });
  left = left.filter((line) => line.statement.eyeChecked || !found(line, matchWhole(stream, line)));
  left = left.filter((line) => {
    if (!found(line, matchApart(stream, line))) return true;
    if (!line.statement.eyeChecked) {
      findings.push({
        level: "warning",
        where: where(line.statement.code, line.statement.text),
        message: `"${line.printed.slice(0, 40)}": the PDF's text holds its raised characters apart; check where they stand by eye (then mark eyeChecked)`,
      });
    }
    return false;
  });
  for (const line of left.filter((l) => !l.statement.eyeChecked)) {
    const m = stream.match(line.text, undefined, { scope: line.scope, by: label(line) });
    found(line, m.pieces.length ? longestPiece(m) : undefined);
    const problem = verdict(stream, m, line.text);
    if (problem) findings.push({ level: "error", where: where(line.statement.code, line.statement.text), message: problem });
  }
  for (const { statement: s } of placed) {
    const at = anchors.get(s);
    if (at !== undefined && stream.pageAt(at) !== s.page) {
      findings.push({ level: "warning", where: where(s.code, s.text), message: `found on page ${stream.pageAt(at)}, not ${s.page}` });
    }
  }
  // Headings and labels are short and repeat, so each is looked for near the
  // statements it stands over.
  for (const [k, g] of [...topic.data.concepts, ...topic.data.notes].entries()) {
    if (!g.heading) continue;
    const first = placed.find((p) => p.group === k);
    const m = stream.match(g.heading, first ? anchors.get(first.statement) : undefined, {
      scope: first ? stream.pageScope(first.statement.page, false) : undefined,
      by: `heading "${g.heading}"`,
    });
    if (m.missing) findings.push({ level: "error", where: where("heading", g.heading), message: `not in the PDF from "${m.missing}"` });
    else if (m.claimed > 0) findings.push({ level: "error", where: where("heading", g.heading), message: `found only where ${m.holders.join(", ") || "a statement"} already is` });
  }
  // A label is printed once over a run of sibling statements that share it.
  const lastLabel = new Map<StatementFile | number, string | undefined>();
  for (const { statement: s, parent, group } of placed) {
    const siblings = parent ?? group;
    if (s.label && lastLabel.get(siblings) !== s.label) {
      const m = stream.match(s.label, anchors.get(s), { scope: stream.pageScope(s.page, false), by: `label "${s.label}" of ${s.code ?? s.text.slice(0, 30)}` });
      if (m.missing) findings.push({ level: "error", where: where(s.code, s.label), message: `label not in the PDF from "${m.missing}"` });
      else if (m.claimed > 0) findings.push({ level: "error", where: where(s.code, s.label), message: `label found only where ${m.holders.join(", ") || "a statement"} already is` });
    }
    lastLabel.set(siblings, s.label);
  }
  // Then furniture, so statements have first claim on the text; the longest
  // first, so that heading "1" does not take the start of "1.1".
  const longestFirst = [...furniture, ...topic.data.furniture].sort((a, b) => normalise(b).chars.length - normalise(a).chars.length);
  for (const f of longestFirst) stream.coverFurniture(f);
  // Last of all, lines checked by eye: their characters, taken one by one
  // from what is left on their pages. Together they must use it up exactly, so a wrong
  // character still shows, as one missing here and one left over.
  for (const line of left.filter((l) => l.statement.eyeChecked)) {
    const near = stream.match(line.text, undefined, { scope: line.scope, dryRun: true });
    const start = near.pieces.length ? longestPiece(near) : 0;
    found(line, start);
    const ownPage = stream.pageScope(line.statement.page, false);
    const scopes = [ownPage, line.scope, [0, stream.chars.length] as [number, number]].filter((r): r is [number, number] => Boolean(r));
    const { missing, holders } = stream.takeChars(line.text, line.scope ? scopes.slice(0, -1) : scopes, start, label(line));
    if (missing) {
      findings.push({
        level: "error",
        where: where(line.statement.code, line.statement.text),
        message: `checked by eye, but "${missing}" is not left on its page${holders.length ? ` (nearby, held by ${holders.join(", ")})` : ""}`,
      });
    }
  }
  for (const u of stream.uncovered()) {
    findings.push({ level: "error", where: `${topic.name} p. ${u.page}`, message: `in the PDF but not transcribed: "${u.text}"` });
  }
  return findings;
}

/** The furniture of a document: its listed furniture and its own headings (codes and titles). */
export function documentFurniture(doc: DocumentFile): string[] {
  return [...doc.furniture, ...allNodes(doc.nodes).flatMap((n) => [n.title, ...(n.code ? [n.code] : [])])];
}

const run = promisify(execFile);

/** One PDF page's text in reading order, by poppler's pdftotext. */
export async function pdfPageText(pdf: string, pdfPage: number): Promise<string> {
  const { stdout } = await run("pdftotext", ["-f", String(pdfPage), "-l", String(pdfPage), "-enc", "UTF-8", pdf, "-"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Checks every topic of a base whose document is this PDF. */
export async function checkBase(base: BaseFiles, document: string, pdf: string): Promise<Finding[]> {
  const doc = base.documents.find((d) => d.name === document);
  if (!doc) throw new Error(`no document "${document}"`);
  if (!doc.data.pdf) throw new Error(`${document}: no "pdf" entry to check against`);
  const sha256 = createHash("sha256").update(await readFile(pdf)).digest("hex");
  if (sha256 !== doc.data.pdf.sha256) {
    throw new Error(`${pdf} is not the copy ${document} was transcribed from (sha256 ${sha256})`);
  }
  const furniture = documentFurniture(doc.data);
  const findings: Finding[] = [];
  for (const topic of base.topics.filter((t) => t.data.document === document)) {
    const texts = new Map<number, string>();
    for (const printed of topic.data.pages) {
      texts.set(printed, await pdfPageText(pdf, printed + doc.data.pdf.printedPageOffset));
    }
    findings.push(...checkTopic(topic, texts, furniture));
  }
  return findings;
}
