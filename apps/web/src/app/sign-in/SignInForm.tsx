"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export function SignInForm() {
  const [state, action, pending] = useActionState(signIn, undefined);
  return (
    <form action={action}>
      <label className="field">
        <span>Email</span>
        <input type="email" name="email" autoComplete="username" required />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      {state?.error && <p className="error">{state.error}</p>}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
