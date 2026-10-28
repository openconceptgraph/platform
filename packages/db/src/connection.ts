/**
 * Connection settings from a Postgres URL. Besides ordinary URLs (Neon's
 * included), accepts libpq's Unix-socket form, which postgres.js does not
 * read from a URL itself:
 *
 *   postgres://user@localhost/ocg?host=/path/to/socket-dir
 */
export function parseDatabaseUrl(url: string) {
  const parsed = new URL(url);
  const socketDir = parsed.searchParams.get("host");
  if (!socketDir?.startsWith("/")) {
    return { url, socketDir: undefined };
  }
  parsed.searchParams.delete("host");
  return {
    url: parsed.toString(),
    socketDir,
    user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
}
