import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/sign-in/actions";
import { Mark } from "./Mark";

export function AppHeader({ name, children }: { name?: string; children?: ReactNode }) {
  return (
    <header className="app-header">
      <Link href="/review" className="brand">
        <Mark />
        OpenConceptGraph <span>Review</span>
      </Link>
      {children}
      {name && (
        <form action={signOut} className="who">
          {name} ·
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
