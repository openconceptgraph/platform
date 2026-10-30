import { parseDatabaseUrl } from "@ocg/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** A connection to a client workspace's database, which holds that one client's overlay (ADR-034). */
export function createOverlayDb(databaseUrl: string, options: { max?: number } = {}) {
  const { url, socketDir } = parseDatabaseUrl(databaseUrl);
  const client = postgres(url, {
    ...(socketDir ? { host: socketDir } : {}),
    // Keeps queries compatible with Neon's pooled (PgBouncer) endpoint.
    prepare: false,
    max: options.max ?? 10,
    idle_timeout: 20,
    onnotice: () => {},
  });
  return Object.assign(drizzle(client, { schema }), { close: () => client.end() });
}

export type OverlayDb = ReturnType<typeof createOverlayDb>;
