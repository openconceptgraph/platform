import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, schema } from "../src";
import { freshTestDb } from "../src/testing";
import { addAiSource, addConcept, addFramework, addNeeds, pgError, setStatus } from "./fixtures";

let db: Db;
beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.close();
});

async function setup() {
  const fw = await addFramework(db);
  const source = await addAiSource(db, fw.id);
  const [a, b, c] = await Promise.all([
    addConcept(db, fw.id, "Add integers"),
    addConcept(db, fw.id, "Subtract integers"),
    addConcept(db, fw.id, "Solve x + a = b"),
  ]);
  return { fw, source, a, b, c };
}

describe("links", () => {
  it("connect only the kinds their type allows", async () => {
    const { fw, source, a } = await setup();
    const [fam] = await db
      .insert(schema.family)
      .values({ frameworkId: fw.id, humanCode: "INT", title: { en: "Integers" } })
      .returning();

    // part-of runs concept → family, not the other way.
    const err = await pgError(
      db.insert(schema.link).values({
        linkType: "part-of",
        fromId: fam!.id,
        fromKind: "family",
        toId: a.id,
        toKind: "concept",
        sourceId: source.id,
      }),
    );
    expect(err.message).toMatch(/link_endpoint_kinds/);
  });

  it("cannot claim the wrong kind for an object", async () => {
    const { source, a, b } = await setup();
    const err = await pgError(
      db.insert(schema.link).values({
        linkType: "hinders",
        fromId: a.id,
        fromKind: "misconception", // a is a concept
        toId: b.id,
        toKind: "concept",
        sourceId: source.id,
      }),
    );
    expect(err.code).toBe("23503");
  });

  it("must cite a source", async () => {
    const { a, b } = await setup();
    const err = await pgError(
      db.insert(schema.link).values({
        linkType: "needs",
        fromId: a.id,
        fromKind: "concept",
        toId: b.id,
        toKind: "concept",
        sourceId: null as unknown as string,
      }),
    );
    expect(err.code).toBe("23502");
  });

  it("give a concept at most one live family", async () => {
    const { fw, source, a } = await setup();
    const fams = await db
      .insert(schema.family)
      .values([
        { frameworkId: fw.id, humanCode: "F-A", title: { en: "Family A" } },
        { frameworkId: fw.id, humanCode: "F-B", title: { en: "Family B" } },
      ])
      .returning();
    const partOf = (familyId: string) =>
      db
        .insert(schema.link)
        .values({
          linkType: "part-of",
          fromId: a.id,
          fromKind: "concept",
          toId: familyId,
          toKind: "family",
          sourceId: source.id,
        })
        .returning();

    const [first] = await partOf(fams[0]!.id);
    expect((await pgError(partOf(fams[1]!.id))).code).toBe("23505");

    // Once the first is rejected, a second may be proposed.
    await setStatus(db, "link", first!.id, "rejected");
    await expect(partOf(fams[1]!.id)).resolves.toHaveLength(1);
  });
});

describe("needs never loops", () => {
  it("refuses a link that closes a loop", async () => {
    const { source, a, b, c } = await setup();
    await addNeeds(db, source.id, b.id, a.id); // subtract needs add
    await addNeeds(db, source.id, c.id, b.id); // solve needs subtract

    const err = await pgError(addNeeds(db, source.id, a.id, c.id)); // add needs solve: a loop
    expect(err.code).toBe("23514");
    expect(err.message).toMatch(/would make a loop/);
  });

  it("refuses a concept needing itself", async () => {
    const { source, a } = await setup();
    expect((await pgError(addNeeds(db, source.id, a.id, a.id))).message).toMatch(/link_not_to_self/);
  });

  it("ignores rejected links, and checks again if one is revived", async () => {
    const { source, a, b } = await setup();
    const ab = await addNeeds(db, source.id, a.id, b.id);
    await setStatus(db, "link", ab.id, "rejected");

    await addNeeds(db, source.id, b.id, a.id); // fine: a → b is rejected

    const err = await pgError(setStatus(db, "link", ab.id, "proposed"));
    expect(err.message).toMatch(/would make a loop/);
  });

  it("holds when two writers race to close a loop", async () => {
    const { source, a, b } = await setup();
    const other = createDb(process.env.TEST_DATABASE_URL!, { max: 1 });
    try {
      let releaseFirst!: () => void;
      const firstInserted = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstMayCommit!: () => void;
      const commitFirst = new Promise<void>((resolve) => (firstMayCommit = resolve));

      // The first writer adds a → b and holds its transaction open while the
      // second adds b → a. The check runs at commit: whichever commits second
      // sees the other's link and is refused.
      const first = db.transaction(async (tx) => {
        await addNeeds(tx, source.id, a.id, b.id);
        releaseFirst();
        await commitFirst;
      });
      await firstInserted;
      const second = other.transaction((tx) => addNeeds(tx, source.id, b.id, a.id));
      await new Promise((resolve) => setTimeout(resolve, 200));
      firstMayCommit();

      const outcomes = await Promise.allSettled([first, second]);
      const refused = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
      expect(refused).toHaveLength(1);
      expect(String(refused[0]!.reason)).toMatch(/would make a loop/);
    } finally {
      await other.close();
    }
  });
});
