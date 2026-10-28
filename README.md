# OpenConceptGraph platform

The software behind OpenConceptGraph: a review workbench, a publishing pipeline, a public API (REST conforming to CASE 1.1, GraphQL, MCP), an explorer and report generators. The data it works on are concept graphs of official curricula. The open specification is in [`spec`](https://github.com/openconceptgraph/spec), and released bases such as [`base-za-caps`](https://github.com/openconceptgraph/base-za-caps) each have their own repository.

**Status: early.** This repository holds the data layer, sign-in and the reviewer's side of the review workbench. The curator's tools, releases, the API and the explorer come next.

## Layout

```
apps/web        Next.js app: the review workbench so far; the API and explorer later
packages/db     Drizzle schema, migrations and the database's own rules
scripts/        local-pg.sh: a private Postgres for development and tests
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

Accounts are never self-made. Every judgement is attributed to a named person, so an admin creates each account. The roles are `reviewer` (records judgements), `curator` (edits the base and runs review batches) and `admin` (manages accounts and cuts releases). One person may hold several roles.

## The review workbench

A reviewer signs in, opens a batch and decides each item on a screen of its own. Every screen asks one plain question, puts the evidence beside it and offers three answers: confirm, needs a change, or reject. There are three kinds of screen:

- a **prerequisite link**: must a learner be able to do A before they can learn B?
- a **concept card**: is this one concept a teacher can teach in one go, with its own typical mistake?
- a **typical mistake**: do learners really make it, and does it get in the way of the concept?

A confirmation needs a reason from a short list; a rejection or a request for a change needs the reviewer's own words. The record keeps exactly what the screen showed and how long the reviewer spent on it. Deciding a concept card also decides the curriculum lines it cites and its family, and deciding a mistake also decides the concepts it gets in the way of. A reviewer may change their mind, giving a reason; the earlier decision stays on record.

Reviewers do not see the AI's agreement score or other reviewers' decisions, so that their judgement is their own. Planted controls look like any other item.

To try it with an invented example curriculum:

```sh
pnpm user:create --email you@example.org --name "Your Name" --role reviewer
pnpm seed:example --reviewer you@example.org
pnpm dev                     # then sign in at http://localhost:3000
```

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
- **`needs` never loops,** even when two writers race.
- **A review status follows judgements and nothing else.** Counting each reviewer's latest judgement on the current revision, an object is confirmed when every one confirms, rejected when every one rejects, and otherwise stays proposed: a change was asked for, or reviewers disagree. So one reviewer's confirmation is enough when nobody objects. Judgements on planted controls never count, so a planted item can never be confirmed into a release.
- **The judgement record is append-only.** A judgement must be on the object's current revision and must carry a reason. The database sets its time and its control flag. Only a batch's assigned reviewer may judge in it. A change of mind is a new judgement that supersedes the old one and says why.

## Contributing

Sign off your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
