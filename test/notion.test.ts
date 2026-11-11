/** Notion pages and databases, against a fake Notion API. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const exec = promisify(execFile);
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
const ROOT = id(1);
const CHILD = id(2);
const DB = id(3);
const ROW = id(4);
const OUTSIDE = id(5);
const LIST = id(6);
const TABLE = id(7);

let base: string;
let server: Server;
let apiUrl: string;
const state = { childEdited: "2026-11-01T10:00:00.000Z", childText: "Child text" };

const text = (content: string, extra: Record<string, unknown> = {}) => [{ plain_text: content, href: null, annotations: {}, ...extra }];
const block = (blockId: string, type: string, value: Record<string, unknown>, children = false) => ({ id: blockId, type, has_children: children, [type]: value });
const page = (pageId: string, title: string, parent: Record<string, unknown>, edited = "2026-11-01T10:00:00.000Z", extra: Record<string, unknown> = {}) => ({
  object: "page",
  id: pageId,
  url: `https://www.notion.so/${title.replace(/ /g, "-")}-${pageId.replace(/-/g, "")}`,
  last_edited_time: edited,
  parent,
  properties: { Name: { type: "title", title: text(title) }, ...extra },
});

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-notion-")));
  server = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.headers.authorization !== "Bearer ntn_test" || request.headers["notion-version"] !== "2022-06-28") return json(401, { message: "API token is invalid." });
    const p = new URL(request.url ?? "/", "http://x").pathname.replace("/v1", "");
    const list = (results: unknown[]) => json(200, { results, has_more: false, next_cursor: null });

    if (p === "/users/me") return json(200, { name: "dev", bot: { workspace_name: "Acme" } });
    if (p === `/pages/${ROOT}`) return json(200, page(ROOT, "Handbook", { type: "workspace" }));
    if (p === `/pages/${CHILD}`) return json(200, page(CHILD, "Onboarding", { type: "page_id", page_id: ROOT }, state.childEdited));
    if (p === `/pages/${ROW}`) return json(200, page(ROW, "Ship it", { type: "database_id", database_id: DB }));
    if (p === `/pages/${OUTSIDE}`) return json(200, page(OUTSIDE, "Other team", { type: "workspace" }));
    if (p === `/blocks/${ROOT}/children`) {
      return list([
        block("b1", "paragraph", { rich_text: [...text("Read the "), ...text("guide", { href: "https://example.test/guide", annotations: { bold: true } })] }),
        block("b2", "heading_2", { rich_text: text("Steps") }),
        block(LIST, "bulleted_list_item", { rich_text: text("First") }, true),
        block("b4", "to_do", { rich_text: text("Done thing"), checked: true }),
        block("b5", "code", { rich_text: text("npm test"), language: "bash" }),
        block(TABLE, "table", {}, true),
        block("b7", "image", { type: "file", file: { url: "https://s3.example/x.png?expires" }, caption: text("Diagram") }),
        block(CHILD, "child_page", { title: "Onboarding" }),
        block(DB, "child_database", { title: "Tasks" }),
      ]);
    }
    if (p === `/blocks/${LIST}/children`) return list([block("b3a", "bulleted_list_item", { rich_text: text("Nested") })]);
    if (p === `/blocks/${TABLE}/children`) return list([block("r1", "table_row", { cells: [text("A"), text("B")] }), block("r2", "table_row", { cells: [text("1"), text("2")] })]);
    if (p === `/blocks/${CHILD}/children`) return list([block("c1", "paragraph", { rich_text: text(state.childText) })]);
    if (p === `/blocks/${ROW}/children` || p === `/blocks/${OUTSIDE}/children`) return list([]);
    if (p === `/databases/${DB}`) return json(200, { id: DB, url: "https://www.notion.so/tasks", last_edited_time: "2026-11-01T10:00:00.000Z", title: text("Tasks"), parent: { type: "page_id", page_id: ROOT } });
    if (p === `/databases/${DB}/query`) return list([page(ROW, "Ship it", { type: "database_id", database_id: DB }, "2026-11-01T10:00:00.000Z", { Status: { type: "status", status: { name: "In progress" } } })]);
    return json(404, { message: "Could not find" });
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
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_NOTION_API_URL: apiUrl, DEV_NOTION_TOKEN: "ntn_test", DEV_GITHUB_TOKEN: "x" },
      timeout: 60_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

function workspace(): string {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  writeFileSync(path.join(root, "dev.yaml"), `version: 1\nversioning: { service: github:github, repo: acme/web }\nservices:\n  - service: notion:notion\n    scope: { pages: ["https://www.notion.so/Handbook-${ROOT.replace(/-/g, "")}"] }\n`);
  return root;
}

const handbook = (root: string) => path.join(root, "notion", "Handbook-000000010000");

test("a Notion page tree is mirrored with its child pages, databases and rows", async () => {
  const root = workspace();
  const synced = await dev(root, ["sync", "notion"]);
  assert.equal(synced.code, 0, synced.err);
  assert.match(synced.out, /Notion: 4 new, 0 updated, 0 removed\./);

  const text = readFileSync(path.join(handbook(root), "index.md"), "utf8");
  assert.match(text, /^---\nid: 00000001-0000-0000-0000-000000000000\ntitle: Handbook\nservice: notion:notion\n/);
  assert.match(text, /Read the \[\*\*guide\*\*\]\(https:\/\/example\.test\/guide\)/);
  assert.match(text, /### Steps/);
  assert.match(text, /- First\n {4}- Nested/);
  assert.match(text, /- \[x\] Done thing/);
  assert.match(text, /```bash\nnpm test\n```/);
  assert.match(text, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(text, /_image: Diagram \(stored in Notion\)_/, "expiring file links aren't written");
  assert.match(text, /\[Onboarding\]\(Onboarding-000000020000\/index\.md\)/);

  assert.match(readFileSync(path.join(handbook(root), "Onboarding-000000020000", "index.md"), "utf8"), /Child text/);
  const row = readFileSync(path.join(handbook(root), "Tasks-000000030000", "Ship_it-000000040000", "index.md"), "utf8");
  assert.match(row, /properties:\n {2}Status: In progress/);
  assert.match(readFileSync(path.join(root, "notion", "index.md"), "utf8"), /4 items\./);
});

test("only pages edited since the last sync are fetched again", async () => {
  const root = workspace();
  await dev(root, ["sync", "notion"]);
  assert.match((await dev(root, ["sync", "notion"])).out, /Notion: 0 new, 0 updated/);

  state.childEdited = "2026-11-09T10:00:00.000Z";
  state.childText = "Changed child";
  try {
    assert.match((await dev(root, ["sync", "notion"])).out, /Notion: 0 new, 1 updated/);
    assert.match(readFileSync(path.join(handbook(root), "Onboarding-000000020000", "index.md"), "utf8"), /Changed child/);
  } finally {
    state.childEdited = "2026-11-01T10:00:00.000Z";
    state.childText = "Child text";
  }
});

test("Notion links are recognised, and pages outside the scope aren't fetched", async () => {
  const { notionService } = await import("../src/plugins/notion/index.ts");
  const found = notionService.links?.find(`See https://www.notion.so/acme/Ship-it-${ROW.replace(/-/g, "")}?pvs=4 and https://acme.notion.site/x?p=${OUTSIDE.replace(/-/g, "")}`, {} as never);
  assert.deepEqual(found?.map((r) => r.id), [ROW, OUTSIDE]);
  assert.deepEqual(notionService.links?.find(`[Parent](https://app.notion.com/p/${ROW.replace(/-/g, "")}) and https://www.notion.com/help`, {} as never).map((r) => r.id), [ROW], "the newer app.notion.com addresses count, pages without an id don't");

  const root = workspace();
  const context = { root, folder: path.join(root, "notion"), scope: { pages: [ROOT] }, settings: { fetch: "within-scope", sync: "full" }, credentials: () => ({ token: "ntn_test" }), out: { info() {}, warn() {} }, localize: async (body: string) => body } as never;
  process.env.DEV_NOTION_API_URL = apiUrl;
  try {
    await assert.rejects(notionService.links!.fetch(context, { service: "notion:notion", id: OUTSIDE }), /outside this workspace's scope/);
    const file = await notionService.links!.fetch(context, { service: "notion:notion", id: ROW });
    assert.ok(existsSync(file), "a row under a database under the root is in scope");
  } finally {
    delete process.env.DEV_NOTION_API_URL;
  }
});

test("pull writes one page again, by its file, link or id, even when Notion says it's unchanged", async () => {
  const root = workspace();
  await dev(root, ["sync", "notion"]);
  const file = path.join(handbook(root), "Onboarding-000000020000", "index.md");

  state.childText = "Edited without a new timestamp";
  try {
    assert.match((await dev(root, ["sync", "notion"])).out, /Notion: 0 new, 0 updated/, "a sync trusts the timestamp");
    const pulled = await dev(root, ["notion", "pull", file]);
    assert.equal(pulled.code, 0, pulled.err);
    assert.match(pulled.out, /notion\/Handbook-000000010000\/Onboarding-000000020000\/index\.md/);
    assert.match(readFileSync(file, "utf8"), /Edited without a new timestamp/);
    assert.match(readFileSync(file, "utf8"), /via: scope/, "it keeps why it's here");
  } finally {
    state.childText = "Child text";
  }
  assert.match((await dev(root, ["notion", "pull", "nonsense"])).err, /isn't a Notion link, an id, or a page's file/);
  assert.match((await dev(root, ["notion", "pull", OUTSIDE])).err, /outside this workspace's scope[^]*dev notion scope add/);
});
