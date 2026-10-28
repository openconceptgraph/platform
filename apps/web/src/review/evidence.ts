import { type Db, type LangString, type ObjectKind, type ReviewStatus, schema } from "@ocg/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { publicNameOf } from "./profile";
import type { ScreenType } from "./reasons";

// What a review screen shows about one batch item. It is built on the server,
// rendered as it is, and stored in the judgement record as it is, so the record
// says exactly what the reviewer saw. Deliberately absent: the AI's agreement
// score and other reviewers' decisions, which would anchor the reviewer.

const { concept, document, educationLevel, family, level, link, misconception, node, source, statement } = schema;

export interface ObjectRef {
  id: string;
  kind: ObjectKind;
  revision: number;
}

/** A piece of the question; `em` marks the words the question turns on. */
export interface Segment {
  text: string;
  em?: boolean;
}

/** Official text, word for word, with where it comes from. */
export interface Quote {
  text: string;
  statementType: (typeof schema.statementType.enumValues)[number];
  isRevision: boolean;
  reference: string;
}

export interface ConceptView {
  code: string;
  title: string;
  firstTaught?: string;
}

export interface Related {
  code: string;
  title: string;
  status: ReviewStatus;
}

export interface Proposal {
  /** The kind of source, shown as a tag: "AI draft", "The curriculum". */
  label: string;
  detail?: string;
  rationale?: string;
  quote?: Quote;
}

interface Base {
  type: ScreenType;
  /** The batch item judged. */
  primary: ObjectRef;
  /** Objects shown as part of it, judged with it. */
  covered: ObjectRef[];
  question: Segment[];
}

export interface PrerequisiteEvidence extends Base {
  type: "prerequisite";
  /** The concept that must come first. */
  needed: ConceptView;
  /** The concept that needs it. */
  learner: ConceptView;
  curriculum: { about: string; quotes: Quote[] }[];
  proposal: Proposal;
  alsoNeeds: Related[];
  neededBy: Related[];
}

export interface CardEvidence extends Base {
  type: "card";
  concept: ConceptView & { family?: string; kind?: string; isGateway: boolean; levels: string[] };
  quotes: Quote[];
  mistakes: Related[];
  family: Related[];
}

export interface MistakeEvidence extends Base {
  type: "mistake";
  mistake: { code: string; statement: string; example?: string };
  hinders: (ConceptView & { status: ReviewStatus })[];
  documentedIn?: { label: string; url?: string; quote?: Quote };
  proposal?: Proposal;
}

export type Evidence = PrerequisiteEvidence | CardEvidence | MistakeEvidence;

/** Which screen a batch item gets, by its kind. Null for kinds not reviewed on their own. */
export function screenFor(kind: ObjectKind, linkType?: string | null): ScreenType | null {
  if (kind === "concept") return "card";
  if (kind === "misconception") return "mistake";
  if (kind === "link" && linkType === "needs") return "prerequisite";
  return null;
}

export async function buildEvidence(db: Db, item: { objectId: string; objectKind: ObjectKind }): Promise<Evidence> {
  switch (item.objectKind) {
    case "link":
      return prerequisiteEvidence(db, item.objectId);
    case "concept":
      return cardEvidence(db, item.objectId);
    case "misconception":
      return mistakeEvidence(db, item.objectId);
    default:
      throw new Error(`a ${item.objectKind} is not reviewed on its own screen`);
  }
}

async function prerequisiteEvidence(db: Db, linkId: string): Promise<PrerequisiteEvidence> {
  const [l] = await db.select().from(link).where(eq(link.id, linkId));
  if (!l || l.linkType !== "needs") {
    throw new Error(`link ${linkId} is not a prerequisite link`);
  }
  const views = await conceptViews(db, [l.fromId, l.toId]);
  const learner = views.get(l.fromId)!;
  const needed = views.get(l.toId)!;
  const quotes = await definingQuotes(db, [l.fromId, l.toId]);

  const alsoNeeds = await db
    .select({ code: concept.humanCode, title: concept.title, status: link.status })
    .from(link)
    .innerJoin(concept, eq(concept.id, link.toId))
    .where(and(eq(link.linkType, "needs"), eq(link.fromId, l.fromId), ne(link.id, l.id), ne(link.status, "rejected")))
    .orderBy(asc(concept.humanCode));
  const neededBy = await db
    .select({ code: concept.humanCode, title: concept.title, status: link.status })
    .from(link)
    .innerJoin(concept, eq(concept.id, link.fromId))
    .where(and(eq(link.linkType, "needs"), eq(link.toId, l.fromId), ne(link.status, "rejected")))
    .orderBy(asc(concept.humanCode));

  return {
    type: "prerequisite",
    primary: { id: l.id, kind: "link", revision: l.revision },
    covered: [],
    question: [
      { text: "Must a learner be able to " },
      { text: lowerFirst(needed.title), em: true },
      { text: " before they can learn to " },
      { text: lowerFirst(learner.title), em: true },
      { text: "?" },
    ],
    needed,
    learner,
    curriculum: [
      { about: learner.title, quotes: quotes.get(l.fromId) ?? [] },
      { about: needed.title, quotes: quotes.get(l.toId) ?? [] },
    ],
    proposal: await proposalFrom(db, l.sourceId, l.rationale),
    alsoNeeds: alsoNeeds.map(related),
    neededBy: neededBy.map(related),
  };
}

