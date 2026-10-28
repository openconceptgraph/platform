import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, schema } from "../src";
import { freshTestDb } from "../src/testing";
import { addAiSource, addConcept, addFramework, addNeeds, addUser, pgError } from "./fixtures";

let db: Db;
beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.close();
});

async function plantedLink() {
  const fw = await addFramework(db);
  const source = await addAiSource(db, fw.id);
  const a = await addConcept(db, fw.id, "Add integers");
  const b = await addConcept(db, fw.id, "Convert units of length");
  const link = await addNeeds(db, source.id, a.id, b.id);
  const curator = await addUser(db, "curator");
  await db.insert(schema.planted).values({
    objectId: link.id,
    objectKind: "link",
    note: "Converting units is not needed to add integers.",
    plantedBy: curator.id,
  });
  return { link, curator };
}

describe("planted controls", () => {
  it("stay marked for good", async () => {
    const { link } = await plantedLink();
    const unmark = await pgError(db.delete(schema.planted).where(eq(schema.planted.objectId, link.id)));
    expect(unmark.message).toMatch(/stay marked for good/);
    const soften = await pgError(
      db.update(schema.planted).set({ expected: "confirm" }).where(eq(schema.planted.objectId, link.id)),
    );
    expect(soften.message).toMatch(/stay marked for good/);
  });

  it("go into a batch only as controls, with their expected decision", async () => {
    const { link, curator } = await plantedLink();
    const reviewer = await addUser(db);
    const [batch] = await db
      .insert(schema.batch)
      .values({ title: "Week 1", assignedTo: reviewer.id, createdBy: curator.id })
      .returning();
    // The caller does not say it is a control; the database does.
    const [item] = await db
      .insert(schema.batchItem)
      .values({ batchId: batch!.id, objectId: link.id, objectKind: "link" })
      .returning();
    expect(item).toMatchObject({
      controlExpected: "reject",
      controlNote: "Converting units is not needed to add integers.",
    });
  });

  it("never block a genuine link, though a genuine loop is still refused", async () => {
    // Planted: "Add integers needs Convert units of length".
    const { link } = await plantedLink();
    const [add] = await db.select().from(schema.concept).where(eq(schema.concept.id, link.fromId));
    const convert = link.toId;

    // The reverse, as a real link, is allowed: the planted one is not part of the graph.
    await addNeeds(db, link.sourceId, convert, add!.id);

    // A real loop is still refused: convert → add → measure → convert.
    const measure = await addConcept(db, add!.frameworkId, "Measure lengths");
    await addNeeds(db, link.sourceId, add!.id, measure.id);
    const loop = await pgError(addNeeds(db, link.sourceId, measure.id, convert));
    expect(loop.message).toMatch(/would make a loop/);
  });
});
