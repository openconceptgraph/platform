import { fileURLToPath } from "node:url";
import { parseDatabaseUrl } from "@ocg/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createOverlayDb, type OverlayDb } from "./client";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Wipes the overlay schema of the test database and migrates it from
 * scratch. The steward's tables, in the same test database, are left alone.
 * Refuses any database that is not TEST_DATABASE_URL, is the working
 * database, or lacks "test" in its name.
 */
export async function freshOverlayTestDb(): Promise<OverlayDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  if (url === process.env.DATABASE_URL || url === process.env.OVERLAY_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL must not be a working database");
  }
  const name = new URL(parseDatabaseUrl(url).url).pathname.slice(1);
  if (!name.includes("test")) throw new Error(`refusing to wipe database "${name}": its name must contain "test"`);

  const db = createOverlayDb(url, { max: 4 });
  await db.execute(sql`drop schema if exists overlay cascade`);
  await migrate(db, { migrationsFolder, migrationsSchema: "overlay", migrationsTable: "__drizzle_migrations" });
  return db;
}