async function cardEvidence(db: Db, conceptId: string): Promise<CardEvidence> {
  const [c] = await db.select().from(concept).where(eq(concept.id, conceptId));
  if (!c) throw new Error(`concept ${conceptId} not found`);
  const view = (await conceptViews(db, [c.id])).get(c.id)!;

  const defines = await db
    .select({ id: link.id, revision: link.revision })
    .from(link)
    .where(and(eq(link.linkType, "defines"), eq(link.toId, c.id), ne(link.status, "rejected")));
  const [partOf] = await db
    .select({ id: link.id, revision: link.revision, familyId: link.toId, familyTitle: family.title })
    .from(link)
    .innerJoin(family, eq(family.id, link.toId))
    .where(and(eq(link.linkType, "part-of"), eq(link.fromId, c.id), ne(link.status, "rejected")));

  const members = partOf
    ? await db
        .select({ code: concept.humanCode, title: concept.title, status: link.status })
        .from(link)
        .innerJoin(concept, eq(concept.id, link.fromId))
        .where(
          and(
            eq(link.linkType, "part-of"),
            eq(link.toId, partOf.familyId),
            ne(link.fromId, c.id),
            ne(link.status, "rejected"),
          ),
        )
        .orderBy(asc(concept.humanCode))
    : [];
  const mistakes = await db
    .select({ code: misconception.humanCode, title: misconception.statement, status: link.status })
    .from(link)
    .innerJoin(misconception, eq(misconception.id, link.fromId))
    .where(and(eq(link.linkType, "hinders"), eq(link.toId, c.id), ne(link.status, "rejected")))
    .orderBy(asc(misconception.humanCode));
  const levels = await db
    .select({ title: level.title })
    .from(level)
    .where(eq(level.conceptId, c.id))
    .orderBy(asc(level.ordinal));

  return {
    type: "card",
    primary: { id: c.id, kind: "concept", revision: c.revision },
    covered: [...defines, ...(partOf ? [partOf] : [])].map((l) => ({ id: l.id, kind: "link", revision: l.revision })),
    question: [
      { text: "Is this " },
      { text: "one concept", em: true },
      { text: " a teacher can teach in one go, with its own typical mistake?" },
    ],
    concept: {
      ...view,
      family: partOf ? pick(partOf.familyTitle) : undefined,
      kind: c.kind ?? undefined,
      isGateway: c.isGateway,
      levels: levels.map((l) => pick(l.title)),
    },
    quotes: (await definingQuotes(db, [c.id])).get(c.id) ?? [],
    mistakes: mistakes.map(related),
    family: members.map(related),
  };
}

async function mistakeEvidence(db: Db, misconceptionId: string): Promise<MistakeEvidence> {
  const [m] = await db.select().from(misconception).where(eq(misconception.id, misconceptionId));
  if (!m) throw new Error(`misconception ${misconceptionId} not found`);

  const hinders = await db
    .select({
      id: link.id,
      revision: link.revision,
      status: link.status,
      conceptId: link.toId,
      sourceId: link.sourceId,
      rationale: link.rationale,
    })
    .from(link)
    .innerJoin(concept, eq(concept.id, link.toId))
    .where(and(eq(link.linkType, "hinders"), eq(link.fromId, m.id), ne(link.status, "rejected")))
    .orderBy(asc(concept.humanCode));
  const views = await conceptViews(
    db,
    hinders.map((h) => h.conceptId),
  );
  const concepts = hinders.map((h) => ({ ...views.get(h.conceptId)!, status: h.status }));

  const question: Segment[] =
    concepts.length === 1
      ? [
          { text: "Do learners really make this mistake, and does it get in the way of learning to " },
          { text: lowerFirst(concepts[0]!.title), em: true },
          { text: "?" },
        ]
      : [{ text: "Do learners really make this mistake, and does it get in the way of learning these concepts?" }];

  const first = hinders[0];
  return {
    type: "mistake",
    primary: { id: m.id, kind: "misconception", revision: m.revision },
    covered: hinders.map((h) => ({ id: h.id, kind: "link", revision: h.revision })),
    question,
    mistake: { code: m.humanCode, statement: pick(m.statement), example: m.example ? pick(m.example) : undefined },
    hinders: concepts,
    documentedIn: m.sourceId ? await documentation(db, m.sourceId) : undefined,
    proposal: first ? await proposalFrom(db, first.sourceId, first.rationale) : undefined,
  };
}

