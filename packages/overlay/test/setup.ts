import { config } from "dotenv";

// Locally the URLs come from .env.local; in CI they are set in the environment.
config({ path: new URL("../../../.env.local", import.meta.url).pathname, quiet: true });
