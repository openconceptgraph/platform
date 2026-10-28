import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Db } from "./client";
import { parseDatabaseUrl } from "./connection";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Wipes the test database and migrates it from scratch. Refuses any database
 * that is not TEST_DATABASE_URL, is the working database, or lacks "test" in
 * its name: this drops every table.
 */
export async function freshTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set");
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL must not be the working database");
  }
  const name = new URL(parseDatabaseUrl(url).url).pathname.slice(1);
  if (!name.includes("test")) {
    throw new Error(`refusing to wipe database "${name}": its name must contain "test"`);
  }

  const db = createDb(url, { max: 4 });
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`create schema public`);
  await migrate(db, { migrationsFolder });
  return db;
}
