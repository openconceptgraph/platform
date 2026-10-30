// A client's overlay in its workspace database (OVERLAY_DATABASE_URL), in and
// out as the specification's overlay bundle. Every bundle is checked with the
// specification's validator, against the pinned base release or draft when
// one is given.
//
//   pnpm overlay import <dir> [--base <release or draft dir>]
//                                     load a bundle: new records added, changed ones updated, none deleted
//   pnpm overlay export --out <dir> [--base <release or draft dir>] [--updated YYYY-MM-DD]
//                                     write the workspace's overlay as a bundle
//
// A client's overlay is the client's own, so neither is ever written inside a
// git repository. Paths are relative to where pnpm runs.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { createOverlayDb } from "../src/client";
import { exportOverlay } from "../src/export";
import { readOverlay, writeOverlay } from "../src/files";
import { importOverlay } from "../src/import";
import { insideGitRepository, specValidator } from "../src/where";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: { base: { type: "string" }, out: { type: "string" }, updated: { type: "string" } },
});

const callerDir = process.env.INIT_CWD ?? process.cwd();
const at = (p: string | undefined, what: string) => {
  if (!p) throw new Error(`${what} is required`);
  return path.resolve(callerDir, p);
};

function workspaceDb() {
  const url = process.env.OVERLAY_DATABASE_URL;
  if (!url) throw new Error("OVERLAY_DATABASE_URL is not set: the client workspace's own database");
  // A client's overlay never enters the steward's database (ADR-033).
  if (url === process.env.DATABASE_URL) throw new Error("OVERLAY_DATABASE_URL is the steward's working database; a workspace has its own");
  return createOverlayDb(url);
}

/** Checks a bundle with the specification's validator; throws if it does not conform. */
function validate(dir: string) {
  const cli = specValidator();
  if (!cli) throw new Error("No built spec checkout to validate with (set OCG_SPEC_DIR, or build ../spec)");
  const v = spawnSync(process.execPath, [cli, "overlay", dir, ...(o.base ? ["--base", at(o.base, "--base")] : [])], { encoding: "utf8" });
  process.stdout.write(v.stdout);
  process.stderr.write(v.stderr);
  if (v.status !== 0) throw new Error("The bundle does not conform to the specification");
}

try {
  switch (positionals[0]) {
    case "import": {
      const dir = at(positionals[1], "<dir>");
      validate(dir);
      const db = workspaceDb();
      try {
        const r = await importOverlay(db, await readOverlay(dir));
        console.log(`profile: ${r.profile}${r.referenceKindAdded ? "; the reference kind added" : ""}`);
        for (const [what, c] of Object.entries(r.counts)) {
          console.log(`${what}: ${c.added} added, ${c.changed} changed, ${c.unchanged} unchanged, ${c.kept} kept`);
        }
      } finally {
        await db.close();
      }
      break;
    }
    case "export": {
      const out = at(o.out, "--out");
      const repo = insideGitRepository(out);
      if (repo) throw new Error(`A client's overlay is never written inside a git repository (${repo}). Choose a folder outside one.`);
      const updated = o.updated ?? new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
      const db = workspaceDb();
      try {
        const overlay = await exportOverlay(db, { updated });
        await writeOverlay(out, overlay);
        console.log(`${overlay.manifest.client.namespace}: ${overlay.artefacts.length} artefacts, ${overlay.alignments.length} alignments written to ${out}`);
      } finally {
        await db.close();
      }
      validate(out);
      break;
    }
    default:
      throw new Error("usage: pnpm overlay import <dir> | export --out <dir>");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
