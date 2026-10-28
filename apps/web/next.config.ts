import path from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// Locally, settings live in the workspace's .env.local; on Vercel they come from the project.
config({ path: path.resolve(process.cwd(), "../../.env.local"), quiet: true });

// Addresses besides BETTER_AUTH_URL that people use to reach the app, such as
// a dev server shared over a private network. Better Auth reads the same
// variable, so one list lets sign-in, server actions and dev assets all work.
const extraHosts = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => new URL(origin).host);

const nextConfig: NextConfig = {
  transpilePackages: ["@ocg/db"],
  allowedDevOrigins: extraHosts.map((host) => host.split(":")[0]!),
  experimental: {
    serverActions: { allowedOrigins: extraHosts },
  },
};

export default nextConfig;
