import { createHmac, timingSafeEqual } from "node:crypto";
import type { Evidence } from "./evidence";

/**
 * What a review page showed, signed by the server. The page carries it back
 * when the reviewer decides, so the judgement records exactly what was on the
 * screen, and the time it was shown, without trusting the browser for either.
 */
export interface Presentation {
  v: 1;
  batchId: string;
  reviewerId: string;
  presentedAt: number;
  evidence: Evidence;
}

function key() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set; see .env.example");
  }
  // A key of its own, derived from the session secret.
  return createHmac("sha256", secret).update("ocg/review-presentation/v1").digest();
}

export function signPresentation(presentation: Presentation): string {
  const body = Buffer.from(JSON.stringify(presentation)).toString("base64url");
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** The presentation, or null if the token was not signed by this server or was altered. */
export function verifyPresentation(token: string): Presentation | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const presentation = JSON.parse(Buffer.from(body, "base64url").toString()) as Presentation;
  return presentation.v === 1 ? presentation : null;
}

/** Signs what a page is about to show, stamped with the time it is shown. */
export function present(batchId: string, reviewerId: string, evidence: Evidence): string {
  return signPresentation({ v: 1, batchId, reviewerId, presentedAt: Date.now(), evidence });
}
