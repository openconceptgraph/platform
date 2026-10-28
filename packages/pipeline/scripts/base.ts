// The base pipeline, run against one subject's folder in a base repository.
//
//   pnpm base mint <dir>                        give new objects their IDs and statements their codes
//   pnpm base check <dir> --pdf <file> [--document <name>]
//                                               check the transcription word for word against its PDF
//   pnpm base import <dir>                      load the transcription into the working database
//   pnpm base draft <file>                      load an AI draft (concepts, links, mistakes) as proposed
//
// <dir> is e.g. ../base-za-caps/mathematics. Paths are relative to where pnpm runs.
import path from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "@ocg/db";
import { checkBase } from "../src/check";
import { loadDraft, readDraft } from "../src/draft";
import { readBase } from "../src/files";
import { importBase } from "../src/import";
import { mintBase } from "../src/mint";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pdf: { type: "string" },
    document: { type: "string" },
  },
});

// pnpm runs package scripts from the package's folder; paths are the caller's.
const callerDir = process.env.INIT_CWD ?? process.cwd();
const at = (p: string | undefined, what: string) => {
  if (!p) throw new Error(`${what} is required`);
  return path.resolve(callerDir, p);
};

function workingDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; see .env.example");
  return createDb(url);
}

try {
  switch (positionals[0]) {
    case "mint": {
      for (const r of await mintBase(at(positionals[1], "<dir>"))) {
        if (r.ids || r.codes) console.log(`${path.relative(callerDir, r.file)}: ${r.ids} IDs, ${r.codes} codes`);
      }
      break;
    }
    case "check": {
      const base = await readBase(at(positionals[1], "<dir>"));
      const documents = o.document ? [o.document] : base.documents.filter((d) => d.data.pdf).map((d) => d.name);
      let errors = 0;
      for (const document of documents) {
        const findings = await checkBase(base, document, at(o.pdf, "--pdf"));
        for (const f of findings) console.log(`${f.level === "error" ? "✗" : "!"} ${f.where}: ${f.message}`);
        errors += findings.filter((f) => f.level === "error").length;
        const topics = base.topics.filter((t) => t.data.document === document).length;
        console.log(`${document}: ${topics} topic files, ${errors} errors, ${findings.length - errors} warnings`);
      }
      process.exitCode = errors > 0 ? 1 : 0;
      break;
    }
    case "import": {
      const db = workingDb();
      try {
        const report = await importBase(db, await readBase(at(positionals[1], "<dir>")));
        for (const [what, c] of Object.entries(report)) {
          console.log(`${what}: ${c.added} added, ${c.changed} changed, ${c.unchanged} unchanged`);
        }
      } finally {
        await db.close();
      }
      break;
    }
    case "draft": {
      const draft = await readDraft(at(positionals[1], "<file>"));
      const db = workingDb();
      try {
        const r = await loadDraft(db, draft);
        console.log(`${r.families} families, ${r.concepts} concepts, ${r.misconceptions} typical mistakes (${r.unsourcedMistakes} unsourced)`);
        console.log(`links: ${Object.entries(r.links).map(([t, n]) => `${n} ${t}`).join(", ")}`);
        if (r.notInDraft.length) console.log(`! in the database but not in this draft, left alone: ${r.notInDraft.join(", ")}`);
      } finally {
        await db.close();
      }
      break;
    }
    default:
      console.error("Usage: pnpm base mint|check|import <dir> | pnpm base draft <file>");
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
