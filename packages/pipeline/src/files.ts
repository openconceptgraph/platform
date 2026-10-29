import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// The transcription as a base keeps it in git: one framework file, one file
// per official document (with its headings), one per teaching plan, and one
// per topic per grade holding that topic's statements in document order.
//
//   <subject>/framework.json
//   <subject>/documents/<document>.json
//   <subject>/teaching-plans/<plan>.json
//   <subject>/statements/<grade>/<topic>.json
//
// IDs are UUID v4, minted once by `pnpm base mint` and never changed.

const id = z.uuidv4();
const langString = z
  .record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a BCP 47 language tag"), z.string().min(1))
  .refine((m) => Object.keys(m).length > 0, "at least one language");
const text = z.string().min(1);

export const educationLevelFile = z.strictObject({
  id: id.optional(),
  code: text,
  title: langString,
  iscedLevel: z.int().min(0).max(8),
  ordinal: z.int(),
});

export const frameworkFile = z.strictObject({
  id: id.optional(),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/),
  title: langString,
  jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/),
  subject: text,
  publisher: text.optional(),
  nodeTypes: z.array(text),
  educationLevels: z.array(educationLevelFile),
});

export interface NodeFile {
  id?: string;
  type: string;
  code?: string;
  title: string;
  children?: NodeFile[];
}
const nodeFile: z.ZodType<NodeFile> = z.lazy(() =>
  z.strictObject({
    id: id.optional(),
    type: text,
    code: text.optional(),
    title: text,
    children: z.array(nodeFile).optional(),
  }),
);

export const documentFile = z.strictObject({
  id: id.optional(),
  /** The official title, in the document's language. */
  title: text,
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
  publisher: text.optional(),
  issued: z.iso.date().optional(),
  versionLabel: text.optional(),
  url: z.url().optional(),
  rights: text.optional(),
  /** The copy the transcription was checked against. Not imported. */
  pdf: z
    .strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      pages: z.int().positive(),
      /** PDF page = printed page + offset. */
      printedPageOffset: z.int(),
    })
    .optional(),
  /** Running heads, column headings and other text on every page that is not content. Not imported. */
  furniture: z.array(text).default([]),
  nodes: z.array(nodeFile),
});

export const placementFile = z.strictObject({
  id: id.optional(),
  /**
   * The document whose node this places, by its file name without .json,
   * when it is not the plan's own: an annual teaching plan schedules the
   * curriculum statement's topics.
   */
  document: text.optional(),
  /** A node of that document (the plan's own by default), by its code: "1.3". */
  node: text,
  /** The plan's own words for what it places, as printed: "WHOLE NUMBERS". Not imported. */
  asPrinted: text.optional(),
  grade: text,
  term: z.int().min(1).optional(),
  weekStart: z.int().min(1).optional(),
  weekEnd: z.int().min(1).optional(),
  hours: z.number().positive().optional(),
});

export const teachingPlanFile = z.strictObject({
  id: id.optional(),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: langString,
  /** The document the plan is transcribed from, by its file name without .json. */
  document: text,
  placements: z.array(placementFile),
});

export const statementTypes = ["content", "clarification", "progression", "exemplar", "prerequisite"] as const;

