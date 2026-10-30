#!/usr/bin/env bash
# A private Postgres cluster for development and tests, owned by the current user.
#
#   scripts/local-pg.sh start | stop | status | urls
#
# Needs the Postgres 16+ server binaries (initdb, pg_ctl): on PATH, or in the
# directory named by PG_BIN. Data, log and socket live in .local/pg (gitignored).
# The cluster listens on a Unix socket only, in a directory only you can open,
# and authenticates you by your login name, so there is no password to keep.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dir="$root/.local/pg"
data="$dir/data"
bin=${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}
user=$(id -un)

need_bin() {
  if [[ ! -x "$bin/pg_ctl" ]]; then
    echo "pg_ctl not found. Install the Postgres server or set PG_BIN to its bin directory." >&2
    exit 1
  fi
}

urls() {
  echo "DATABASE_URL=postgres://$user@localhost/ocg?host=$dir"
  echo "TEST_DATABASE_URL=postgres://$user@localhost/ocg_test?host=$dir"
  echo "OVERLAY_DATABASE_URL=postgres://$user@localhost/ocg_workspace?host=$dir"
}

case "${1:-}" in
  start)
    need_bin
    if [[ ! -d "$data" ]]; then
      mkdir -p "$dir" && chmod 700 "$dir"
      "$bin/initdb" -D "$data" -U "$user" --auth-local=peer --auth-host=reject \
        --encoding=UTF8 --locale=C.UTF-8 >/dev/null
      fresh=1
    fi
    "$bin/pg_ctl" -D "$data" -l "$dir/postgres.log" -w \
      -o "-k $dir -c listen_addresses=''" start >/dev/null
    if [[ -n "${fresh:-}" ]]; then
      psql -h "$dir" -d postgres -qc 'create database ocg' -c 'create database ocg_test' -c 'create database ocg_workspace'
    fi
    echo "Postgres running on socket $dir"
    urls
    ;;
  stop)
    need_bin
    "$bin/pg_ctl" -D "$data" -m fast stop
    ;;
  status)
    need_bin
    "$bin/pg_ctl" -D "$data" status
    ;;
  urls)
    urls
    ;;
  *)
    echo "usage: $0 start | stop | status | urls" >&2
    exit 2
    ;;
esac
