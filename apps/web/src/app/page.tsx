import { redirect } from "next/navigation";
import { can } from "@/lib/permissions";
import { currentUser } from "@/lib/session";

/** Reviewers start at their batches; curators and admins at the graph. */
export default async function Home() {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }
  redirect(can(user.role, { judgement: ["create"] }) ? "/review" : "/graph");
}
