// The base pipeline, run against one subject's folder in a base repository.
//
//   pnpm base mint <dir>                        give new objects their IDs and statements their codes
//   pnpm base check <dir> --pdf <file> [--document <name>]
//                                               check the transcription word for word against its PDF
//   pnpm base import <dir>                      load the transcription into the working database
//   pnpm base draft <file>                      load an AI draft (concepts, links, mistakes) as proposed
//   pnpm base check ... --record                also record the machine check of each clean document
//   pnpm base signoff <dir> --document <name> --pages 75-77,79 --by "<public name>" [--on YYYY-MM-DD]
//                                               record a person's check of printed pages
//   pnpm base release <dir> --version 0.1.0 --out <folder> [--previous <folder>] [--released YYYY-MM-DD]
//                                               build a release from the working database, then validate it
//
// <dir> is e.g. ../base-za-caps/mathematics. Paths are relative to where pnpm runs.
import path from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "@ocg/db";
import { spawnSync } from "node:child_process";
import { checkBase } from "../src/check";
import { parsePages, recordCheck } from "../src/checks";
import { loadDraft, readDraft } from "../src/draft";
import { readBase } from "../src/files";
import { importBase } from "../src/import";
import { mintBase } from "../src/mint";
import { buildRelease, readReleaseConfig, specValidator, writeRelease } from "../src/release";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pdf: { type: "string" },
    document: { type: "string" },
    record: { type: "boolean" },
    pages: { type: "string" },
    by: { type: "string" },
    on: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
    previous: { type: "string" },
    released: { type: "string" },
  },
});

// pnpm runs package scripts from the package's folder; paths are the caller's.
const callerDir = process.env.INIT_CWD ?? process.cwd();
const at = (p: string | undefined, what: string) => {
  if (!p) throw new Error(`${what} is required`);
  return path.resolve(callerDir, p);
};

/** Today's date in South Africa, where the steward works: YYYY-MM-DD. */
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
}

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
      // By default, every document with statements transcribed from it.
      const transcribed = (name: string) => base.topics.some((t) => t.data.document === name);
      const documents = o.document ? [o.document] : base.documents.filter((d) => d.data.pdf && transcribed(d.name)).map((d) => d.name);
      let errors = 0;
      for (const document of documents) {
        const findings = await checkBase(base, document, at(o.pdf, "--pdf"));
        for (const f of findings) console.log(`${f.level === "error" ? "✗" : "!"} ${f.where}: ${f.message}`);
        errors += findings.filter((f) => f.level === "error").length;
        const topics = base.topics.filter((t) => t.data.document === document).length;
        console.log(`${document}: ${topics} topic files, ${errors} errors, ${findings.length - errors} warnings`);
      }
      process.exitCode = errors > 0 ? 1 : 0;
      if (o.record && errors === 0) {
        const db = workingDb();
        try {
          for (const document of documents) {
            const doc = base.documents.find((d) => d.name === document)!;
            await recordCheck(db, { frameworkSlug: base.framework.data.slug, documentTitle: doc.data.title, method: "machine", on: today() });
            console.log(`${document}: machine check recorded`);
          }
        } finally {
          await db.close();
        }
      } else if (o.record) {
        console.log("Not recorded: the check found errors");
      }
      break;
    }
    case "signoff": {
      const base = await readBase(at(positionals[1], "<dir>"));
      const doc = base.documents.find((d) => d.name === o.document);
      if (!doc) throw new Error(`--document must name one of: ${base.documents.map((d) => d.name).join(", ")}`);
      const pages = parsePages(o.pages ?? "");
      const db = workingDb();
      try {
        await recordCheck(db, { frameworkSlug: base.framework.data.slug, documentTitle: doc.data.title, method: "person", pages, on: o.on ?? today(), by: o.by });
        console.log(`${doc.name}: pages ${pages.join(", ")} checked by ${o.by}, recorded`);
      } finally {
        await db.close();
      }
      break;
    }
    case "release": {
      const dir = at(positionals[1], "<dir>");
      const base = await readBase(dir);
      const out = at(o.out, "--out");
      if (!o.version) throw new Error("--version is required");
      const db = workingDb();
      try {
        const release = await buildRelease(db, base.framework.data.slug, await readReleaseConfig(dir), {
          version: o.version,
          released: o.released ?? today(),
          previousDir: o.previous ? at(o.previous, "--previous") : undefined,
        });
        await writeRelease(out, release);
        const f = release.files as Record<string, unknown[]>;
        const shown = path.relative(callerDir, out);
        console.log(`${base.framework.data.slug} ${o.version} written to ${shown.startsWith("..") ? out : shown || "."}:`);
        console.log(`  ${f.statements!.length} statements; ${f.concepts!.length} concepts, ${f.misconceptions!.length} typical mistakes, ${f.links!.length} links confirmed`);
      } finally {
        await db.close();
      }
      const cli = specValidator();
      if (!cli) {
        console.log("! Not validated: no built spec checkout found (set OCG_SPEC_DIR, or build ../spec)");
        break;
      }
      const v = spawnSync(process.execPath, [cli, "release", out], { encoding: "utf8" });
      process.stdout.write(v.stdout);
      process.stderr.write(v.stderr);
      process.exitCode = v.status ?? 1;
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
        console.log(`${r.families} families, ${r.concepts} concepts with ${r.levels} levels, ${r.misconceptions} typical mistakes (${r.unsourcedMistakes} unsourced)`);
        console.log(`links: ${Object.entries(r.links).map(([t, n]) => `${n} ${t}`).join(", ")}`);
        if (r.notInDraft.length) console.log(`! in the database but not in this draft, left alone: ${r.notInDraft.join(", ")}`);
      } finally {
        await db.close();
      }
      break;
    }
    default:
      console.error("Usage: pnpm base mint|check|import|signoff|release <dir> | pnpm base draft <file>");
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
