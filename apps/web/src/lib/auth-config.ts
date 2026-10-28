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
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    plugins: [admin({ ac, roles, defaultRole: "reviewer", adminRoles: ["admin"] }), nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
