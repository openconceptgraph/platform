import { type Db, schema } from "@ocg/db";
import { and, eq } from "drizzle-orm";
import type { NewBatchItem } from "@/review/create-batch";

// A small invented curriculum for trying the workbench: integers, one algebra
// concept and one from measurement. The wording is ours, written for this
// example; it quotes no real curriculum. Everything starts as proposed: a
// status changes only through reviewers' judgements.

export const EXAMPLE_SLUG = "xx-example/mathematics";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Creates the example curriculum, or finds it if it is already there. Returns its review items. */
export async function exampleCurriculum(db: Db): Promise<{ frameworkId: string; batchItems: NewBatchItem[] }> {
  const [existing] = await db.select().from(schema.framework).where(eq(schema.framework.slug, EXAMPLE_SLUG));
  if (existing) {
    return { frameworkId: existing.id, batchItems: await itemsFor(db, existing.id) };
  }
  const frameworkId = await db.transaction((tx) => create(tx));
  return { frameworkId, batchItems: await itemsFor(db, frameworkId) };
}

async function create(tx: Tx) {
  const one = async <T>(rows: Promise<T[]>) => (await rows)[0]!;

  const fw = await one(
    tx
      .insert(schema.framework)
      .values({
        slug: EXAMPLE_SLUG,
        title: { en: "Example Curriculum: Mathematics" },
        jurisdiction: "XX",
        subject: "mathematics",
        publisher: "Example Department of Education",
        nodeTypes: ["content-area", "topic"],
      })
      .returning(),
  );
  const [g7, g8] = await tx
    .insert(schema.educationLevel)
    .values([
      { frameworkId: fw.id, code: "7", title: { en: "Grade 7" }, iscedLevel: 1, ordinal: 7 },
      { frameworkId: fw.id, code: "8", title: { en: "Grade 8" }, iscedLevel: 2, ordinal: 8 },
    ])
    .returning();
  const doc = await one(
    tx
      .insert(schema.document)
      .values({
        frameworkId: fw.id,
        title: "Example Mathematics Curriculum, Senior Phase",
        language: "en",
        publisher: "Example Department of Education",
        issued: "2024-01-15",
      })
      .returning(),
  );

  const area = (humanCode: string, title: string, ordinal: number) =>
    one(tx.insert(schema.node).values({ documentId: doc.id, nodeType: "content-area", humanCode, title, ordinal }).returning());
  const topic = (parentId: string, humanCode: string, title: string) =>
    one(tx.insert(schema.node).values({ documentId: doc.id, parentId, nodeType: "topic", humanCode, title }).returning());
  const integers = await topic((await area("1", "Numbers", 1)).id, "1.3", "Integers");
  const equations = await topic((await area("2", "Algebra", 2)).id, "2.4", "Equations");
  const length = await topic((await area("4", "Measurement", 4)).id, "4.1", "Length");

  let ordinal = 0;
  const st = (
    nodeId: string,
    levelId: string,
    page: number,
    statementType: "content" | "clarification" | "exemplar",
    text: string,
    isRevision = false,
  ) =>
    one(
      tx
        .insert(schema.statement)
        .values({
          documentId: doc.id,
          nodeId,
          educationLevelId: levelId,
          page,
          statementType,
          text,
          isRevision,
          ordinal: ordinal++,
        })
        .returning(),
    );
  const order = await st(integers.id, g7!.id, 40, "content", "Order and compare integers, using a number line.");
  const sums = await st(integers.id, g7!.id, 40, "content", "Calculate sums and differences of integers.");
  const inverse = await st(
    integers.id,
    g7!.id,
    41,
    "clarification",
    "Show that subtracting an integer gives the same answer as adding its opposite, its additive inverse.",
  );
  const example = await st(integers.id, g7!.id, 41, "exemplar", "9 − 2 = 9 + (−2) = 7\n9 − (−2) = 9 + 2 = 11");
  const warning = await st(
    integers.id,
    g7!.id,
    41,
    "clarification",
    "Learners often believe that subtracting always gives a smaller number; use examples where it does not.",
  );
  await st(integers.id, g8!.id, 52, "content", "Sums and differences of integers", true);
  const solve = await st(
    equations.id,
    g8!.id,
    58,
    "content",
    "Solve simple equations such as x + 5 = 2, by inspection or by adding additive inverses.",
  );
  const convert = await st(length.id, g7!.id, 70, "content", "Convert between millimetres, centimetres, metres and kilometres.");

  const ai = await one(
    tx.insert(schema.source).values({ frameworkId: fw.id, kind: "ai", model: "example-model", promptVersion: "example-v1" }).returning(),
  );
  const fromStatement = (statementId: string) =>
    one(tx.insert(schema.source).values({ frameworkId: fw.id, kind: "statement", statementId }).returning());

  const fam = (humanCode: string, title: string) =>
    one(tx.insert(schema.family).values({ frameworkId: fw.id, humanCode, title: { en: title } }).returning());
  const INT = await fam("INT", "Integers");
  const ALG = await fam("ALG", "Equations");
  const MEA = await fam("MEA", "Length");

  const con = (humanCode: string, title: string, isGateway = false) =>
    one(
      tx
        .insert(schema.concept)
        .values({ frameworkId: fw.id, humanCode, title: { en: title }, kind: "procedure", isGateway })
        .returning(),
    );
  const int01 = await con("INT-01", "Order integers on a number line");
  const int02 = await con("INT-02", "Add integers");
  const int03 = await con("INT-03", "Subtract an integer by adding its additive inverse", true);
  const int04 = await con("INT-04", "Find the additive inverse of an integer");
  const alg05 = await con("ALG-05", "Solve equations of the form x + a = b", true);
  const mea01 = await con("MEA-01", "Convert between units of length");

  const mis = (humanCode: string, statement: string, example: string, sourceId?: string) =>
    one(
      tx
        .insert(schema.misconception)
        .values({ frameworkId: fw.id, humanCode, statement: { en: statement }, example: { en: example }, sourceId })
        .returning(),
    );
  const mis031 = await mis(
    "MIS-031",
    "Subtracting a negative number makes the answer smaller.",
    "9 − (−2) = 7",
    (await fromStatement(warning.id)).id,
  );
  const mis032 = await mis("MIS-032", "Two minus signs together always make a plus, wherever they are.", "−3 − 5 = 8");

  type Kind = "concept" | "family" | "statement" | "misconception";
  const lnk = (
    linkType: "needs" | "hinders" | "defines" | "part-of",
    from: [Kind, string],
    to: [Kind, string],
    sourceId: string,
    rationale?: string,
  ) =>
    one(
      tx
        .insert(schema.link)
        .values({ linkType, fromKind: from[0], fromId: from[1], toKind: to[0], toId: to[1], sourceId, rationale })
        .returning(),
    );
  const c = (id: string): [Kind, string] => ["concept", id];

  for (const [s, k] of [
    [order, int01],
    [sums, int02],
    [sums, int03],
    [inverse, int03],
    [example, int03],
    [inverse, int04],
    [solve, alg05],
    [convert, mea01],
  ] as const) {
    await lnk("defines", ["statement", s.id], c(k.id), ai.id);
  }
  for (const [k, f] of [
    [int01, INT],
    [int02, INT],
    [int03, INT],
    [int04, INT],
    [alg05, ALG],
    [mea01, MEA],
  ] as const) {
    await lnk("part-of", c(k.id), ["family", f.id], ai.id);
  }

  await lnk("needs", c(int02.id), c(int01.id), ai.id, "Adding integers is done by moving along a number line.");
  await lnk(
    "needs",
    c(int03.id),
    c(int02.id),
    ai.id,
    "The curriculum teaches subtraction as adding the additive inverse, so every subtraction is finished as an addition of integers. A learner who cannot yet add integers cannot finish the second step.",
  );
  await lnk(
    "needs",
    c(int03.id),
    c(int04.id),
    (await fromStatement(inverse.id)).id,
    "To subtract by adding the opposite, a learner must first find the opposite.",
  );
  await lnk(
    "needs",
    c(alg05.id),
    c(int03.id),
    ai.id,
    "Solving x + a = b means subtracting a from both sides, which with negative values is subtracting integers.",
  );
  // A planted control: plausible-sounding, and wrong.
  await lnk(
    "needs",
    c(int02.id),
    c(mea01.id),
    ai.id,
    "Adding integers is usually introduced with measurements such as temperatures and heights.",
  );
  await lnk(
    "hinders",
    ["misconception", mis031.id],
    c(int03.id),
    ai.id,
    "Learners carry over \"subtracting makes smaller\" from whole numbers; 9 − (−2) = 11 is where it fails.",
  );
  await lnk(
    "hinders",
    ["misconception", mis032.id],
    c(int03.id),
    ai.id,
    "Learners over-apply \"two negatives make a positive\" from multiplication to subtraction.",
  );

  return fw.id;
}

