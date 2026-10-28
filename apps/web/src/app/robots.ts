import type { MetadataRoute } from "next";

// The workbench is for signed-in reviewers: nothing in it is for search engines.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
