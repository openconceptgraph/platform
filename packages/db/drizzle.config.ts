import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { parseDatabaseUrl } from "./src/connection";

config({ path: "../../.env.local", quiet: true });

// Migrations need a direct connection, not a pooled one: Neon gives both, and
// DATABASE_URL_UNPOOLED is the direct one where it is set.
const db = parseDatabaseUrl(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "postgres://localhost/ocg");

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: db.socketDir
    ? { host: db.socketDir, user: db.user, database: db.database, ssl: false }
    : { url: db.url },
  strict: true,
});
