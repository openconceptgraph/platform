import { createDb, type Db } from "@ocg/db";

const cache = globalThis as unknown as { ocgDb?: Db };

/** One connection pool per server process (and per dev server, across reloads). */
export function getDb(): Db {
  if (!cache.ocgDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set; see .env.example");
    }
    cache.ocgDb = createDb(url);
  }
  return cache.ocgDb;
}
