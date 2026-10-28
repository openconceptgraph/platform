import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { SourceLink } from "@/components/SourceLink";
import "./globals.css";

// Atkinson Hyperlegible Next (Braille Institute, SIL OFL 1.1): keeps 1, l and I
// and 0 and O apart, which matters on a screen full of maths.
const body = localFont({
  src: [
    { path: "./fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2", style: "normal" },
    { path: "./fonts/atkinson-hyperlegible-next-latin-wght-italic.woff2", style: "italic" },
  ],
  weight: "200 800",
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "OpenConceptGraph",
  description: "Open concept graphs of the world's curricula, built for AI-assisted learning.",
  // The workbench is for signed-in reviewers; what it produces is published elsewhere.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={body.variable}>
      <body>
        {children}
        <SourceLink />
      </body>
    </html>
  );
}
