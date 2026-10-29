import { type Db, schema } from "@ocg/db";
import { and, eq } from "drizzle-orm";

// Records that a document's transcription was checked: by machine, when
// `base check` finds no errors, or by a person against the printed page. The
// records are append-only and are released with the document.

export interface CheckRecord {
  /** The framework's slug and the document's title identify the document. */
  frameworkSlug: string;
  documentTitle: string;
  method: "machine" | "person";
  /** Printed pages; omit for every page transcribed. */
  pages?: number[];
  /** YYYY-MM-DD. */
  on: string;
  /** For a person, the public name they chose. */
  by?: string;
  note?: Record<string, string>;
}

export async function recordCheck(db: Db, r: CheckRecord): Promise<{ id: string; documentId: string }> {
  if (r.method === "person" && !r.by?.trim()) throw new Error("A person's check needs the public name they chose (--by)");
  const [doc] = await db
    .select({ id: schema.document.id })
    .from(schema.document)
    .innerJoin(schema.framework, eq(schema.framework.id, schema.document.frameworkId))
    .where(and(eq(schema.framework.slug, r.frameworkSlug), eq(schema.document.title, r.documentTitle)));
  if (!doc) throw new Error(`No document "${r.documentTitle}" in ${r.frameworkSlug}; import the base first`);
  const [row] = await db
    .insert(schema.transcriptionCheck)
    .values({
      documentId: doc.id,
      method: r.method,
      pages: r.pages?.length ? [...new Set(r.pages)].sort((a, b) => a - b) : null,
      checkedOn: r.on,
      checkedBy: r.by?.trim() || null,
      note: r.note ?? null,
    })
    .returning({ id: schema.transcriptionCheck.id });
  return { id: row!.id, documentId: doc.id };
}

/** Parses "75-77,79" into [75, 76, 77, 79]. */
export function parsePages(spec: string): number[] {
  const pages: number[] = [];
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a page or a range of pages`);
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (from < 1 || to < from) throw new Error(`"${part}" is not a valid range`);
    for (let p = from; p <= to; p++) pages.push(p);
  }
  if (pages.length === 0) throw new Error("No pages given");
  return pages;
}
