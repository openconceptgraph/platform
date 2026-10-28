"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { decide } from "../../actions";

type Choice = "confirm" | "needs-change" | "reject";

export interface Earlier {
  decision: Choice;
  reasonLabel?: string;
  reason?: string;
  at: string;
}

const choices: { value: Choice; label: string; icon: string }[] = [
  { value: "confirm", label: "Yes, confirm", icon: "✓" },
  { value: "needs-change", label: "Needs a change", icon: "✎" },
  { value: "reject", label: "No, reject", icon: "✕" },
];

const decided: Record<Choice, string> = {
  confirm: "You confirmed it",
  "needs-change": "You asked for a change",
  reject: "You rejected it",
};

export function DecisionPanel({
  token,
  options,
  earlier,
  covers,
  nextHref,
}: {
  token: string;
  options: { code: string; label: string }[];
  earlier?: Earlier;
  covers?: string;
  nextHref: string;
}) {
  const [state, action, pending] = useActionState(decide.bind(null, token), undefined);
  const [changing, setChanging] = useState(!earlier);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const reasonRequired = choice !== null && (choice !== "confirm" || Boolean(earlier));
  const ready =
    choice !== null && (choice !== "confirm" || code !== null) && (!reasonRequired || reason.trim() !== "");

  if (!changing && earlier) {
    return (
      <div className="panel decide">
        <h2>Your decision</h2>
        <div className="earlier">
          <b>{decided[earlier.decision]}</b>
          {earlier.reasonLabel && <div>{earlier.reasonLabel}</div>}
          {earlier.reason && <div>“{earlier.reason}”</div>}
          <div className="meta">{earlier.at}</div>
        </div>
        <button type="button" className="choice" onClick={() => setChanging(true)}>
          Change my decision
        </button>
        <Link className="skip" href={nextHref}>
          Next item
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="panel decide">
      <h2>Your decision</h2>
      <div className="choices">
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`choice ${c.value}`}
            aria-pressed={choice === c.value}
            onClick={() => setChoice(c.value)}
          >
            <span className="icon" aria-hidden="true">
              {c.icon}
            </span>
            {c.label}
          </button>
        ))}
      </div>
      <input type="hidden" name="decision" value={choice ?? ""} />

      {choice === "confirm" && (
        <div className="reason">
          <fieldset>
            <legend>Why is it right?</legend>
            {options.map((o) => (
              <label key={o.code} className="option">
                <input
                  type="radio"
                  name="reasonCode"
                  value={o.code}
                  checked={code === o.code}
                  onChange={() => setCode(o.code)}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {choice && (
        <div className="reason">
          <label className="label" htmlFor="reason">
            {reasonPrompt(choice, Boolean(earlier))}{" "}
            <span className="meta">{reasonRequired ? "(required)" : "(optional)"}</span>
          </label>
          <textarea
            id="reason"
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={choice === "confirm" && !earlier ? { minHeight: 64 } : undefined}
          />
        </div>
      )}

      {state?.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}

      <button type="submit" className="primary" disabled={!ready || pending}>
        {pending ? "Recording…" : "Record my decision"}
      </button>
      <p className="small">
        Recorded under your name, with the date and exactly what this page showed. You can change your mind later;
        both decisions stay on record.
      </p>
      {covers && <p className="covers">{covers}</p>}
      {earlier ? (
        <button type="button" className="skip link-button" onClick={() => setChanging(false)}>
          Keep my earlier decision
        </button>
      ) : (
        <Link className="skip" href={nextHref}>
          Skip for now
        </Link>
      )}
    </form>
  );
}

function reasonPrompt(choice: Choice, changingMind: boolean) {
  if (choice === "reject") return "Why is it wrong?";
  if (choice === "needs-change") return "What should change?";
  return changingMind ? "Why are you changing your decision?" : "Add a note";
}
