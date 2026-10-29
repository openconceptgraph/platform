#!/usr/bin/env bash
# Runs one command against production, with the Vercel project's production
# variables, and leaves no copy of them behind.
#
#   scripts/production.sh pnpm user:create --email ada@example.org --name "Ada Lovelace" --role reviewer
#   BETTER_AUTH_URL=https://review.example.org scripts/production.sh pnpm user:create ...
#
# Needs the Vercel CLI, signed in, with this repository linked to the project
# (`vercel link`). The variables are pulled into a directory only you can read,
# loaded for the one command, and deleted when it ends, so no connection string
# appears on a command line or stays on disk.
#
# Vercel hands out a variable stored as "sensitive" only as the placeholder
# "[SENSITIVE]". A placeholder for a variable the commands need stops the run;
# set the real value when you call this script and it takes precedence.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/production.sh <command> [arguments...]" >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
needed=(DATABASE_URL DATABASE_URL_UNPOOLED BETTER_AUTH_URL)
placeholder="[SENSITIVE]"

declare -A given=()
for name in "${needed[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    given[$name]=${!name}
  fi
done

dir=$(mktemp -d)
chmod 700 "$dir"
trap 'rm -rf "$dir"' EXIT

if ! (cd "$root" && vercel env pull "$dir/production.env" --environment production --yes >/dev/null 2>&1); then
  echo "Could not pull the production variables. Is the Vercel CLI signed in, and this repository linked (vercel link)?" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
. "$dir/production.env"
set +a

for name in "${!given[@]}"; do
  export "$name=${given[$name]}"
done

for name in "${needed[@]}"; do
  if [[ "${!name:-}" == "$placeholder" ]]; then
    echo "$name is stored on Vercel as a sensitive variable, so only its placeholder can be pulled." >&2
    echo "Set it when you run this script, for example: $name=<value> scripts/production.sh $1 ..." >&2
    exit 1
  fi
done

echo "Running against production: $*" >&2
"$@"
