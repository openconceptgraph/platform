import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, schema } from "../src";
import { freshTestDb } from "../src/testing";
import { addAiSource, addConcept, addFramework, pgError } from "./fixtures";

let db: Db;
beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("the ID registry", () => {
  it("registers every new object under its kind, with a v4 UUID", async () => {
    const fw = await addFramework(db);
    const concept = await addConcept(db, fw.id);

    const rows = await db
      .select()
      .from(schema.baseObject)
      .where(sql`${schema.baseObject.id} in (${fw.id}, ${concept.id})`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.kind]))).toEqual({
      [fw.id]: "framework",
      [concept.id]: "concept",
    });
    expect(concept.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("will not reuse an ID, even across kinds", async () => {
    const fw = await addFramework(db);
    const concept = await addConcept(db, fw.id);
    const err = await pgError(
      db.insert(schema.family).values({
        id: concept.id,
        frameworkId: fw.id,
        humanCode: "F-1",
        title: { en: "A family" },
      }),
    );
    expect(err.code).toBe("23505");
  });

  it("refuses to delete an object or its registry row", async () => {
    const fw = await addFramework(db);
    const concept = await addConcept(db, fw.id);

    const onTable = await pgError(db.delete(schema.concept).where(eq(schema.concept.id, concept.id)));
    expect(onTable.message).toMatch(/permanent/);

    const onRegistry = await pgError(db.delete(schema.baseObject).where(eq(schema.baseObject.id, concept.id)));
    expect(onRegistry.message).toMatch(/permanent/);
  });

  it("refuses to change an ID or a kind", async () => {
    const fw = await addFramework(db);
    const concept = await addConcept(db, fw.id);

    const newId = await pgError(
      db.update(schema.concept).set({ id: crypto.randomUUID() }).where(eq(schema.concept.id, concept.id)),
    );
    expect(newId.message).toMatch(/permanent/);

    const newKind = await pgError(
      db.update(schema.baseObject).set({ kind: "family" }).where(eq(schema.baseObject.id, concept.id)),
    );
    expect(newKind.message).toMatch(/only retired_at may change/);
  });

  it("retires an object by marking it, and the ID still resolves", async () => {
    const fw = await addFramework(db);
    const old = await addConcept(db, fw.id, "Old wording");
    const replacement = await addConcept(db, fw.id, "New wording");
    const source = await addAiSource(db, fw.id);

    await db.transaction(async (tx) => {
      await tx.update(schema.baseObject).set({ retiredAt: new Date() }).where(eq(schema.baseObject.id, old.id));
      await tx.insert(schema.link).values({
        linkType: "replaced-by",
        fromId: old.id,
        fromKind: "concept",
        toId: replacement.id,
        toKind: "concept",
        sourceId: source.id,
      });
    });

    const [registered] = await db.select().from(schema.baseObject).where(eq(schema.baseObject.id, old.id));
    expect(registered?.retiredAt).toBeInstanceOf(Date);
  });

  it("refuses to truncate the registry", async () => {
    const err = await pgError(db.execute(sql`truncate base_object cascade`));
    expect(err.message).toMatch(/cannot be truncated/);
  });
});

describe("the registry's coverage", () => {
  it("gives every object kind a table, and every such table its triggers", async () => {
    const tables = await db.execute<{ table: string; triggers: string[] }>(sql`
      select c.conrelid::regclass::text as table,
             array(select t.tgname::text from pg_trigger t
                   where t.tgrelid = c.conrelid and not t.tgisinternal order by 1) as triggers
      from pg_constraint c
      where c.contype = 'f'
        and c.confrelid = 'base_object'::regclass
        and c.conkey = (select array[attnum] from pg_attribute
                        where attrelid = c.conrelid and attname = 'id')
    `);
    const byTable = Object.fromEntries(tables.map((r) => [r.table, r.triggers]));

    expect(Object.keys(byTable).sort()).toEqual([...schema.objectKind.enumValues].sort());
    for (const [table, triggers] of Object.entries(byTable)) {
      expect(triggers, table).toEqual(
        expect.arrayContaining([`${table}_register`, `${table}_touch`, `${table}_no_delete`]),
      );
    }
  });
});
