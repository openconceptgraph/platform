import { createAuth } from "./auth-config";
import { getDb } from "./db";

export const auth = createAuth(getDb());
