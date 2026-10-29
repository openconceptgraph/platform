# OpenConceptGraph platform

The software behind OpenConceptGraph: a review workbench, a publishing pipeline, a public API (REST conforming to CASE 1.1, GraphQL, MCP), an explorer and report generators. The data it works on are concept graphs of official curricula. The open specification is in [`spec`](https://github.com/openconceptgraph/spec), and released bases such as [`base-za-caps`](https://github.com/openconceptgraph/base-za-caps) each have their own repository.

**Status: early.** This repository holds the data layer, sign-in, the review workbench with the curator's batch tool and a graph view of the base, and the first part of the pipeline: transcribing a curriculum, checking the transcription word for word, importing it and loading an AI draft. Releases, the API and the public explorer come next.

## Layout

```
apps/web           Next.js app: the review workbench and graph view so far; the API and explorer later
packages/db        Drizzle schema, migrations and the database's own rules
packages/pipeline  From a curriculum's files to the working database: check, import, draft
scripts/           local-pg.sh: a private Postgres for development and tests
```

## Getting started

You need Node 22, pnpm and Postgres 16 or later.

```sh
pnpm install

# Any Postgres works. To run a private one for this checkout, owned by you, on a
# Unix socket, with no password (set PG_BIN if initdb and pg_ctl aren't on PATH):
scripts/local-pg.sh start

cp .env.example .env.local   # then fill it in: `scripts/local-pg.sh urls` prints the URLs
pnpm db:migrate
pnpm user:create --email you@example.org --name "Your Name" --role admin
pnpm dev
```

Accounts are never self-made. Every judgement is attributed to a known person, so an admin creates each account. The roles are `reviewer` (records judgements), `curator` (edits the base and runs review batches) and `admin` (manages accounts, cuts releases, and may test new reviewers with planted controls). One person may hold several roles.

## The review workbench

A reviewer signs in, opens a batch and decides each item on a screen of its own. Every screen asks one plain question, puts the evidence beside it and offers three answers: confirm, needs a change, or reject. There are three kinds of screen:

- a **prerequisite link**: must a learner be able to do A before they can learn B?
- a **concept card**: is this one concept a teacher can teach in one go, with its own typical mistake?
- a **typical mistake**: do learners really make it, and does it get in the way of the concept?

A confirmation needs a reason from a short list; a rejection or a request for a change needs the reviewer's own words. The record keeps exactly what the screen showed and how long the reviewer spent on it. Deciding a concept card also decides the curriculum lines it cites and its family, and deciding a mistake also decides the concepts it gets in the way of. A reviewer may change their mind, giving a reason; the earlier decision stays on record.

Reviewers do not see the AI's agreement score or other reviewers' decisions, so that their judgement is their own.

Before their first review, each reviewer chooses a public name, which may be their own name or one that does not identify them, and an optional public line about themselves. Anything other people see, in the workbench now and in published data later, shows only that public name. The name on the account stays private, but every judgement remains attributable to a known person.

To try it with an invented example curriculum:

```sh
pnpm user:create --email you@example.org --name "Your Name" --role reviewer
pnpm seed:example --reviewer you@example.org
pnpm dev                     # then sign in at http://localhost:3000
```

## The graph view

Anyone signed in can open **Graph** to see a base as a map: its concepts coloured by family, the prerequisites between them, the curriculum lines that define them under their headings, and, behind a toggle, the typical mistakes. Hovering over a node shows its card; clicking keeps the card open beside the map; a family's chip picks that family out. Dragging a node pulls its neighbours after it on springs, and the map settles when it is let go. **Expand map** hides everything above the map and gives it the window, beside the card; Escape brings the controls back. The same concepts are listed as a table for anyone who cannot use the map, which needs WebGL 2.

When the base has teaching plans, the map can be coloured by the term a plan teaches each concept in instead of by family, with what moves to another term against each other plan. A concept is taught when the first topic that defines it is, unless the plan places its family or the concept itself; the cards and the table say when for every plan.

Fill shows how far each item is through review: hollow while proposed, solid once two reviewers have confirmed it, and in between for curators and admins once one reviewer has. Reviewers see only proposed and confirmed, as on their review screens, because the state in between would show them another reviewer's decision. Prerequisite links are dashed until confirmed. Rejected and retired items are left out, and planted controls never appear.

The layout is worked out on the server from fixed starting points, so the same data always gives the same picture.

## Building a base

A base keeps its transcription of the curriculum in its own repository, such as [`base-za-caps`](https://github.com/openconceptgraph/base-za-caps): one folder per subject, holding the framework, each official document with its headings, each teaching plan with its placements, and one file per topic per grade with that topic's statements in the document's order. The pipeline takes it from there.

```sh
pnpm base mint ../base-za-caps/mathematics      # permanent IDs for new objects, codes for new statements
pnpm base check ../base-za-caps/mathematics --pdf <the document's PDF>
pnpm base import ../base-za-caps/mathematics    # into the working database
pnpm base draft <draft file>                    # an AI draft of concepts, prerequisites and mistakes
```

**Mint** gives every object a UUID and every statement a code such as `8/1.3/c04` (grade, topic, column, number). It never changes one that exists.

**Check** compares every statement, heading and label with the PDF's own text layer, word for word: the same characters in the same order, case and signs included, ignoring only spacing, list markers and layout. Then it reports any printed text that nothing accounts for, down to a single character, so an omission shows as surely as an addition. A PDF's text layer often holds a page out of reading order, with superscripts and list letters on lines of their own. The check allows for that, and asks for an eye check where it cannot tell where a raised character stands. Notation is written in Unicode (2³, aᵐ⁺ⁿ, √, ∛); a fraction is written numerator⁄denominator with the fraction slash, and brackets stand for a root's bar or a fraction line where those cover more than one term. A statement whose order the text layer cannot confirm is marked `eyeChecked`, and its characters must still all be on its page. The PDF must be the copy the document's file names by its SHA-256. By default it checks every document with statements transcribed from it.

A teaching plan places the topics of its own document, or of another: an annual teaching plan schedules the curriculum statement's topics, so each of its placements names that document and keeps the plan's own heading for the topic as printed. Placements are terms, weeks and hours, checked by eye against the printed plan.

**Import** loads the files into Postgres under their own IDs. Run again, it changes nothing that has not changed; a corrected statement becomes a new revision. Nothing is deleted: an object that is no longer in the files is refused, to be retired instead.

**Draft** loads families, concepts, prerequisite links and typical mistakes, all as proposed. Each link cites the drafting run (model and prompt version) as its source, and each mistake cites the curriculum note that names it, or nothing, which flags it as unsourced. Objects are matched by code and links by their ends, so a revised draft updates in place. The drafting method is a versioned prompt in [`packages/pipeline/prompts`](packages/pipeline/prompts); a change of method is a new version. Drafts are working material, not data for publishing: only reviewed objects reach a release.

## Making batches

A curator puts items to reviewers in batches, from the command line. `--by` names who is acting, and is recorded. Any reviewer may be given any screen.

Every item is reviewed twice, by two different people. A **review** batch puts items to their first reviewer. A **confirmation review** batch puts items that one reviewer has confirmed, and nobody has objected to, to a second reviewer. The second reviewer sees the first one's decision and reason (not their name), and can agree in one step.

```sh
# Preview, then create, a batch of concept cards and prerequisite links for their first review
pnpm batch create --framework za-caps/mathematics --reviewer ada@example.org \
  --screens card,prerequisite --topics 1.3 --size 20 --by you@example.org --dry-run

# Put what Ada confirmed to a second reviewer
pnpm batch create --framework za-caps/mathematics --reviewer ben@example.org \
  --screens card,prerequisite --stage confirmation --by you@example.org

pnpm batch list              # stage, progress, minutes spent, and controls caught or missed
pnpm batch close <batch id>
```

A batch takes the next items ready for its stage in curriculum order, never items waiting in another open batch. For a review, that means items still proposed and not yet decided on their current revision. For a confirmation review, it means items confirmed by one reviewer, objected to by nobody, and not yet judged by the reviewer who is to confirm them.

### Planted controls (optional, admins only)

To test a new reviewer, an admin can plant items that are plausible and wrong, and put some in that reviewer's first batches. Batches carry none unless asked, and the practice can stop once a reviewer is trusted.

```sh
pnpm batch plant-link --framework za-caps/mathematics --from INT-02 --to MEA-01 \
  --why "<the rationale reviewers see>" --note "<why it is wrong>" --by admin@example.org
pnpm batch plant-mistake --framework za-caps/mathematics --statement "<the wrong rule>" \
  --hinders INT-03 --why "..." --note "..." --by admin@example.org
pnpm batch create ... --controls 2 --by admin@example.org
```

Controls the reviewer has not seen before are placed at random among the real items, never first or last, and look like any other item. Planted items are marked for good: they never appear among another item's neighbours, go to reviewers only as controls, are left out of the check that `needs` never loops, and never reach a release.

## Deploying

The workbench runs on Vercel with Neon Postgres, both in Frankfurt. [`docs/deploy.md`](docs/deploy.md) has the settings, the environment variables, how to run a command against production, and the order of a release (migrations first).

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test        # wipes and migrates TEST_DATABASE_URL, then checks the rules below
pnpm build
```

CI runs all of these on every pull request. It also fails if the schema has changed without a migration (`pnpm db:generate` creates one).

## Rules the database keeps

These hold whatever the application does, and the tests check each one.

- **IDs are permanent.** Every base object gets a UUID v4 in a single registry, so any ID resolves whatever its kind. Nothing is deleted and no ID changes or is reused. An object is retired by marking it and linking it to its replacement.
- **Changes are counted.** Each change to an object's content raises its revision. If the object had been reviewed, the change returns it to `proposed`, because what was reviewed is no longer what is stored.
- **Every link has a source and a status,** and joins only the kinds its type allows (for example, `needs` runs from concept to concept).
- **`needs` never loops,** even when two writers race. Planted controls are not part of the graph, so they never count.
- **A review status follows judgements and nothing else.** Counting each reviewer's latest judgement on the current revision, an object is confirmed when every one confirms and at least two reviewers have, rejected when every one rejects, and otherwise stays proposed: waiting for a second reviewer, a change was asked for, or reviewers disagree. Confirming takes two different reviewers; one rejection is enough, because a rejected object never reaches a release. Judgements on planted controls never count, so a planted item can never be confirmed into a release.
- **The judgement record is append-only.** A judgement must be on the object's current revision and must carry a reason. The database sets its time and its control flag. Only a batch's assigned reviewer may judge in it. A change of mind is a new judgement that supersedes the old one and says why.

## Contributing

Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/). Contributions are accepted under the same licence.

## Licence

Copyright 2026 the OpenConceptGraph steward.

`AGPL-3.0-only`: the GNU Affero General Public License, version 3. See [LICENSE](LICENSE). You may use, change and host this software. If you run a modified version for other people over a network, you must offer them its source.

Every page of the app links to the source of the commit it was built from. If you run a changed version, set `SOURCE_REPOSITORY_URL` so that the link points to your source.

Versions of this repository up to and including commit `7feff9e` (28 October 2026) were published under the Apache License 2.0, and remain available under it.

The bundled Atkinson Hyperlegible Next fonts are under the SIL Open Font License 1.1 ([`apps/web/src/app/fonts/OFL-atkinson-hyperlegible.txt`](apps/web/src/app/fonts/OFL-atkinson-hyperlegible.txt)).
