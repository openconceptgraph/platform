# Deploying the workbench

The workbench runs on Vercel, with its working database on Neon Postgres. Both sit in Frankfurt: the app in Vercel's `fra1` region (pinned in `apps/web/vercel.json`), the database in Neon's AWS `eu-central-1`, so that every query is a short hop and the reviewers' personal data stays in the EU.

## Settings

| Setting | Value |
|---|---|
| Root directory | `apps/web` (pnpm installs the whole workspace from the repository root) |
| Framework | Next.js |
| Node.js | 22.x, as in `.nvmrc` and CI |
| Postgres | Neon's current major (18 at the time of writing); CI tests on 16 and 18 |
| Git | connected to this repository: `main` deploys to production, pull requests to previews |

Connecting the repository matters for the licence as well as for convenience: Vercel then tells each build which commit it is (`VERCEL_GIT_COMMIT_SHA`), and every page links to that commit's source (AGPL-3.0 section 13).

## Environment variables (production)

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Neon's **pooled** connection string. The app's client turns off prepared statements so that it works through the pooler. |
| `DATABASE_URL_UNPOOLED` | Neon's **direct** connection string, used only by `pnpm db:migrate`. |
| `BETTER_AUTH_SECRET` | At least 32 random characters (`openssl rand -base64 32`). The app refuses to start in production without one. It signs sessions and the review screens' presentation tokens. |
| `BETTER_AUTH_URL` | The address reviewers use, such as `https://review.example.org`. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Optional: other full origins people reach the app from, comma-separated. |
| `SOURCE_REPOSITORY_URL` | Optional: where the source link points, if you run a changed copy. |

Never point a development server or the tests at the production database. The tests refuse any database that is the working one or lacks `test` in its name.

## Running a command against production

`scripts/production.sh` runs one command with the project's production variables. It pulls them into a directory only you can read and deletes it when the command ends, so no connection string appears on a command line or stays on disk:

```sh
export BETTER_AUTH_URL=https://review.example.org   # see below
scripts/production.sh pnpm db:migrate
```

The same goes for `pnpm user:create`, `pnpm base import`, `pnpm base draft` and `pnpm batch`.

Vercel hands out a variable stored as *sensitive* only as the placeholder `[SENSITIVE]`. Store `BETTER_AUTH_URL` as an ordinary variable, or give its value when you run the script, as above: the script refuses to run on a placeholder for the address or a connection string. Keep `BETTER_AUTH_SECRET` sensitive. None of these commands sign anything with it, so the placeholder does no harm, but Better Auth warns that the secret looks short.

## A release

1. **Migrations first.** Apply any new migration to production before the code that needs it is deployed. Migrations only add: the code already running keeps working against the new schema.
2. **Then deploy**, by merging to `main`.

There is no down-migration. Recovery is Neon's point-in-time restore: check the restore window on the project's plan, and rehearse a restore onto a branch before relying on it.

## First run

```sh
scripts/production.sh pnpm db:migrate
scripts/production.sh pnpm user:create --email you@example.org --name "Your Name" --role admin
```

`user:create` asks for the password at the terminal; the person whose account it is should type it. Then create reviewers' accounts the same way, load a base's transcription and draft (`pnpm base import`, `pnpm base draft`), and give reviewers batches (`pnpm batch create`).

## What protects the sign-in page

- Accounts are never self-made: sign-up is off, and an admin creates every account.
- Better Auth limits requests per address, more strictly for sign-in. The counts are kept in the database, because serverless instances share no memory. The address comes from `X-Forwarded-For`, which Vercel sets itself.
- Every response forbids framing by other sites and keeps browsers to HTTPS; `robots.txt` and a `noindex` tag keep the workbench out of search engines.
