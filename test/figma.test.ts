/** Figma: recording designs, and spotting changes through the REST API or the local MCP. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { parseLink } from "../src/plugins/figma/index.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");
const exec = promisify(execFile);
const LINK = "https://www.figma.com/design/AbC123xyz/Design-System?node-id=12-34&t=x";

let base: string;
let rest: Server;
let mcp: Server;
let restUrl: string;
let mcpUrl: string;
const design = { name: "Login card", color: "blue", mcpName: "Login card", mcpWidth: 320 };

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-figma-")));
  rest = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.headers["x-figma-token"] !== "figd_test") return json(403, { err: "Invalid token" });
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/v1/me") return json(200, { email: "me@example.test" });
    if (url.pathname === "/v1/files/AbC123xyz/nodes") {
      return json(200, { name: "Design System", lastModified: "2026-11-08T10:00:00Z", nodes: { "12:34": { document: { id: "12:34", name: design.name, fills: [design.color] } } } });
    }
    return json(404, {});
  });
  // A local MCP server that answers like Figma desktop's: a session id and server-sent events.
  mcp = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const message = JSON.parse(raw) as { id?: number; method: string };
      const send = (result: unknown) =>
        response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
      if (message.method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake" } });
      if (message.method === "tools/call") {
        return send({ content: [{ type: "text", text: `<frame id="12:34" name="${design.mcpName}" x="0" y="0" width="${design.mcpWidth}" height="100" />IMPORTANT: advice that changes every time ${Math.random()}` }] });
      }
      response.writeHead(202).end();
    });
  });
  restUrl = await listen(rest);
  mcpUrl = await listen(mcp);
});

after(() => {
  rest.close();
  mcp.close();
  rmSync(base, { recursive: true, force: true });
});

async function dev(cwd: string, args: string[], extra: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_EXTRA_PLUGINS: PLUGIN, DEV_EXAMPLE_TOKEN: "good", DEV_FIGMA_API_URL: restUrl, DEV_FIGMA_MCP_URL: mcpUrl, ...extra },
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
  writeFileSync(path.join(root, "dev.yaml"), "version: 1\nversioning: { service: example:code, repo: acme/web }\nservices:\n  - service: figma:figma\n");
  return root;
}

const designFile = (root: string) => path.join(root, "figma", "AbC123xyz-12-34", "design.md");

test("Figma links are read for their file and frame, including branches and encoded ids", () => {
  assert.deepEqual(parseLink(LINK), { fileKey: "AbC123xyz", nodeId: "12:34", fileSlug: "Design System", url: LINK });
  assert.equal(parseLink("https://figma.com/design/AbC/branch/BrAnCh/Name?node-id=1%3A2")?.fileKey, "BrAnCh");
  assert.equal(parseLink("https://figma.com/design/AbC/branch/BrAnCh/Name?node-id=1%3A2")?.nodeId, "1:2");
  assert.equal(parseLink("https://www.figma.com/proto/Key9/x?node-id=5-6&amp;scaling=x")?.nodeId, "5:6");
  assert.equal(parseLink("https://figma.com/design/Key9/Whole-file")?.nodeId, "");
  assert.equal(parseLink("https://example.com/design/x"), null);
});

test("adding Figma doesn't need a login, and the workspace gets the local MCP server", async () => {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  writeFileSync(path.join(root, "dev.yaml"), "version: 1\nversioning: { service: example:code, repo: acme/web }\nservices: []\n");
  const added = await dev(root, ["add", "figma", "--scope", "{}"]);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /Figma: skipped the login\. With one, dev can check designs for changes without Figma desktop running\. Log in any time with "dev login figma"\./);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers["figma-desktop"], { type: "http", url: mcpUrl });
  assert.ok(existsSync(path.join(root, ".claude", "skills", "figma-designs", "SKILL.md")));
  const doctor = await dev(root, ["doctor", "--offline"]);
  assert.doesNotMatch(doctor.out, /not logged in to Figma/);
  assert.match(doctor.out, /Figma: no login, which is fine/);
});

test("with a token, a sync spots when the frame's content changes", async () => {
  const root = workspace();
  const pulled = await dev(root, ["figma", "pull", LINK]);
  assert.equal(pulled.code, 0, pulled.err);
  assert.match(readFileSync(designFile(root), "utf8"), /Use the local Figma MCP with node id `12:34`/);

  const env = { DEV_FIGMA_TOKEN: "figd_test" };
  const first = await dev(root, ["sync", "figma"], env);
  assert.equal(first.code, 0, first.err);
  let text = readFileSync(designFile(root), "utf8");
  assert.match(text, /^---\nid: AbC123xyz:12:34\ntitle: Login card\n/, "the frame's real name");
  assert.match(text, /fingerprintVia: rest/);
  assert.doesNotMatch(text, /changed:/, "the first look is only a baseline");

  assert.doesNotMatch((await dev(root, ["sync", "figma"], env)).out, /Design changed/);
  design.color = "red";
  try {
    const second = await dev(root, ["sync", "figma"], env);
    assert.match(second.out, /Design changed: Login card/);
    assert.match(second.out, /Figma: 0 new, 1 updated/);
    text = readFileSync(designFile(root), "utf8");
    assert.match(text, /changed: \d{4}-/);
    await dev(root, ["day", "start", "--no-sync"]);
    assert.match(readFileSync(path.join(root, "snapshot.md"), "utf8"), /## Designs changed this week\n\n- \[Login card\]\(figma\/AbC123xyz-12-34\/design\.md\)/);
  } finally {
    design.color = "blue";
  }
});

test("without a token, the local MCP is used, and a frame with another name isn't trusted", async () => {
  const root = workspace();
  await dev(root, ["figma", "pull", LINK]);

  await dev(root, ["figma", "check"]);
  assert.match(readFileSync(designFile(root), "utf8"), /fingerprintVia: mcp/);
  assert.doesNotMatch((await dev(root, ["figma", "check"])).out, /Design changed/, "the tool's own advice isn't part of the fingerprint");

  design.mcpWidth = 400;
  try {
    assert.match((await dev(root, ["figma", "check"])).out, /Design changed: Login card/);
  } finally {
    design.mcpWidth = 320;
  }

  design.mcpName = "Something else";
  try {
    assert.match(
      (await dev(root, ["figma", "check"])).out,
      /1 design not checked, since this file isn't open in Figma desktop:\n {4}Design System: https:\/\/www\.figma\.com\/design\/AbC123xyz\n {6}Login card \(frame 12:34\)\n {2}Open a file in Figma desktop and run "dev figma check"/,
    );
  } finally {
    design.mcpName = "Login card";
  }

  const offline = await dev(root, ["figma", "check"], { DEV_FIGMA_MCP_URL: "http://127.0.0.1:9/mcp" });
  assert.match(offline.out, /designs not checked for changes\. Log in with a token/);
});

test("the scope can limit which Figma files are recorded", async () => {
  const root = workspace();
  assert.equal((await dev(root, ["figma", "scope", "add", "https://figma.com/design/OtherKey99/x"])).code, 0);
  const refused = await dev(root, ["figma", "pull", LINK]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /outside this workspace's scope/);
});
