import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { can } from "@/lib/permissions";
import { currentUser } from "@/lib/session";

export default async function NotAReviewerPage() {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }
  return (
    <>
      <AppHeader name={user.name} role={user.role} />
      <main className="narrow">
        <div className="panel">
          <h1>Your account is not a reviewer&apos;s</h1>
          <p>Only reviewers record judgements. Ask an admin to add the reviewer role if you should have it.</p>
          {can(user.role, { graph: ["view"] }) && (
            <p>
              <Link href="/graph">See the graph</Link> of the base as it stands.
            </p>
          )}
        </div>
      </main>
    </>
  );
}
