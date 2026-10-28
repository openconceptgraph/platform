import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseDatabaseUrl } from "./connection";
import * as schema from "./schema";

export function createDb(databaseUrl: string, options: { max?: number } = {}) {
  const { url, socketDir } = parseDatabaseUrl(databaseUrl);
  const client = postgres(url, {
    // A host starting with "/" is a socket directory to postgres.js.
    ...(socketDir ? { host: socketDir } : {}),
    // Keeps queries compatible with Neon's pooled (PgBouncer) endpoint.
    prepare: false,
    max: options.max ?? 10,
    // Let go of idle connections, which a frozen serverless instance would otherwise hold.
    idle_timeout: 20,
    onnotice: () => {},
  });
  return Object.assign(drizzle(client, { schema }), { close: () => client.end() });
}

export type Db = ReturnType<typeof createDb>;
