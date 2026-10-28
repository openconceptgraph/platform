import { execFileSync } from "node:child_process";
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

// The commit this build comes from, for the source link on every page (AGPL-3.0
// section 13). Vercel names it; elsewhere git does. Empty if neither can.
function sourceCommit(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// Sent with every response. Nothing here may be framed by another site, and
// browsers keep to HTTPS. (A content security policy waits until the app's
// inline scripts are accounted for.)
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@ocg/db"],
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
  env: {
    NEXT_PUBLIC_SOURCE_COMMIT: sourceCommit(),
    NEXT_PUBLIC_SOURCE_REPOSITORY: process.env.SOURCE_REPOSITORY_URL ?? "",
  },
  allowedDevOrigins: extraHosts.map((host) => host.split(":")[0]!),
  experimental: {
    serverActions: { allowedOrigins: extraHosts },
  },
};

export default nextConfig;
