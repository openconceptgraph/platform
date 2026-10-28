import { type Db, schema } from "@ocg/db";
import { freshTestDb } from "@ocg/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Auth, createAuth } from "@/lib/auth-config";

let db: Db;
let auth: Auth;
beforeAll(async () => {
  db = await freshTestDb();
  auth = createAuth(db);
});
afterAll(async () => {
  await db.close();
});

const password = "correct horse battery staple";

describe("named accounts", () => {
  it("cannot be self-made", async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: "someone@example.org", name: "Someone", password } }),
    ).rejects.toThrow();
    expect(await db.select().from(schema.user)).toHaveLength(0);
  });

  it("are created by an admin, with roles, and can sign in", async () => {
    const { user } = await auth.api.createUser({
      body: { email: "ada@example.org", name: "Ada Reviewer", password, role: ["reviewer", "curator"] },
    });
    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, user.id));
    expect(row?.role).toBe("reviewer,curator");

    const signedIn = await auth.api.signInEmail({ body: { email: "ada@example.org", password } });
    expect(signedIn.user.id).toBe(user.id);
    expect(signedIn.token).toBeTruthy();
  });

  it("refuse a wrong password", async () => {
    await auth.api.createUser({ body: { email: "bob@example.org", name: "Bob Reviewer", password, role: "reviewer" } });
    await expect(
      auth.api.signInEmail({ body: { email: "bob@example.org", password: "not the password at all" } }),
    ).rejects.toThrow();
  });
});

describe("roles", () => {
  async function can(role: "reviewer" | "curator" | "admin", permissions: Record<string, string[]>) {
    const { user } = await auth.api.createUser({
      body: { email: `${role}-${crypto.randomUUID()}@example.org`, name: `A ${role}`, password, role },
    });
    const result = await auth.api.userHasPermission({ body: { userId: user.id, permissions } });
    return result.success;
  }

  it("let reviewers judge, and nothing else", async () => {
    expect(await can("reviewer", { judgement: ["create"] })).toBe(true);
    expect(await can("reviewer", { base: ["edit"] })).toBe(false);
    expect(await can("reviewer", { user: ["create"] })).toBe(false);
  });

  it("let curators edit the base and run batches, but not judge or plant controls", async () => {
    expect(await can("curator", { base: ["edit", "retire"], batch: ["create", "close"] })).toBe(true);
    expect(await can("curator", { judgement: ["create"] })).toBe(false);
    expect(await can("curator", { control: ["plant"] })).toBe(false);
  });

  it("let admins manage accounts, cut releases and plant controls", async () => {
    expect(await can("admin", { user: ["create", "set-role"], release: ["create"], control: ["plant"] })).toBe(true);
    expect(await can("admin", { judgement: ["create"] })).toBe(false);
  });
});
