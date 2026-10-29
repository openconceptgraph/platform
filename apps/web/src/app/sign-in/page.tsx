import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { currentUser } from "@/lib/session";
import { SignInForm } from "./SignInForm";

export default async function SignInPage() {
  if (await currentUser()) {
    redirect("/");
  }
  return (
    <>
      <AppHeader />
      <main className="narrow">
        <div className="panel">
          <h1>Sign in to review</h1>
          <SignInForm />
          <p className="small">
            Each reviewer is given an account; there is no sign-up. Ask the curator if you need one.
          </p>
        </div>
      </main>
    </>
  );
}