/** The example batch: concept cards, prerequisite links and mistakes, with one planted control. */
async function itemsFor(db: Db, frameworkId: string): Promise<NewBatchItem[]> {
  const conceptId = async (code: string) =>
    (
      await db
        .select({ id: schema.concept.id })
        .from(schema.concept)
        .where(and(eq(schema.concept.frameworkId, frameworkId), eq(schema.concept.humanCode, code)))
    )[0]!.id;
  const misconceptionId = async (code: string) =>
    (
      await db
        .select({ id: schema.misconception.id })
        .from(schema.misconception)
        .where(and(eq(schema.misconception.frameworkId, frameworkId), eq(schema.misconception.humanCode, code)))
    )[0]!.id;
  const needsId = async (from: string, to: string) =>
    (
      await db
        .select({ id: schema.link.id })
        .from(schema.link)
        .where(
          and(
            eq(schema.link.linkType, "needs"),
            eq(schema.link.fromId, await conceptId(from)),
            eq(schema.link.toId, await conceptId(to)),
          ),
        )
    )[0]!.id;

  return [
    { objectKind: "concept", objectId: await conceptId("INT-03") },
    { objectKind: "link", objectId: await needsId("INT-03", "INT-02") },
    { objectKind: "misconception", objectId: await misconceptionId("MIS-031") },
    { objectKind: "link", objectId: await needsId("ALG-05", "INT-03") },
    {
      objectKind: "link",
      objectId: await needsId("INT-02", "MEA-01"),
      controlExpected: "reject",
      controlNote: "Planted: converting units of length is not needed to add integers.",
    },
    { objectKind: "concept", objectId: await conceptId("INT-02") },
    { objectKind: "misconception", objectId: await misconceptionId("MIS-032") },
    { objectKind: "link", objectId: await needsId("INT-03", "INT-04") },
  ];
}
