/** GitHub Projects as a task source, against a fake GraphQL endpoint. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
/** Attachment downloads, with whether each carried a login. */
const downloads: Array<{ path: string; authorized: boolean }> = [];
const UPLOAD = "25addea2-357a-42c0-a1c8-fba0163382cc";

const field = (name: string, value: Record<string, unknown>) => ({ ...value, field: { name } });
const items = [
  { id: "I1", updatedAt: "2026-11-08T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "In progress" }), field("Due date", { date: "2026-01-01" }), field("Title", { text: "x" })] }, content: {
      __typename: "Issue", number: 5, title: "Login button", url: "https://github.com/acme/web/issues/5", state: "OPEN", repository: { nameWithOwner: "acme/web" }, assignees: { nodes: [{ login: "me" }] },
      // WEB is the fake server. A private image only downloads from the signed address in the HTML.
      body: `See the spec.\n\n![The mockup](WEB/user-attachments/assets/${UPLOAD})`,
      bodyHTML: `<p>See the spec.</p><a href="WEB/signed/1/2-${UPLOAD}.png?jwt=abc&amp;x=1"><img src="WEB/signed/1/2-${UPLOAD}.png?jwt=abc&amp;x=1" alt="The mockup"></a>`,
      comments: {
        totalCount: 3,
        nodes: [
          { author: { login: "kim" }, createdAt: "2026-11-08T11:00:00Z", body: "Logs: [notes.txt](WEB/user-attachments/files/7/notes.txt)", bodyHTML: "" },
          { author: { login: "me" }, createdAt: "2026-11-08T12:00:00Z", body: "And [private.log](WEB/user-attachments/files/8/private.log)", bodyHTML: "" },
        ],
      },
    } },
  { id: "D1", updatedAt: "2026-11-08T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "Todo" })] }, content: { __typename: "DraftIssue", title: "Try a new layout", body: "", assignees: { nodes: [{ login: "me" }] } } },
  { id: "P1", updatedAt: "2026-11-08T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "In review" })] }, content: { __typename: "PullRequest", number: 9, title: "Someone's PR", url: "https://github.com/acme/web/pull/9", state: "OPEN", repository: { nameWithOwner: "acme/web" }, assignees: { nodes: [{ login: "kim" }] } } },
  { id: "I2", updatedAt: "2026-11-01T10:00:00Z", fieldValues: { nodes: [field("Status", { name: "Done" })] }, content: { __typename: "Issue", number: 2, title: "Old work", url: "https://github.com/acme/web/issues/2", state: "CLOSED", repository: { nameWithOwner: "acme/web" }, assignees: { nodes: [{ login: "me" }] } } },
];

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-projects-")));
  server = createServer((request, response) => {
    const json = (body: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/user") return json({ login: "me" });
    if (request.method === "GET") {
      downloads.push({ path: request.url ?? "", authorized: Boolean(request.headers.authorization) });
      if (request.url === `/signed/1/2-${UPLOAD}.png?jwt=abc&x=1`) return response.writeHead(200, { "content-type": "image/png" }).end("PNG");
      if (request.url === "/user-attachments/files/7/notes.txt") return response.writeHead(200, { "content-type": "text/plain" }).end("notes");
      if (request.url === "/user-attachments/files/8/private.log") return response.writeHead(302, { location: "/login" }).end();
      if (request.url === "/login") return response.writeHead(200, { "content-type": "text/html" }).end("<html>Sign in</html>");
      return response.writeHead(404).end();
    }
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const { variables } = JSON.parse(raw) as { variables: { owner: string; number: number } };
      if (!state.scopes) return json({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project']" }] });
      if (variables.owner === "acme" && variables.number === 3) {
        const board = { data: { organization: { projectV2: { title: "Sprint board", url: "https://github.com/orgs/acme/projects/3", items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: items } } }, user: null } };
        return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(board).replaceAll("WEB", apiUrl));
      }
      return json({ data: { organization: null, user: null }, errors: [{ message: "Could not resolve" }] });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
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
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_GITHUB_API_URL: apiUrl, DEV_GITHUB_WEB_URL: apiUrl, DEV_GITHUB_TOKEN: "ghp_fake" },
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
  assert.match(item, /status: In progress\nboard: acme\/3\ntype: issue\nfields:\n {2}Status: In progress\n {2}Due date: 2026-01-01\n/);
  assert.match(item, /mine: true\ndone: false\ndue: 2026-01-01/);
  assert.doesNotMatch(item, /Title: x/, "the built-in title field isn't repeated");

  const list = await dev(root, ["task", "list", "--mine"]);
  assert.match(list.out, /GitHub Projects, as of .*: 2 tasks\n {2}acme\/web#5 {2}\[In progress\] {2}Login button {2}· due 2026-01-01, overdue · mine/);
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

test("an item keeps its latest comments, and its attachments sit beside it, fetched without the login", async () => {
  const root = workspace("{ projects: [acme/3] }");
  downloads.length = 0;
  const synced = await dev(root, ["sync", "github-projects"]);
  assert.equal(synced.code, 0, synced.err);
  assert.match(synced.err, /acme\/web#5: Couldn't download "private\.log": GitHub answered with a sign-in page/);

  const dir = path.join(root, "github-projects", "acme-3", "acme-web-5");
  const item = readFileSync(path.join(dir, "item.md"), "utf8");
  const image = item.match(/!\[The mockup\]\((attachments\/The%20mockup-\w+\.png)\)/)?.[1];
  assert.ok(image, item);
  assert.equal(readFileSync(path.join(dir, decodeURI(image)), "utf8"), "PNG");
  const notes = item.match(/\[notes\.txt\]\((attachments\/notes-\w+\.txt)\)/)?.[1];
  assert.ok(notes, item);
  assert.equal(readFileSync(path.join(dir, notes), "utf8"), "notes");
  assert.match(item, /\[private\.log\]\(http:\/\/127\.0\.0\.1:\d+\/user-attachments\/files\/8\/private\.log\)/, "one that failed keeps its link");
  assert.match(item, /attachments: 2\nattachmentsFailed: 1\n/);
  assert.match(item, /## Comments \(3\)\n\n_The last 2; the rest are on GitHub: https:\/\/github\.com\/acme\/web\/issues\/5_\n\n### kim · 2026-11-08 11:00\n\nLogs:/);
  assert.ok(downloads.length > 0 && downloads.every((d) => !d.authorized), "the token never goes with a download");
  assert.ok(!downloads.some((d) => d.path === `/user-attachments/assets/${UPLOAD}`), "the signed address is used");

  const draftDir = readdirSync(path.join(root, "github-projects", "acme-3")).find((name) => name.startsWith("draft-"));
  assert.ok(draftDir);
  assert.doesNotMatch(readFileSync(path.join(root, "github-projects", "acme-3", draftDir, "item.md"), "utf8"), /## Comments/, "a draft can't have comments");

  downloads.length = 0;
  assert.equal((await dev(root, ["sync", "github-projects"])).code, 0);
  assert.deepEqual(downloads.map((d) => d.path).filter((p) => !p.includes("private.log") && p !== "/login"), [], "what's kept isn't downloaded again");
});

test("attachments can be left out", async () => {
  const root = workspace("{ projects: [acme/3], attachments: false }");
  downloads.length = 0;
  assert.equal((await dev(root, ["sync", "github-projects"])).code, 0);
  assert.deepEqual(downloads, []);
  const item = readFileSync(path.join(root, "github-projects", "acme-3", "acme-web-5", "item.md"), "utf8");
  assert.match(item, /user-attachments\/assets\//);
  assert.doesNotMatch(item, /^attachments:/m);
});
