import path from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// Locally, settings live in the workspace's .env.local; on Vercel they come from the project.
config({ path: path.resolve(process.cwd(), "../../.env.local"), quiet: true });

const nextConfig: NextConfig = {
  transpilePackages: ["@ocg/db"],
};

export default nextConfig;
