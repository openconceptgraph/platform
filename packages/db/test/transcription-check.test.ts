import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, schema } from "../src";
import { freshTestDb } from "../src/testing";
import { addFramework, pgError } from "./fixtures";

let db: Db;
let documentId: string;
beforeAll(async () => {
  db = await freshTestDb();
  const fw = await addFramework(db);
  const [doc] = await db.insert(schema.document).values({ frameworkId: fw.id, title: "Test Curriculum", language: "en" }).returning();
  documentId = doc!.id;
});
afterAll(async () => {
  await db.close();
});

describe("a transcription check", () => {
  it("is append-only", async () => {
    const [check] = await db.insert(schema.transcriptionCheck).values({ documentId, method: "machine", checkedOn: "2026-10-30" }).returning();
    expect((await pgError(db.update(schema.transcriptionCheck).set({ checkedOn: "2026-10-31" }).where(eq(schema.transcriptionCheck.id, check!.id)))).message).toMatch(/append-only/);
    expect((await pgError(db.delete(schema.transcriptionCheck).where(eq(schema.transcriptionCheck.id, check!.id)))).message).toMatch(/append-only/);
  });

  it("by a person names them, and lists pages if it lists any", async () => {
    expect((await pgError(db.insert(schema.transcriptionCheck).values({ documentId, method: "person", checkedOn: "2026-10-30" }))).message).toMatch(/person_named/);
    expect((await pgError(db.insert(schema.transcriptionCheck).values({ documentId, method: "person", checkedOn: "2026-10-30", checkedBy: "S. Steward", pages: [] }))).message).toMatch(/pages_present/);
    await db.insert(schema.transcriptionCheck).values({ documentId, method: "person", checkedOn: "2026-10-30", checkedBy: "S. Steward", pages: [75, 76] });
  });
});
