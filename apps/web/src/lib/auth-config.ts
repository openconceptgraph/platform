import { type Db, schema } from "@ocg/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { ac, roles } from "./permissions";

/**
 * Named accounts only. Every judgement is attributed to a real person, so an
 * admin creates each account; nobody signs themselves up.
 */
export function createAuth(db: Db) {
  if (process.env.NODE_ENV === "production" && (process.env.BETTER_AUTH_SECRET ?? "").length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 random characters in production; see .env.example");
  }
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    // On in production (Better Auth's default), with its stricter limits on
    // sign-in, and counted in the database so every instance sees them.
    rateLimit: { storage: "database" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    plugins: [admin({ ac, roles, defaultRole: "reviewer", adminRoles: ["admin"] }), nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
