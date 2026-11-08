/** GitHub Projects as a task source, against a fake GraphQL endpoint. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const exec = promisify(execFile);
let base: string;
let server: Server;
let apiUrl: string;
const state = { scopes: true };

const field = (name: string, value: Record<string, unknown>) => ({ ...value, field: { name } });
const items = [
  { id: "I1", updatedAt: "2026-11-08T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "In progress" }), field("Due date", { date: "2026-11-20" }), field("Title", { text: "x" })] }, content: { __typename: "Issue", number: 5, title: "Login button", body: "See the spec.", url: "https://github.com/acme/web/issues/5", state: "OPEN", repository: { nameWithOwner: "acme/web" }, assignees: { nodes: [{ login: "me" }] } } },
  { id: "D1", updatedAt: "2026-11-08T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "Todo" })] }, content: { __typename: "DraftIssue", title: "Try a new layout", body: "", assignees: { nodes: [{ login: "me" }] } } },
  { id: "P1", updatedAt: "2026-11-08T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "In review" })] }, content: { __typename: "PullRequest", number: 9, title: "Someone's PR", url: "https://github.com/acme/web/pull/9", state: "OPEN", repository: { nameWithOwner: "acme/web" }, assignees: { nodes: [{ login: "kim" }] } } },
  { id: "I2", updatedAt: "2026-11-01T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "Done" })] }, content: { __typename: "Issue", number: 2, title: "Old work", url: "https://github.com/acme/web/issues/2", state: "CLOSED", repository: { nameWithOwner: "acme/web" }, assignees: { nodes: [{ login: "me" }] } } },
];

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-projects-")));
  server = createServer((request, response) => {
    const json = (body: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/user") return json({ login: "me" });
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const { variables } = JSON.parse(raw) as { variables: { owner: string; number: number } };
      if (!state.scopes) return json({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project']" }] });
      if (variables.owner === "acme" && variables.number === 3) {
        return json({ data: { organization: { projectV2: { title: "Sprint board", url: "https://github.com/orgs/acme/projects/3", items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: items } } }, user: null } });
      }
      return json({ data: { organization: null, user: null }, errors: [{ message: "Could not resolve" }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(base, { recursive: true, force: true });
});

async function dev(cwd: string, args: string[]) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_GITHUB_API_URL: apiUrl, DEV_GITHUB_TOKEN: "ghp_fake" },
      timeout: 60_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

function workspace(scope: string): string {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  writeFileSync(path.join(root, "dev.yaml"), `version: 1\nversioning: { service: github:github, repo: acme/web }\nservices:\n  - service: github:github-projects\n    scope: ${scope}\n`);
  return root;
}

test("board items you're assigned become tasks, with the board's own fields", async () => {
  const root = workspace("{ projects: [acme/3] }");
  const synced = await dev(root, ["sync", "github-projects"]);
  assert.equal(synced.code, 0, synced.err);
  assert.match(synced.out, /GitHub Projects: 3 new/);

  const item = readFileSync(path.join(root, "github-projects", "acme-3", "acme-web-5", "item.md"), "utf8");
  assert.match(item, /^---\nid: acme\/web#5\ntitle: Login button\nservice: github:github-projects\n/);
  assert.match(item, /status: In progress\nboard: acme\/3\ntype: issue\nfields:\n {2}Status: In progress\n {2}Due date: 2026-11-20\n/);
  assert.match(item, /mine: true\ndone: false\ndue: 2026-11-20/);
  assert.doesNotMatch(item, /Title: x/, "the built-in title field isn't repeated");

  const list = await dev(root, ["task", "list", "--mine"]);
  assert.match(list.out, /GitHub Projects, as of .*: 2 tasks\n {2}acme\/web#5 {2}\[In progress\] {2}Login button {2}· due 2026-11-20 · mine/);
  assert.match(list.out, /draft-\w+ {2}\[Todo\] {2}Try a new layout/);
  assert.doesNotMatch(list.out, /Old work/, "done items aren't listed as work");
  assert.match((await dev(root, ["task", "list", "--all"])).out, /Old work/);
});

test("every item can be kept, boards are added by link, and a missing scope says how to fix it", async () => {
  const root = workspace("{ projects: [acme/3], assigned: any }");
  assert.match((await dev(root, ["sync", "github-projects"])).out, /4 new/);

  assert.match((await dev(root, ["github-projects", "scope", "add", "https://github.com/users/me/projects/7"])).out, /Done: added me\/7/);
  const missing = await dev(root, ["sync", "github-projects"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /me\/7: There's no GitHub project me\/7/);

  state.scopes = false;
  try {
    const denied = await dev(root, ["sync", "github-projects"]);
    assert.match(denied.err, /can't read projects\.[^]*gh auth refresh -s read:project/);
  } finally {
    state.scopes = true;
  }
});
