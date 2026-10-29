import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { profileOf } from "@/review/profile";
import { ProfileForm } from "./ProfileForm";

export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }
  const profile = await profileOf(getDb(), user.id);

  return (
    <>
      <AppHeader name={user.name} role={user.role} />
      <main className="narrow">
        <div className="panel">
          <h1>{profile ? "How you appear" : "Before you start: how you appear"}</h1>
          <p>
            Your decisions are recorded under your account, so the project can always say who decided what. Anywhere
            others can see them, now or once they are published, they appear only under the public name you choose
            here. The name on your account is never shown to anyone else.
          </p>
          <ProfileForm publicName={profile?.publicName} publicNote={profile?.publicNote ?? undefined} />
        </div>
      </main>
    </>
  );
}
