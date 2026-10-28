// AGPL-3.0 section 13: whoever runs this software for other people over a
// network must offer them its source. Every page links to the exact commit it
// was built from, which next.config.ts fixes at build time.
export const SOURCE_REPOSITORY = "https://github.com/openconceptgraph/platform";

export function sourceUrl(commit?: string, repository?: string): string {
  const root = (repository || SOURCE_REPOSITORY).replace(/\/+$/, "");
  return commit ? `${root}/tree/${commit}` : root;
}

export function SourceLink({
  commit = process.env.NEXT_PUBLIC_SOURCE_COMMIT,
  repository = process.env.NEXT_PUBLIC_SOURCE_REPOSITORY,
}: {
  commit?: string;
  repository?: string;
}) {
  return (
    <footer className="app-footer meta">
      <a href={sourceUrl(commit, repository)}>Source code (AGPL-3.0)</a>
    </footer>
  );
}
