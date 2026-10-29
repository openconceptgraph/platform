import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/sign-in/actions";
import { can } from "@/lib/permissions";
import { Mark } from "./Mark";

/** The workbench header. Given the signed-in user's roles, it links to the screens they may use. */
export function AppHeader({ name, role, children }: { name?: string; role?: string | null; children?: ReactNode }) {
  const links = [
    can(role, { judgement: ["create"] }) && { href: "/review", label: "Batches" },
    can(role, { graph: ["view"] }) && { href: "/graph", label: "Graph" },
  ].filter((l): l is { href: string; label: string } => Boolean(l));
  return (
    <header className="app-header">
      <Link href="/" className="brand">
        <Mark />
        OpenConceptGraph <span>Review</span>
      </Link>
      {links.length > 1 && (
        <nav className="app-nav">
          {links.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </nav>
      )}
      {children}
      {name && (
        <form action={signOut} className="who">
          {name} ·
          <Link href="/profile" className="link-button">
            Profile
          </Link>
          ·
          <button type="submit" className="link-button">
            Sign out
          </button>
        </form>
      )}
    </header>
  );
}

export function Progress({ title, done, total }: { title: string; done: number; total: number }) {
  return (
    <div className="progress">
      <div className="label">
        <span>Batch: {title}</span>
        <span>
          {done} of {total} done
        </span>
      </div>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <i style={{ width: `${total ? (100 * done) / total : 0}%` }} />
      </div>
    </div>
  );
}
