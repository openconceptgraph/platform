import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

/**
 * What each role may do. Reviewers judge; curators prepare the base and put it
 * to review in batches; admins manage accounts, cut releases and, when they
 * choose to, test a reviewer with planted controls. One person may hold
 * several roles.
 */
const statements = {
  ...defaultStatements,
  judgement: ["create"],
  base: ["edit", "retire"],
  batch: ["create", "close"],
  release: ["create"],
  /** Planting controls and putting them in batches: optional, for calibrating new reviewers. */
  control: ["plant"],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  reviewer: ac.newRole({ judgement: ["create"] }),
  curator: ac.newRole({ base: ["edit", "retire"], batch: ["create", "close"] }),
  admin: ac.newRole({ ...adminAc.statements, release: ["create"], control: ["plant"] }),
};

export type Role = keyof typeof roles;
export const roleNames = Object.keys(roles) as Role[];

/** Whether a user's roles (Better Auth stores them comma-separated) allow a request. */
export function can(userRoles: string | null | undefined, request: Parameters<(typeof roles)[Role]["authorize"]>[0]) {
  return (userRoles ?? "")
    .split(",")
    .map((r) => r.trim())
    .some((r) => r in roles && roles[r as Role].authorize(request).success);
}
