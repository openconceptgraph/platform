import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLink } from "@/components/SourceLink";

const commit = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the source link (AGPL-3.0 section 13)", () => {
  it("points every page to the commit the app was built from", () => {
    vi.stubEnv("NEXT_PUBLIC_SOURCE_COMMIT", commit);
    vi.stubEnv("NEXT_PUBLIC_SOURCE_REPOSITORY", "");
    const html = renderToStaticMarkup(createElement(SourceLink));
    expect(html).toContain(`href="https://github.com/openconceptgraph/platform/tree/${commit}"`);
    expect(html).toContain(">Source code (AGPL-3.0)</a>");
  });

  it("points to the repository when the commit is unknown", () => {
    vi.stubEnv("NEXT_PUBLIC_SOURCE_COMMIT", "");
    vi.stubEnv("NEXT_PUBLIC_SOURCE_REPOSITORY", "");
    expect(renderToStaticMarkup(createElement(SourceLink))).toContain(
      'href="https://github.com/openconceptgraph/platform"',
    );
  });

  it("points a changed copy to its own source", () => {
    vi.stubEnv("NEXT_PUBLIC_SOURCE_COMMIT", commit);
    vi.stubEnv("NEXT_PUBLIC_SOURCE_REPOSITORY", "https://git.example.org/someone/platform/");
    expect(renderToStaticMarkup(createElement(SourceLink))).toContain(
      `href="https://git.example.org/someone/platform/tree/${commit}"`,
    );
  });

  it("is fixed at build time from Vercel's commit, or else from git", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", commit);
    const onVercel = (await import("../next.config")).default;
    expect(onVercel.env?.NEXT_PUBLIC_SOURCE_COMMIT).toBe(commit);

    vi.resetModules();
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    const elsewhere = (await import("../next.config")).default;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(elsewhere.env?.NEXT_PUBLIC_SOURCE_COMMIT).toBe(head);
  });
});
