/** The three kinds of review screen. Each asks one question about one batch item. */
export type ScreenType = "prerequisite" | "card" | "mistake";

/**
 * Why a reviewer confirms, from a short fixed list per screen. The codes are
 * stored in the judgement record, so they never change meaning; the labels may
 * be reworded.
 */
export const confirmReasons = {
  prerequisite: {
    "curriculum-says-so": "The curriculum says so",
    "done-using-it": "The second is done using the first",
    "fails-without-it": "Learners fail at the second without the first",
  },
  card: {
    "matches-curriculum": "Matches the curriculum lines, at the right size",
    "own-typical-mistake": "It has its own typical mistake, so it needs its own check",
  },
  mistake: {
    "seen-in-class": "I have seen learners make it",
    documented: "It is documented in research or a diagnostic report",
    "curriculum-warns": "The curriculum warns of it",
  },
} as const satisfies Record<ScreenType, Record<string, string>>;

/**
 * How a confirmation reviewer confirms by agreeing with the first reviewer,
 * without a reason of their own (ADR-032). They may give one of the screen's
 * own reasons instead.
 */
export const AGREES_WITH_REVIEW = "agrees-with-review";
const agreeLabel = "Agrees with the review";

/** The reasons a reviewer may give to confirm; agreeing with the review comes first in a confirmation. */
export function reasonOptions(type: ScreenType, { confirming = false } = {}) {
  const own = Object.entries(confirmReasons[type]).map(([code, label]) => ({ code, label }));
  return confirming ? [{ code: AGREES_WITH_REVIEW, label: agreeLabel }, ...own] : own;
}

export function reasonLabel(type: ScreenType, code: string | null | undefined) {
  if (!code) return undefined;
  if (code === AGREES_WITH_REVIEW) return agreeLabel;
  return (confirmReasons[type] as Record<string, string>)[code] ?? code;
}
