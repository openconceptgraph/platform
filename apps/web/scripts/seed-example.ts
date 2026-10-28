// Loads the example curriculum (invented wording; see src/example/curriculum.ts)
// and gives a reviewer a batch of it to try the workbench with. Run it again for
// another batch; the curriculum itself is created once.
//
//   pnpm seed:example --reviewer ada@example.org [--curator you@example.org]
import { parseArgs } from "node:util";
import { exampleCurriculum } from "../src/example/curriculum";
import { getDb } from "../src/lib/db";
import { can } from "../src/lib/permissions";
import { createBatch, userByEmail } from "../src/curate/create-batch";

const { values } = parseArgs({ options: { reviewer: { type: "string" }, curator: { type: "string" } } });
if (!values.reviewer) {
  console.error("usage: seed:example --reviewer <email> [--curator <email>]");
  process.exit(1);
}

const db = getDb();
try {
  const reviewer = await userByEmail(db, values.reviewer);
  if (!reviewer || !can(reviewer.role, { judgement: ["create"] })) {
    throw new Error(`${values.reviewer} is not a reviewer's account. Create it with user:create --role reviewer.`);
  }
  const curator = values.curator ? await userByEmail(db, values.curator) : reviewer;
  if (!curator) {
    throw new Error(`no account for ${values.curator}`);
  }

  const { batchItems } = await exampleCurriculum(db, curator.id);
  const batch = await createBatch(db, {
    title: "Example · Integers",
    assignedTo: reviewer.id,
    createdBy: curator.id,
    items: batchItems,
  });
  console.log(`Batch "${batch.title}" with ${batchItems.length} items given to ${reviewer.name}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