export interface StatementFile {
  id?: string;
  code?: string;
  type?: (typeof statementTypes)[number];
  /** A label the statement sits under, such as "Revise:" or "Example:". Its words are checked, not imported. */
  label?: string;
  /** Opens with or sits under "Revise": it points back to earlier teaching (ADR-003). */
  revise?: boolean;
  /**
   * Word for word. Notation in Unicode: 2³, aᵐ⁺ⁿ, √, ∛. Layout plain text
   * cannot show is written out: a fraction as numerator⁄denominator with the
   * fraction slash (U+2044), and brackets round a numerator, denominator or
   * root of more than one term, standing for the printed line or bar.
   */
  text: string;
  /** The printed page the statement starts on. */
  page: number;
  /** The transcriber's remark, such as an error in the original kept as printed. Not imported. */
  note?: string;
  /**
   * The text layer holds this statement's notation out of order (superscripts
   * apart from their line, a fraction across two lines), so its order was
   * checked against the printed page by eye. Every character must still be
   * on the page. Not imported.
   */
  eyeChecked?: boolean;
  children?: StatementFile[];
}
const statementFile: z.ZodType<StatementFile> = z.lazy(() =>
  z.strictObject({
    id: id.optional(),
    code: text.optional(),
    type: z.enum(statementTypes).optional(),
    label: text.optional(),
    revise: z.boolean().optional(),
    text,
    page: z.int().positive(),
    note: text.optional(),
    eyeChecked: z.literal(true).optional(),
    children: z.array(statementFile).optional(),
  }),
);

const group = z.strictObject({
  /** The heading the statements sit under in their column, word for word. */
  heading: text.optional(),
  statements: z.array(statementFile),
});
export type GroupFile = z.infer<typeof group>;

export const columns = ["concepts", "notes"] as const;
export type Column = (typeof columns)[number];

export const topicFile = z.strictObject({
  document: text,
  grade: text,
  term: z.int().min(1).optional(),
  /** The topic node's code: "1.3". */
  topic: text,
  /** Printed pages the topic occupies. */
  pages: z.array(z.int().positive()).min(1),
  /** Text on these pages that is neither a heading nor a statement, such as the hours. Not imported. */
  furniture: z.array(text).default([]),
  /** "Concepts and skills": the content itself. */
  concepts: z.array(group),
  /** "Clarification notes or teaching guidelines". */
  notes: z.array(group).default([]),
});

export type FrameworkFile = z.infer<typeof frameworkFile>;
export type DocumentFile = z.infer<typeof documentFile>;
export type TeachingPlanFile = z.infer<typeof teachingPlanFile>;
export type TopicFile = z.infer<typeof topicFile>;

/** A file as read, with where it came from: errors and rewrites name the file. */
export interface Loaded<T> {
  file: string;
  /** The file name without .json: how other files refer to it. */
  name: string;
  data: T;
}

export interface BaseFiles {
  dir: string;
  framework: Loaded<FrameworkFile>;
  documents: Loaded<DocumentFile>[];
  teachingPlans: Loaded<TeachingPlanFile>[];
  topics: Loaded<TopicFile>[];
}

