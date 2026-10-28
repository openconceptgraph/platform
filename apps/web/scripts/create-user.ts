// Creates a named account. Nobody signs themselves up: every judgement is
// attributed to a real person, so an admin creates each account.
//
//   pnpm --filter @ocg/web user:create --email ada@example.org --name "Ada Lovelace" --role reviewer
//
// --role may be repeated. The password is read from the terminal (or the first
// line of piped input), never from the command line, so it stays out of shell history.
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { auth } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { type Role, roleNames } from "../src/lib/permissions";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", multiple: true },
  },
});

const { email, name } = values;
const role = (values.role ?? []) as Role[];
if (!email || !name || role.length === 0) {
  fail(`usage: user:create --email <email> --name "<full name>" --role <${roleNames.join("|")}> [--role ...]`);
}
const unknown = role.filter((r) => !roleNames.includes(r));
if (unknown.length > 0) {
  fail(`unknown role: ${unknown.join(", ")}. Roles are ${roleNames.join(", ")}.`);
}

const password = await readPassword("Password (12 or more characters): ");
// Better Auth would create the account without a password rather than refuse.
if (password.length < 12) {
  fail("The password must be 12 or more characters. No account was created.");
}
try {
  const { user } = await auth.api.createUser({ body: { email, name, password, role } });
  console.log(`Created ${user.name} <${user.email}> as ${role.join(", ")}.`);
} catch (error) {
  fail(`Could not create the account: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await getDb().close();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Reads one line without echoing it, or the first line of piped input. */
function readPassword(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return new Promise((resolve) => {
      const lines = createInterface({ input });
      lines.once("line", (line) => {
        resolve(line); // before close(), whose handler would resolve first with ""
        lines.close();
      });
      lines.once("close", () => resolve(""));
    });
  }
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve) => {
    let typed = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          resolve(typed);
          return;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        typed = ch === "\u007f" ? typed.slice(0, -1) : typed + ch;
      }
    };
    input.on("data", onData);
  });
}