/** Concepts by ID, each with the grade it is first taught in, from the curriculum lines that define it. */
async function conceptViews(db: Db, ids: string[]) {
  const rows = await db.select().from(concept).where(inArray(concept.id, ids));
  const levels = await db
    .select({ conceptId: link.toId, title: educationLevel.title, ordinal: educationLevel.ordinal })
    .from(link)
    .innerJoin(statement, eq(statement.id, link.fromId))
    .innerJoin(educationLevel, eq(educationLevel.id, statement.educationLevelId))
    .where(and(eq(link.linkType, "defines"), inArray(link.toId, ids), ne(link.status, "rejected")))
    .orderBy(asc(educationLevel.ordinal));

  const views = new Map<string, ConceptView>();
  for (const c of rows) {
    const earliest = levels.find((l) => l.conceptId === c.id);
    views.set(c.id, {
      code: c.humanCode,
      title: pick(c.title),
      firstTaught: earliest ? pick(earliest.title) : undefined,
    });
  }
  return views;
}

/** The curriculum lines defining each concept, in document order. */
async function definingQuotes(db: Db, conceptIds: string[]) {
  const rows = await db
    .select({ conceptId: link.toId, ...quoteColumns })
    .from(link)
    .innerJoin(statement, eq(statement.id, link.fromId))
    .innerJoin(document, eq(document.id, statement.documentId))
    .leftJoin(node, eq(node.id, statement.nodeId))
    .leftJoin(educationLevel, eq(educationLevel.id, statement.educationLevelId))
    .where(and(eq(link.linkType, "defines"), inArray(link.toId, conceptIds), ne(link.status, "rejected")))
    .orderBy(asc(statement.page), asc(statement.ordinal));

  const quotes = new Map<string, Quote[]>();
  for (const row of rows) {
    quotes.set(row.conceptId, [...(quotes.get(row.conceptId) ?? []), toQuote(row)]);
  }
  return quotes;
}

const quoteColumns = {
  text: statement.text,
  statementType: statement.statementType,
  isRevision: statement.isRevision,
  page: statement.page,
  documentTitle: document.title,
  levelTitle: educationLevel.title,
  nodeCode: node.humanCode,
  nodeTitle: node.title,
};

type QuoteRow = {
  text: string;
  statementType: Quote["statementType"];
  isRevision: boolean;
  page: number | null;
  documentTitle: string;
  levelTitle: LangString | null;
  nodeCode: string | null;
  nodeTitle: string | null;
};

function toQuote(row: QuoteRow): Quote {
  const reference = [
    row.documentTitle,
    row.page ? `p. ${row.page}` : undefined,
    row.levelTitle ? pick(row.levelTitle) : undefined,
    row.nodeTitle ? [row.nodeCode, row.nodeTitle].filter(Boolean).join(" ") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return { text: row.text, statementType: row.statementType, isRevision: row.isRevision, reference };
}

async function statementQuote(db: Db, statementId: string): Promise<Quote | undefined> {
  const [row] = await db
    .select(quoteColumns)
    .from(statement)
    .innerJoin(document, eq(document.id, statement.documentId))
    .leftJoin(node, eq(node.id, statement.nodeId))
    .leftJoin(educationLevel, eq(educationLevel.id, statement.educationLevelId))
    .where(eq(statement.id, statementId));
  return row ? toQuote(row) : undefined;
}

/** Why a link was proposed, from its source. */
async function proposalFrom(db: Db, sourceId: string, rationale: string | null): Promise<Proposal> {
  const [s] = await db.select().from(source).where(eq(source.id, sourceId));
  const why = rationale ?? undefined;
  switch (s?.kind) {
    case "ai":
      return { label: "AI draft", detail: `Drafting prompt ${s.promptVersion}`, rationale: why };
    case "statement":
      return { label: "The curriculum", rationale: why, quote: await statementQuote(db, s.statementId!) };
    case "publication":
      return { label: "Publication", detail: s.citation!, rationale: why };
    case "reviewer":
      return { label: "Reviewer", detail: await publicNameOf(db, s.reviewerId!), rationale: why };
    default:
      return { label: "Unknown source", rationale: why };
  }
}

/** Where a misconception is documented. */
async function documentation(db: Db, sourceId: string): Promise<MistakeEvidence["documentedIn"]> {
  const [s] = await db.select().from(source).where(eq(source.id, sourceId));
  switch (s?.kind) {
    case "publication":
      return { label: s.citation!, url: s.url ?? undefined };
    case "statement":
      return { label: "The curriculum", quote: await statementQuote(db, s.statementId!) };
    case "reviewer":
      return { label: `Seen in class by ${await publicNameOf(db, s.reviewerId!)}` };
    default:
      return undefined;
  }
}


function related(row: { code: string; title: LangString; status: ReviewStatus }): Related {
  return { code: row.code, title: pick(row.title), status: row.status };
}

/** Text in the reviewer's language: English for now, else whatever there is. */
function pick(text: LangString, lang = "en"): string {
  return text[lang] ?? Object.values(text)[0] ?? "";
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
