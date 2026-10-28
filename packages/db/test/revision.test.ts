import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, schema } from "../src";
import { freshTestDb } from "../src/testing";
import { addConcept, addFramework, pgError } from "./fixtures";

let db: Db;
beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.close();
});

const concepts = schema.concept;

describe("revisions", () => {
  it("counts each change of content", async () => {
    const fw = await addFramework(db);
    const c = await addConcept(db, fw.id, "Add integers");
    expect(c.revision).toBe(1);

    const [edited] = await db
      .update(concepts)
      .set({ title: { en: "Add two integers" } })
      .where(eq(concepts.id, c.id))
      .returning();
    expect(edited?.revision).toBe(2);
    expect(edited?.updatedAt.getTime()).toBeGreaterThanOrEqual(c.updatedAt.getTime());
  });

  it("does not count a change of status, or an update that changes nothing", async () => {
    const fw = await addFramework(db);
    const c = await addConcept(db, fw.id);

    const [confirmed] = await db
      .update(concepts)
      .set({ status: "confirmed" })
      .where(eq(concepts.id, c.id))
      .returning();
    expect(confirmed).toMatchObject({ revision: 1, status: "confirmed" });

    const [same] = await db.update(concepts).set({ title: c.title }).where(eq(concepts.id, c.id)).returning();
    expect(same).toMatchObject({ revision: 1, status: "confirmed" });
  });

  it("sends changed content back to review", async () => {
    const fw = await addFramework(db);
    const c = await addConcept(db, fw.id, "Subtract integers");
    await db.update(concepts).set({ status: "confirmed" }).where(eq(concepts.id, c.id));

    // Even if the caller tries to keep it confirmed in the same statement.
    const [edited] = await db
      .update(concepts)
      .set({ title: { en: "Subtract an integer by adding its additive inverse" }, status: "confirmed" })
      .where(eq(concepts.id, c.id))
      .returning();
    expect(edited).toMatchObject({ revision: 2, status: "proposed" });
  });

  it("keeps created_at as it was", async () => {
    const fw = await addFramework(db);
    const c = await addConcept(db, fw.id);
    const [edited] = await db
      .update(concepts)
      .set({ createdAt: new Date("2000-01-01"), isGateway: true })
      .where(eq(concepts.id, c.id))
      .returning();
    expect(edited?.createdAt).toEqual(c.createdAt);
  });
});

describe("language maps", () => {
  it.each([
    ["an empty map", {}],
    ["a bad tag", { english: "Add integers" }],
    ["an empty string", { en: " " }],
    ["a non-string value", { en: 3 }],
    ["an array", ["Add integers"]],
  ])("refuses %s", async (_label, title) => {
    const fw = await addFramework(db);
    const err = await pgError(
      db.insert(concepts).values({
        frameworkId: fw.id,
        humanCode: "BAD-1",
        title: title as unknown as Record<string, string>,
      }),
    );
    expect(err.code).toBe("23514");
  });

  it("accepts several languages, with regional tags", async () => {
    const fw = await addFramework(db);
    const [row] = await db
      .insert(concepts)
      .values({
        frameworkId: fw.id,
        humanCode: "OK-1",
        title: { en: "Add integers", af: "Tel heelgetalle op", "en-ZA": "Add integers" },
      })
      .returning();
    expect(row?.title.af).toBe("Tel heelgetalle op");
  });
});