/** Reads and validates every file of one subject's base, e.g. base-za-caps/mathematics. */
export async function readBase(dir: string): Promise<BaseFiles> {
  const one = async <T>(file: string, schema: z.ZodType<T>): Promise<Loaded<T>> => {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${path.relative(dir, file)}: ${z.prettifyError(parsed.error)}`);
    }
    return { file, name: path.basename(file, ".json"), data: parsed.data };
  };
  const all = async <T>(sub: string, schema: z.ZodType<T>) =>
    Promise.all((await jsonFiles(path.join(dir, sub))).map((f) => one(f, schema)));

  const base: BaseFiles = {
    dir,
    framework: await one(path.join(dir, "framework.json"), frameworkFile),
    documents: await all("documents", documentFile),
    teachingPlans: await all("teaching-plans", teachingPlanFile),
    topics: await all("statements", topicFile),
  };
  crossCheck(base);
  return base;
}

/** Every .json file under a folder, at any depth, in a stable order. A missing folder has none. */
async function jsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

/** References between files resolve, and codes are unique where they must be. */
function crossCheck(base: BaseFiles) {
  const problems: string[] = [];
  const grades = new Set(base.framework.data.educationLevels.map((l) => l.code));
  const docs = new Map(base.documents.map((d) => [d.name, d]));
  const nodeCodes = new Map(base.documents.map((d) => [d.name, new Set(allNodes(d.data.nodes).flatMap((n) => n.code ?? []))]));

  for (const d of base.documents) {
    const codes = allNodes(d.data.nodes).flatMap((n) => n.code ?? []);
    for (const dup of duplicates(codes)) problems.push(`${d.name}: node code ${dup} appears twice`);
    for (const n of allNodes(d.data.nodes)) {
      if (!base.framework.data.nodeTypes.includes(n.type)) problems.push(`${d.name}: node type "${n.type}" is not in the framework's nodeTypes`);
    }
  }
  for (const p of base.teachingPlans) {
    if (!docs.has(p.data.document)) problems.push(`${p.name}: no document "${p.data.document}"`);
    for (const pl of p.data.placements) {
      const placed = pl.document ?? p.data.document;
      if (!nodeCodes.get(placed)?.has(pl.node)) problems.push(`${p.name}: no node ${pl.node} in ${placed}`);
      if (!grades.has(pl.grade)) problems.push(`${p.name}: no grade ${pl.grade} in the framework`);
    }
  }
  const statementCodes: string[] = [];
  for (const t of base.topics) {
    if (!docs.has(t.data.document)) problems.push(`${t.name}: no document "${t.data.document}"`);
    else if (!nodeCodes.get(t.data.document)?.has(t.data.topic)) problems.push(`${t.name}: no node ${t.data.topic} in ${t.data.document}`);
    if (!grades.has(t.data.grade)) problems.push(`${t.name}: no grade ${t.data.grade} in the framework`);
    for (const { statement } of topicStatements(t.data)) {
      if (statement.code) statementCodes.push(statement.code);
      if (!t.data.pages.includes(statement.page)) {
        problems.push(`${t.name}: page ${statement.page} of "${statement.text.slice(0, 40)}" is not one of the topic's pages`);
      }
    }
  }
  for (const dup of duplicates(statementCodes)) problems.push(`statement code ${dup} appears twice`);

  const ids = [
    base.framework.data.id,
    ...base.framework.data.educationLevels.map((l) => l.id),
    ...base.documents.flatMap((d) => [d.data.id, ...allNodes(d.data.nodes).map((n) => n.id)]),
    ...base.teachingPlans.flatMap((p) => [p.data.id, ...p.data.placements.map((pl) => pl.id)]),
    ...base.topics.flatMap((t) => topicStatements(t.data).map((s) => s.statement.id)),
  ].filter((x): x is string => Boolean(x));
  for (const dup of duplicates(ids)) problems.push(`ID ${dup} is used twice`);

  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/** Every node of a tree, parents before children. */
export function allNodes(nodes: NodeFile[]): NodeFile[] {
  return nodes.flatMap((n) => [n, ...allNodes(n.children ?? [])]);
}

export interface PlacedStatement {
  statement: StatementFile;
  parent?: StatementFile;
  column: Column;
  /** Which group of its column the statement sits in, counting from 0. */
  group: number;
  heading?: string;
  /** Its type, the column's default when not given. */
  type: (typeof statementTypes)[number];
  /** Position within the topic, in document order: column by column, top to bottom. */
  ordinal: number;
}

/** A topic's statements in document order, parents before children. */
export function topicStatements(topic: TopicFile): PlacedStatement[] {
  const out: PlacedStatement[] = [];
  for (const column of columns) {
    for (const [group, g] of topic[column].entries()) {
      const walk = (statements: StatementFile[], parent?: StatementFile) => {
        for (const s of statements) {
          out.push({
            statement: s,
            parent,
            column,
            group: column === "concepts" ? group : topic.concepts.length + group,
            heading: g.heading,
            type: s.type ?? (column === "concepts" ? "content" : "clarification"),
            ordinal: out.length + 1,
          });
          walk(s.children ?? [], s);
        }
      };
      walk(g.statements);
    }
  }
  return out;
}

function duplicates(xs: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(xs.filter((x) => seen.has(x) || !seen.add(x)))];
}
