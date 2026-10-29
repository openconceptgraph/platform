import type { CardEvidence, Evidence, MistakeEvidence, PrerequisiteEvidence, Quote, Related, Segment } from "@/review/evidence";

const kickers = { prerequisite: "Prerequisite link", card: "Concept card", mistake: "Typical mistake" };

/** The left-hand side of a review screen: the question and its evidence, exactly as recorded. */
export function EvidenceView({ evidence, position, total }: { evidence: Evidence; position: number; total: number }) {
  return (
    <div>
      <div className="kicker">
        {evidence.review ? "Confirmation review · " : ""}
        {kickers[evidence.type]} · item {position} of {total}
      </div>
      <Question segments={evidence.question} />
      {evidence.type === "prerequisite" && <Prerequisite evidence={evidence} />}
      {evidence.type === "card" && <Card evidence={evidence} />}
      {evidence.type === "mistake" && <Mistake evidence={evidence} />}
    </div>
  );
}

function Question({ segments }: { segments: Segment[] }) {
  return <h1>{segments.map((s, i) => (s.em ? <em key={i}>{s.text}</em> : <span key={i}>{s.text}</span>))}</h1>;
}

function Prerequisite({ evidence: e }: { evidence: PrerequisiteEvidence }) {
  return (
    <>
      <div className="link-pair">
        <ConceptBox code={e.needed.code} title={e.needed.title} firstTaught={e.needed.firstTaught} />
        <div className="arrow">
          <svg width="64" height="18" viewBox="0 0 64 18" aria-hidden="true">
            <path d="M2 9 H56" stroke="currentColor" strokeWidth="2.5" />
            <path d="M50 3 L60 9 L50 15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
          </svg>
          needed for
        </div>
        <ConceptBox code={e.learner.code} title={e.learner.title} firstTaught={e.learner.firstTaught} />
      </div>

      <section className="panel">
        <h2>What the curriculum says</h2>
        {e.curriculum.map((group) => (
          <div key={group.about}>
            <h3>{group.about}</h3>
            {group.quotes.length ? (
              group.quotes.map((q, i) => <QuoteBlock key={i} quote={q} />)
            ) : (
              <p className="empty">No curriculum line defines this concept yet.</p>
            )}
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Why this link was proposed</h2>
        <ProposalBlock proposal={e.proposal} />
      </section>

      <section className="panel">
        <h2>Around it</h2>
        <div className="related">
          <RelatedList label={`${e.learner.code} also needs`} items={e.alsoNeeds} />
          <RelatedList label={`These need ${e.learner.code}`} items={e.neededBy} />
        </div>
      </section>
    </>
  );
}

function Card({ evidence: e }: { evidence: CardEvidence }) {
  const c = e.concept;
  const facts = [
    c.kind && `A ${c.kind}`,
    c.firstTaught && `first taught in ${c.firstTaught}`,
    c.isGateway && "gateway concept",
    c.levels.length ? `levels: ${c.levels.join(", ")}` : "no levels",
  ].filter(Boolean);
  return (
    <>
      <div className="card large">
        <div className="code">
          {c.code}
          {c.family && ` · Family: ${c.family}`}
        </div>
        <div className="title">{c.title}</div>
        <div className="meta">{facts.join(" · ")}</div>
      </div>

      <section className="panel">
        <h2>Defined by these curriculum lines</h2>
        {e.quotes.length ? (
          e.quotes.map((q, i) => <QuoteBlock key={i} quote={q} />)
        ) : (
          <p className="empty">No curriculum line defines this concept yet.</p>
        )}
      </section>

      <section className="panel">
        <h2>Its typical mistakes</h2>
        <div className="related single">
          <RelatedList items={e.mistakes} none="None proposed yet." />
        </div>
      </section>

      {c.family && (
        <section className="panel">
          <h2>Others in its family</h2>
          <div className="related single">
            <RelatedList items={e.family} none="It is the only one so far." />
          </div>
        </section>
      )}
    </>
  );
}

function Mistake({ evidence: e }: { evidence: MistakeEvidence }) {
  return (
    <>
      <div className="mistake">
        <div className="code">{e.mistake.code}</div>
        <div className="rule">{e.mistake.statement}</div>
        {e.mistake.example && <div className="example">{e.mistake.example}</div>}
      </div>

      <section className="panel">
        <h2>It gets in the way of</h2>
        <div className="related single">
          <RelatedList items={e.hinders.map((c) => ({ code: c.code, title: c.title, status: c.status }))} />
        </div>
      </section>

      <section className="panel">
        <h2>Where this mistake is documented</h2>
        {e.documentedIn ? (
          <>
            <p className="why">
              {e.documentedIn.url ? <a href={e.documentedIn.url}>{e.documentedIn.label}</a> : e.documentedIn.label}
            </p>
            {e.documentedIn.quote && <QuoteBlock quote={e.documentedIn.quote} />}
          </>
        ) : (
          <div className="flag">
            <b>No published source yet.</b> If you have seen learners make it, your judgement is recorded as its source.
          </div>
        )}
      </section>

      {e.proposal && (
        <section className="panel">
          <h2>Why it was proposed</h2>
          <ProposalBlock proposal={e.proposal} />
        </section>
      )}
    </>
  );
}

function ConceptBox({ code, title, firstTaught }: { code: string; title: string; firstTaught?: string }) {
  return (
    <div className="card">
      <div className="code">{code}</div>
      <div className="title">{title}</div>
      {firstTaught && <div className="meta">First taught in {firstTaught}</div>}
    </div>
  );
}

const quoteTags: Partial<Record<Quote["statementType"], string>> = {
  exemplar: "Worked example",
  clarification: "Teaching note",
  progression: "What is different",
  prerequisite: "Prerequisite",
};

function QuoteBlock({ quote }: { quote: Quote }) {
  const tag = quoteTags[quote.statementType];
  return (
    <blockquote className={quote.statementType === "exemplar" ? "exemplar" : undefined}>
      <p>
        {quote.isRevision && <span className="tag revise">Revise</span>}
        {tag && <span className="tag">{tag}</span>}
        {quote.text}
      </p>
      <div className="reference">{quote.reference}. Quoted word for word.</div>
    </blockquote>
  );
}

function ProposalBlock({ proposal }: { proposal: PrerequisiteEvidence["proposal"] }) {
  return (
    <>
      <div className="source">
        <span className="tag">{proposal.label}</span>
        {proposal.detail && <span className="meta">{proposal.detail}</span>}
      </div>
      {proposal.rationale && <p className="why">{proposal.rationale}</p>}
      {proposal.quote && <QuoteBlock quote={proposal.quote} />}
    </>
  );
}

function RelatedList({ label, items, none = "None." }: { label?: string; items: Related[]; none?: string }) {
  return (
    <div>
      {label && (
        <div className="meta" style={{ marginBottom: 4 }}>
          {label}
        </div>
      )}
      {items.length ? (
        <ul>
          {items.map((r) => (
            <li key={r.code}>
              <span>
                {r.code} {r.title}
              </span>
              <span className={`status ${r.status}`}>{r.status === "confirmed" ? "Confirmed" : "Proposed"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">{none}</p>
      )}
    </div>
  );
}
