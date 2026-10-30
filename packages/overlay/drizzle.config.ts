import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { parseDatabaseUrl } from "@ocg/db";

config({ path: "../../.env.local", quiet: true });

// A client workspace's own database (ADR-034), never the steward's. Migrations
// need a direct connection: OVERLAY_DATABASE_URL_UNPOOLED where it is set.
const db = parseDatabaseUrl(process.env.OVERLAY_DATABASE_URL_UNPOOLED || process.env.OVERLAY_DATABASE_URL || "postgres://localhost/ocg_workspace");

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  schemaFilter: ["overlay"],
  migrations: { schema: "overlay", table: "__drizzle_migrations" },
  dbCredentials: db.socketDir
    ? { host: db.socketDir, user: db.user, database: db.database, ssl: false }
    : { url: db.url },
  strict: true,
});
