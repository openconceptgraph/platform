"use client";

import { useActionState } from "react";
import { updateProfile } from "./actions";

export function ProfileForm({ publicName, publicNote }: { publicName?: string; publicNote?: string }) {
  const [state, action, pending] = useActionState(updateProfile, undefined);
  return (
    <form action={action}>
      <label className="field">
        <span>Public name</span>
        <input type="text" name="publicName" defaultValue={publicName} required minLength={2} maxLength={60} />
      </label>
      <p className="small" style={{ marginTop: -6, marginBottom: 16 }}>
        Your own name if you are happy for it to be public, or one that does not identify you, such as “Mathematics
        reviewer 1”.
      </p>
      <label className="field">
        <span>
          About you <span className="meta">(optional, public)</span>
        </span>
        <input type="text" name="publicNote" defaultValue={publicNote} maxLength={120} />
      </label>
      <p className="small" style={{ marginTop: -6, marginBottom: 16 }}>
        A line that tells readers why your judgement counts, such as “Retired physicist, PhD” or “Teaches Grade 8
        mathematics”.
      </p>
      {state?.error && <p className="error">{state.error}</p>}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
