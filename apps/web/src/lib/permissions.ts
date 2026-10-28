import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

/**
 * What each role may do. Reviewers judge; curators prepare the base and put it
 * to review in batches; admins manage accounts and cut releases. One person
 * may hold several roles.
 */
const statements = {
  ...defaultStatements,
  judgement: ["create"],
  base: ["edit", "retire"],
  batch: ["create", "close"],
  release: ["create"],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  reviewer: ac.newRole({ judgement: ["create"] }),
  curator: ac.newRole({ base: ["edit", "retire"], batch: ["create", "close"] }),
  admin: ac.newRole({ ...adminAc.statements, release: ["create"] }),
};

export type Role = keyof typeof roles;
export const roleNames = Object.keys(roles) as Role[];
