import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { type BaseFiles, columns, readBase } from "./files";

// Gives every object in a base's files a permanent ID, and every statement a
// code, where they have none yet. Never changes one that exists: an ID is the
// object's identity, and a code, once seen by reviewers, is how they refer to it.

type Json = Record<string, unknown>;

export interface MintResult {
  file: string;
  ids: number;
  codes: number;
}

export async function mintBase(dir: string, mint: () => string = randomUUID): Promise<MintResult[]> {
  // Validate first, so a malformed file is reported, not rewritten.
  const base = await readBase(dir);
  const results: MintResult[] = [];
  for (const { file, kind, topic } of filesOf(base)) {
    const raw = JSON.parse(await readFile(file, "utf8")) as Json;
    const count = { ids: 0, codes: 0 };
    const withId = (o: Json): Json => {
      if (o.id) return o;
      count.ids++;
      return { id: mint(), ...o };
    };

    let out: Json;
    if (kind === "framework") {
      out = withId(raw);
      out.educationLevels = (raw.educationLevels as Json[]).map(withId);
    } else if (kind === "document") {
      const nodes = (ns: Json[]): Json[] =>
        ns.map((n) => {
          const m = withId(n);
          if (Array.isArray(n.children)) m.children = nodes(n.children as Json[]);
          return m;
        });
      out = withId(raw);
      out.nodes = nodes(raw.nodes as Json[]);
    } else if (kind === "plan") {
      out = withId(raw);
      out.placements = (raw.placements as Json[]).map(withId);
    } else {
      out = { ...raw };
      for (const column of columns) {
        if (!Array.isArray(raw[column])) continue;
        const prefix = `${topic!.grade}/${topic!.topic}/${column === "concepts" ? "c" : "n"}`;
        let next = 1 + Math.max(0, ...existingCodes(raw[column] as Json[], prefix));
        const statements = (ss: Json[]): Json[] =>
          ss.map((s) => {
            let m = s;
            if (!s.code) {
              count.codes++;
              const { id, ...rest } = s;
              m = { ...(id ? { id } : {}), code: `${prefix}${String(next++).padStart(2, "0")}`, ...rest };
            }
            m = withId(m);
            if (Array.isArray(s.children)) m.children = statements(s.children as Json[]);
            return m;
          });
        out[column] = (raw[column] as Json[]).map((g) => ({ ...g, statements: statements(g.statements as Json[]) }));
      }
    }

    if (count.ids || count.codes) {
      await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
    }
    results.push({ file, ...count });
  }
  // The rewritten files must still read back.
  await readBase(dir);
  return results;
}

function filesOf(base: BaseFiles) {
  return [
    { file: base.framework.file, kind: "framework" as const },
    ...base.documents.map((d) => ({ file: d.file, kind: "document" as const })),
    ...base.teachingPlans.map((p) => ({ file: p.file, kind: "plan" as const })),
    ...base.topics.map((t) => ({ file: t.file, kind: "topic" as const, topic: t.data })),
  ] as { file: string; kind: "framework" | "document" | "plan" | "topic"; topic?: { grade: string; topic: string } }[];
}

/** The numbers of codes already given in a column, so new ones follow on. */
function existingCodes(groups: Json[], prefix: string): number[] {
  const out: number[] = [];
  const walk = (ss: Json[]) => {
    for (const s of ss) {
      const code = s.code;
      if (typeof code === "string" && code.startsWith(prefix)) out.push(Number(code.slice(prefix.length)) || 0);
      if (Array.isArray(s.children)) walk(s.children as Json[]);
    }
  };
  for (const g of groups) walk(g.statements as Json[]);
  return out;
}
