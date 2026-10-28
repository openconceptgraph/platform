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

export function reasonOptions(type: ScreenType) {
  return Object.entries(confirmReasons[type]).map(([code, label]) => ({ code, label }));
}

export function reasonLabel(type: ScreenType, code: string | null | undefined) {
  if (!code) return undefined;
  return (confirmReasons[type] as Record<string, string>)[code] ?? code;
}
