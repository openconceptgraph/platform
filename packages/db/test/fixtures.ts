import { randomUUID } from "node:crypto";
import type { Db } from "../src";
import { schema } from "../src";

// Small builders for the suites. The curriculum here is invented: the tests
// are about the rules, not the content.

/** The database, or a transaction on it. */
type Writer = Pick<Db, "insert">;

let counter = 0;
const next = () => ++counter;

export async function addFramework(db: Writer) {
  const [row] = await db
    .insert(schema.framework)
    .values({
      slug: `xx-test/mathematics-${next()}`,
      title: { en: "Test Curriculum: Mathematics" },
      jurisdiction: "XX",
      subject: "mathematics",
      nodeTypes: ["content-area", "topic"],
    })
    .returning();
  return row!;
}

export async function addUser(db: Writer, role = "reviewer") {
  const n = next();
  const [row] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), name: `Reviewer ${n}`, email: `reviewer${n}@example.org`, role })
    .returning();
  return row!;
}

export async function addAiSource(db: Writer, frameworkId: string) {
  const [row] = await db
    .insert(schema.source)
    .values({ frameworkId, kind: "ai", model: "test-model", promptVersion: "draft-v1" })
    .returning();
  return row!;
}

export async function addConcept(db: Writer, frameworkId: string, title = `Concept ${next()}`) {
  const [row] = await db
    .insert(schema.concept)
    .values({ frameworkId, humanCode: `C-${next()}`, title: { en: title } })
    .returning();
  return row!;
}

export async function addNeeds(db: Writer, sourceId: string, fromId: string, toId: string) {
  const [row] = await db
    .insert(schema.link)
    .values({
      linkType: "needs",
      fromId,
      fromKind: "concept",
      toId,
      toKind: "concept",
      sourceId,
    })
    .returning();
  return row!;
}

/** The Postgres error behind a failed query, whatever wraps it. */
export async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    let e: unknown = error;
    while (e instanceof Error && e.cause && !(e as { code?: string }).code) {
      e = e.cause;
    }
    return e as { code?: string; message: string };
  }
  throw new Error("expected the query to fail, and it succeeded");
}
