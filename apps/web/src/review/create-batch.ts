import { type Db, type Decision, type ObjectKind, schema } from "@ocg/db";
import { eq, inArray } from "drizzle-orm";
import { screenFor } from "./evidence";

export interface NewBatchItem {
  objectId: string;
  objectKind: ObjectKind;
  /** For a planted control: the decision a careful reviewer reaches. */
  controlExpected?: Decision;
  controlNote?: string;
}

/**
 * Puts items to one reviewer as a batch, in the order given. Only objects with
 * a review screen of their own may be items: concepts, misconceptions and
 * prerequisite links.
 */
export async function createBatch(
  db: Db,
  batch: { title: string; assignedTo: string; createdBy: string; items: NewBatchItem[] },
) {
  const linkIds = batch.items.filter((i) => i.objectKind === "link").map((i) => i.objectId);
  const linkTypes = new Map(
    linkIds.length
      ? (
          await db
            .select({ id: schema.link.id, linkType: schema.link.linkType })
            .from(schema.link)
            .where(inArray(schema.link.id, linkIds))
        ).map((l) => [l.id, l.linkType])
      : [],
  );
  for (const item of batch.items) {
    if (!screenFor(item.objectKind, linkTypes.get(item.objectId))) {
      throw new Error(`${item.objectKind} ${item.objectId} has no review screen of its own`);
    }
  }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.batch)
      .values({ title: batch.title, assignedTo: batch.assignedTo, createdBy: batch.createdBy })
      .returning();
    await tx.insert(schema.batchItem).values(
      batch.items.map((item, ordinal) => ({
        batchId: created!.id,
        objectId: item.objectId,
        objectKind: item.objectKind,
        controlExpected: item.controlExpected ?? null,
        controlNote: item.controlNote ?? null,
        ordinal,
      })),
    );
    return created!;
  });
}

export async function userByEmail(db: Db, email: string) {
  const [u] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  return u;
}
