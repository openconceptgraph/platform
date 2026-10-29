// The curator's batch tool.
//
//   pnpm batch create --framework <slug> --reviewer <email> --screens card,prerequisite
//                     [--stage review|confirmation] [--topics 1.3,2.4] [--size 20]
//                     [--title "..."] --by <email> [--dry-run]
//                     [--controls 2]                       (admin only; review batches only)
//   pnpm batch plant-link --framework <slug> --from INT-02 --to MEA-01
//                     --why "<the rationale reviewers see>" --note "<why it is wrong>" --by <email>
//   pnpm batch plant-mistake --framework <slug> --statement "<the wrong rule>" [--example "..."]
//                     --hinders INT-03 --why "..." --note "..." --by <email>
//   pnpm batch list [--reviewer <email>]
//   pnpm batch close <batch id>
//
// Screens: card (concept cards), prerequisite (needs links), mistake (typical
// mistakes). Any reviewer may be given any screen. --by names who is acting,
// and is recorded.
//
// Stages (ADR-032): an item is confirmed once two different reviewers have
// confirmed it. A review batch (the default) puts items to their first
// reviewer. A confirmation batch puts items that one reviewer has confirmed,
// and nobody has objected to, to a second reviewer, who sees the first one's
// decision. Give each typical mistake to at least one reviewer who has taught.
//
// Planted controls are optional, for an admin to test a new reviewer's first
// batches and then stop: only an admin may plant one or put controls in a
// batch, and batches carry none unless --controls asks for them.
import { parseArgs } from "node:util";
import { type Db, type ReviewStage, schema } from "@ocg/db";
import { eq } from "drizzle-orm";
import { createBatch, userByEmail } from "../src/curate/create-batch";
import { plantLink, plantMistake } from "../src/curate/plant";
import { batchReports, closeBatch } from "../src/curate/report";
import { planBatch } from "../src/curate/select";
import { getDb } from "../src/lib/db";
import { can } from "../src/lib/permissions";
import type { ScreenType } from "../src/review/reasons";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    framework: { type: "string" },
    reviewer: { type: "string" },
    by: { type: "string" },
    screens: { type: "string" },
    stage: { type: "string" },
    topics: { type: "string" },
    size: { type: "string" },
    controls: { type: "string" },
    title: { type: "string" },
    "dry-run": { type: "boolean" },
    from: { type: "string" },
    to: { type: "string" },
    why: { type: "string" },
    note: { type: "string" },
    statement: { type: "string" },
    example: { type: "string" },
    hinders: { type: "string" },
  },
});

const screenNames: ScreenType[] = ["card", "prerequisite", "mistake"];
const stageNames: ReviewStage[] = ["review", "confirmation"];
const stageTitles: Record<ReviewStage, string> = { review: "Review", confirmation: "Confirmation review" };
const db = getDb();

try {
  switch (positionals[0]) {
    case "create":
      await create();
      break;
    case "plant-link":
      await plantOneLink();
      break;
    case "plant-mistake":
      await plantOneMistake();
      break;
    case "list":
      await list();
      break;
    case "close":
      await close();
      break;
    default:
      throw new Error("usage: batch create | plant-link | plant-mistake | list | close (see scripts/batch.ts)");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}

async function create() {
  const frameworkId = await framework(db);
  const reviewer = await person(db, need("reviewer"), { judgement: ["create"] }, "reviewer");
  const controls = o.controls ? Number(o.controls) : 0;
  const by = o.by ? await person(db, o.by, { batch: ["create"] }, "curator") : undefined;
  if (!o["dry-run"] && !by) {
    throw new Error("--by <email> is required to create a batch (or use --dry-run to preview)");
  }
  if (controls > 0 && !(by && can(by.role, { control: ["plant"] }))) {
    throw new Error("only an admin may put planted controls in a batch: --by must be an admin's account");
  }
  const stage = (o.stage ?? "review") as ReviewStage;
  if (!stageNames.includes(stage)) throw new Error(`unknown stage: ${stage}; use ${stageNames.join(" or ")}`);
  const screens = need("screens").split(",").map((s) => s.trim()) as ScreenType[];
  const unknown = screens.filter((s) => !screenNames.includes(s));
  if (unknown.length) throw new Error(`unknown screen: ${unknown.join(", ")}; use ${screenNames.join(", ")}`);

  const { items, controlsShort } = await planBatch(db, {
    frameworkId,
    reviewerId: reviewer.id,
    screens,
    stage,
    topics: o.topics?.split(",").map((t) => t.trim()),
    size: o.size ? Number(o.size) : undefined,
    controls,
  });
  if (items.length === 0) {
    const what = stage === "review" ? "review" : "confirmation by this reviewer";
    console.log(`Nothing is ready for ${what} on those screens and topics.`);
    return;
  }
  items.forEach((item, i) =>
    console.log(`${String(i + 1).padStart(3)}  ${item.screen.padEnd(12)} ${item.isControl ? "[control] " : ""}${item.label}`),
  );
  if (controlsShort > 0) {
    console.log(`\nShort of ${controlsShort} planted control(s) this reviewer has not seen; an admin can plant more.`);
  }
  if (o["dry-run"]) {
    console.log("\nDry run: no batch created.");
    return;
  }
  const title = o.title ?? `${stageTitles[stage]}: ${screens.join(" and ")} · ${new Date().toISOString().slice(0, 10)}`;
  const batch = await createBatch(db, { title, stage, assignedTo: reviewer.id, createdBy: by!.id, items });
  console.log(`\nBatch "${batch.title}" (${batch.id}) with ${items.length} items given to ${reviewer.name}.`);
}

async function plantOneLink() {
  const frameworkId = await framework(db);
  const admin = await person(db, need("by"), { control: ["plant"] }, "admin");
  const planted = await plantLink(db, {
    frameworkId,
    from: need("from"),
    to: need("to"),
    rationale: need("why"),
    note: need("note"),
    plantedBy: admin.id,
  });
  console.log(`Planted "${o.from} needs ${o.to}" (${planted.id}).`);
}

async function plantOneMistake() {
  const frameworkId = await framework(db);
  const admin = await person(db, need("by"), { control: ["plant"] }, "admin");
  const planted = await plantMistake(db, {
    frameworkId,
    statement: need("statement"),
    example: o.example,
    hinders: need("hinders"),
    rationale: need("why"),
    note: need("note"),
    plantedBy: admin.id,
  });
  console.log(`Planted ${planted.humanCode}: "${o.statement}" (${planted.id}).`);
}

async function list() {
  const reviewer = o.reviewer ? await person(db, o.reviewer, { judgement: ["create"] }, "reviewer") : undefined;
  const reports = await batchReports(db, reviewer?.id);
  if (reports.length === 0) {
    console.log("No batches yet.");
    return;
  }
  for (const r of reports) {
    const c = r.controls;
    console.log(
      [
        r.id,
        r.title,
        stageTitles[r.stage],
        r.reviewer,
        `${r.done}/${r.total} done`,
        `controls: ${c.caught} caught, ${c.missed} missed, ${c.waiting} waiting`,
        `${r.minutes} min`,
        r.closedAt ? `closed ${r.closedAt.toISOString().slice(0, 10)}` : "open",
      ].join("  ·  "),
    );
  }
}

async function close() {
  const id = positionals[1];
  if (!id) throw new Error("usage: batch close <batch id>");
  const closed = await closeBatch(db, id);
  console.log(closed ? `Closed "${closed.title}".` : "No open batch with that id.");
}

function need(name: keyof typeof o): string {
  const value = o[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

async function framework(db: Db) {
  const slug = need("framework");
  const [row] = await db.select().from(schema.framework).where(eq(schema.framework.slug, slug));
  if (!row) throw new Error(`no framework ${slug}`);
  return row.id;
}

async function person(db: Db, email: string, permission: Parameters<typeof can>[1], role: string) {
  const user = await userByEmail(db, email);
  if (!user || !can(user.role, permission)) {
    throw new Error(`${email} is not ${/^[aeiou]/.test(role) ? "an" : "a"} ${role}'s account`);
  }
  return user;
}
