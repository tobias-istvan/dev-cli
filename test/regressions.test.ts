import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { atomicWriteSync, safePath } from "../src/core/files.ts";
import { DEFAULT_POLICY, classifiers, judge } from "../src/core/command-check.ts";
import { loadRegistry } from "../src/plugins/registry.ts";
import { createRedactor, recordSession, saveSession } from "../src/core/sessions/index.ts";
import { renderSession } from "../src/core/sessions/render.ts";
import { loadCredentials, removeCredentials, saveCredentials } from "../src/core/credentials.ts";
import { dayDir } from "../src/core/day.ts";
import { markRefresh, refreshState } from "../src/core/refresh.ts";
import { reviewCurrent } from "../src/core/reviews.ts";
import { scaffold } from "../src/core/scaffold.ts";
import { taskId } from "../src/core/tasks.ts";
import { addAgentFiles, copyLocalFiles, inspectWorktree } from "../src/core/worktree.ts";
import { AtlassianClient } from "../src/plugins/atlassian/client.ts";
import { GitHubApi } from "../src/plugins/github/api.ts";
import { confluence } from "../src/plugins/atlassian/confluence.ts";
import { projects } from "../src/plugins/github/projects.ts";
import { notionService } from "../src/plugins/notion/index.ts";
import type { ServiceContext } from "../src/plugins/types.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
const root = mkdtempSync(path.join(tmpdir(), "dev-regression-"));
after(() => rmSync(root, { recursive: true, force: true }));
const fixture = () => mkdtempSync(path.join(root, "case-"));
const registry = await loadRegistry();
const quiet = { info() {}, warn() {} };
function context(dir: string, service: string, scope: Record<string, unknown>): ServiceContext {
  return { root: dir, folder: path.join(dir, service), interactive: false, scope, settings: { fetch: "within-scope", sync: "full" }, credentials: () => ({ token: "synthetic", email: "test@example.test", site: "https://service.invalid" }), out: quiet, references: async () => [], localize: async (body) => body };
}

test("compact API writes and commented mutations never receive read permission", () => {
  const map = classifiers(registry);
  for (const command of ["glab api projects/1 -XDELETE", "gh api repos/o/r/issues -ftitle=hello", "gh api repos/o/r/issues --input=payload.json", "gh api graphql -f 'query=# comment\nmutation { deleteIssue(input: {issueId: \"X\"}) { clientMutationId } }'"]) {
    assert.notEqual(judge(command, DEFAULT_POLICY, map).decision, "allow", command);
    assert.notEqual(judge(command, { ...DEFAULT_POLICY, change: "deny", unknown: "deny" }, map).decision, "allow", command);
  }
  assert.equal(judge("dev jira scope --set='{project: ABC, jql: x}'", { ...DEFAULT_POLICY, config: "deny" }, map).decision, "deny");
});

test("final session serialization redacts descriptions, metadata and inactive account secrets", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = fixture();
  try {
    saveCredentials("github", "first", { token: "synthetic-inactive-secret" });
    saveCredentials("github", "second", { token: "synthetic-active-secret" });
    const rendered = renderSession([{ type: "assistant", timestamp: "2026-11-09T00:00:00Z", gitBranch: "synthetic-inactive-secret", message: { content: [{ type: "tool_use", name: "synthetic-active-secret", input: { command: "true", description: "synthetic-inactive-secret" } }] } }], { thinking: false, sidechains: false, maxOutputLines: 40 }, "claude", createRedactor(registry));
    assert.doesNotMatch(rendered.markdown, /synthetic-(inactive|active)-secret/);
  } finally { process.env.XDG_CONFIG_HOME = previous; }
});

test("session exports require local provenance and full session IDs do not collide", async () => {
  const dir = fixture();
  const a = await recordSession(dir, { tool: "claude", sessionId: "aaaaaaaa-1", cwd: dir, reason: null, standDown: false, raw: {} }, "start");
  const b = await recordSession(dir, { tool: "claude", sessionId: "aaaaaaaa-2", cwd: dir, reason: null, standDown: false, raw: {} }, "start");
  assert.notEqual(a, b);
  const ref = JSON.parse(readFileSync(path.join(a!, "session-ref.json"), "utf8"));
  assert.equal(await saveSession(dir, a!, { ...ref, workingDir: "../other" }, registry), false);
  assert.equal(await saveSession(dir, a!, { ...ref, sessionId: "../target" }, registry), false);
  assert.equal(await saveSession(dir, a!, { ...ref, sessionId: "unrecorded" }, registry), false);
});

test("containment blocks traversal, symlink copies and generated-record deletion outside root", async () => {
  const dir = fixture();
  const outside = path.join(dir, "victim.txt");
  writeFileSync(outside, "keep");
  const workspace = path.join(dir, "workspace");
  mkdirSync(path.join(workspace, ".dev"), { recursive: true });
  writeFileSync(path.join(workspace, ".dev/generated.json"), JSON.stringify({ "../victim.txt": createHash("sha256").update("keep").digest("hex") }));
  assert.throws(() => scaffold(workspace, { version: 1, services: [], conventions: {} }, registry, []), /inside/);
  assert.equal(readFileSync(outside, "utf8"), "keep");
  symlinkSync(dir, path.join(workspace, "escape"));
  assert.throws(() => safePath(workspace, "escape/victim.txt"), /symlink/);
  assert.throws(() => dayDir(workspace, "../../escape"), /date/i);
  assert.throws(() => dayDir(workspace, "2026-02-30"), /date/i);
  const worktree = fixture();
  symlinkSync(dir, path.join(worktree, ".github"));
  await assert.rejects(addAgentFiles(workspace, worktree), /symlink/);
  const repo = fixture();
  symlinkSync(outside, path.join(repo, ".env.local"));
  await assert.rejects(copyLocalFiles(repo, worktree, [".env.local"]), /symlink/);
});

test("failed atomic replacement leaves prior bytes intact", () => {
  const file = path.join(fixture(), "state.json");
  atomicWriteSync(file, "original");
  assert.throws(() => atomicWriteSync(file, { invalid: true } as never));
  assert.equal(readFileSync(file, "utf8"), "original");
});

test("foreign API URLs and pagination cannot receive credentials", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json([], { headers: { link: '<https://foreign.invalid/next>; rel="next"' } }); };
  try {
    await assert.rejects(new AtlassianClient({ url: "https://service.invalid", email: "a", token: "fake" }).get("https://foreign.invalid/file"), /origin/);
    assert.equal(calls, 0);
    await assert.rejects(new GitHubApi("fake").list("/user/repos"), /origin/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("exclusive sync ownership rejects a second writer and release clears only its marker", () => {
  const dir = fixture();
  const clear = markRefresh(dir, "first");
  assert.equal(refreshState(dir).running, true);
  assert.throws(() => markRefresh(dir, "second"), /already running/);
  clear();
  assert.equal(refreshState(dir).running, false);
});

test("a dead owner's sync marker is reclaimed on acquisition, and Ctrl-C releases a live one", async () => {
  const dir = fixture();
  const marker = path.join(dir, ".dev", "state", "sync.json");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ pid: 2147483646, started: new Date().toISOString(), command: "dev sync" }));
  assert.equal(refreshState(dir).running, false);
  assert.ok(existsSync(marker), "reading the state never removes it");
  const clear = markRefresh(dir, "next");
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).command, "next");
  clear();

  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const { markRefresh } = await import(${JSON.stringify(path.join(import.meta.dirname, "..", "src", "core", "refresh.ts"))}); markRefresh(${JSON.stringify(dir)}, "held"); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("ready")) resolve(); }));
  assert.equal(refreshState(dir).running, true);
  child.kill("SIGINT");
  const [, signal] = await once(child, "exit");
  assert.equal(signal, "SIGINT", "it still dies of the signal");
  assert.ok(!existsSync(marker), "and its marker is gone");
});

test("old review remains stale after metadata sync until review contents change", () => {
  const dir = fixture();
  const review = path.join(dir, "review.md");
  writeFileSync(review, "review one");
  assert.equal(reviewCurrent(dir, "pr-1", review, "revision-one"), true);
  assert.equal(reviewCurrent(dir, "pr-1", review, "revision-two"), false);
  assert.equal(reviewCurrent(dir, "pr-1", review, "revision-two"), false);
  writeFileSync(review, "review two");
  assert.equal(reviewCurrent(dir, "pr-1", review, "revision-two"), true);
});

test("failed worktree inspection throws rather than declaring unique commits safe", async () => {
  const dir = fixture();
  const worktree = path.join(dir, "worktrees/task");
  mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: worktree });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "unique"], { cwd: worktree });
  await assert.rejects(inspectWorktree(dir, "task", "missing-base"), /git .*failed/);
  assert.ok(existsSync(path.join(worktree, ".git")));
});

test("Confluence preserves notes and departed pages and migrates a renamed root", async () => {
  const dir = fixture();
  const ctx = context(dir, "confluence", { roots: ["100"], attachments: false });
  const original = globalThis.fetch;
  let includeChild = true;
  let title = "Root";
  globalThis.fetch = async (value) => {
    const p = new URL(String(value)).pathname;
    if (p.endsWith("/descendants")) return Response.json({ results: includeChild ? [{ id: "101", title: "Child", type: "page", parentId: "100" }] : [] });
    if (p.endsWith("/spaces/1")) return Response.json({ key: "DOCS" });
    const child = p.endsWith("/101");
    return Response.json({ id: child ? "101" : "100", title: child ? "Child" : title, spaceId: "1", version: { number: 1, createdAt: "2026-11-01" }, body: { storage: { value: "<p>content</p>" } } });
  };
  try {
    assert.deepEqual((await confluence.sync!(ctx, { full: false })).failed, []);
    const tree = path.join(dir, "confluence/DOCS/Root-100");
    writeFileSync(path.join(tree, "research.md"), "notes");
    includeChild = false;
    title = "Renamed";
    assert.deepEqual((await confluence.sync!(ctx, { full: false })).failed, []);
    const moved = path.join(dir, "confluence/DOCS/Renamed-100");
    assert.equal(readFileSync(path.join(moved, "research.md"), "utf8"), "notes");
    assert.match(readFileSync(path.join(moved, "Child-101/index.md"), "utf8"), /via: former/);
    assert.equal(existsSync(tree), false);
  } finally { globalThis.fetch = original; }
});

test("failed board enumeration preserves the last known scope", async () => {
  const dir = fixture();
  const ctx = context(dir, "github-projects", { projects: ["acme/1"] });
  const file = path.join(ctx.folder!, "acme-1/issue/item.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '---\nid: acme/web#1\ntitle: Work\nservice: github:github-projects\nurl: u\nupdated: x\nsynced: y\nboard: acme/1\ninScope: true\n---\nbody');
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith("/user") ? Response.json({ login: "me" }) : Response.json({ errors: [{ message: "temporary failure" }] });
  try {
    assert.equal((await projects.sync!(ctx, { full: false })).failed.length, 1);
    assert.match(readFileSync(file, "utf8"), /inScope: true/);
  } finally { globalThis.fetch = original; }
});

test("Notion re-added unchanged roots regain scope and retained children survive failed reads", async () => {
  const dir = fixture();
  const id = "00000001-0000-0000-0000-000000000000";
  const ctx = context(dir, "notion", { pages: [id] });
  const original = globalThis.fetch;
  globalThis.fetch = async (value) => String(value).includes("/children") ? Response.json({ results: [], has_more: false }) : Response.json({ id, url: "https://notion.so/example", last_edited_time: "2026-11-01", parent: { type: "workspace" }, properties: { Name: { type: "title", title: [{ plain_text: "Root" }] } } });
  try {
    await notionService.sync!(ctx, { full: false });
    const file = path.join(ctx.folder!, "Root-000000010000/index.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("inScope: true", "inScope: false").replace("via: scope", "via: former"));
    await notionService.sync!(ctx, { full: false });
    assert.match(readFileSync(file, "utf8"), /inScope: true/);
  } finally { globalThis.fetch = original; }
});

test("task names that normalize or truncate alike retain distinct identities", () => {
  assert.notEqual(taskId("a/b-c#1"), taskId("a-b/c#1"));
  assert.notEqual(taskId("same name"), taskId("same-name"));
  assert.notEqual(taskId("a".repeat(80) + "x"), taskId("a".repeat(80) + "y"));
});

test("corrupted credential store can be explicitly removed before logging in again", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = fixture();
  try {
    const file = path.join(process.env.XDG_CONFIG_HOME, "dev/credentials/github.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{broken");
    assert.throws(() => loadCredentials("github"), /can't be read/);
    assert.equal(removeCredentials("github"), true);
    saveCredentials("github", "me", { token: "synthetic" });
    assert.equal(loadCredentials("github")?.account, "me");
  } finally { process.env.XDG_CONFIG_HOME = previous; }
});

test("lists past their limit are cut off, and say so to callers that must not mistake them for the whole", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json([{ id: 1 }], { headers: { link: '<https://api.github.com/next>; rel="next"' } });
  try {
    assert.deepEqual(await new GitHubApi("synthetic").list("/items", 1), [{ id: 1 }]);
    assert.deepEqual(await new GitHubApi("synthetic").listUpTo("/items", 1), { items: [{ id: 1 }], truncated: true });
  } finally { globalThis.fetch = original; }
});

test("fuzzy search ranks name matches above description matches and ignores scattered letters", async () => {
  const { rank } = await import("../src/core/prompt.ts");
  const repos = [
    { name: "acme/billing", description: "Payments web app" },
    { name: "acme/web", description: "The website" },
    { name: "acme/infrastructure-workflows-and-everything", description: "" },
  ];
  assert.equal(rank("web", repos)[0]?.name, "acme/web", "the name match comes first");
  assert.deepEqual(rank("web", repos).map((r) => r.name), ["acme/web", "acme/billing"]);
  assert.deepEqual(rank("aw", repos).map((r) => r.name)[0], "acme/web", "word starts count");
  assert.deepEqual(rank("aiy", repos), [], "letters scattered across a long name don't match");
});

test("attachment names remain distinct and unchanged versions are not downloaded again", async () => {
  const dir = fixture();
  const ctx = context(dir, "confluence", { roots: ["100"] });
  const original = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async (value) => {
    const url = new URL(String(value));
    if (url.pathname.endsWith("/download/1") || url.pathname.endsWith("/download/2")) { downloads++; return new Response(url.pathname); }
    if (url.pathname.endsWith("/attachments")) return Response.json({ results: [
      { id: "1", title: "a:b", downloadLink: "/download/1", version: { number: 1 } },
      { id: "2", title: "a?b", downloadLink: "/download/2", version: { number: 1 } },
    ] });
    if (url.pathname.endsWith("/descendants")) return Response.json({ results: [] });
    if (url.pathname.endsWith("/spaces/1")) return Response.json({ key: "DOCS" });
    return Response.json({ id: "100", title: "Root", spaceId: "1", version: { number: 1, createdAt: "2026-11-01" }, body: { storage: { value: "<p>Content</p>" } } });
  };
  try {
    assert.equal((await confluence.sync!(ctx, { full: false })).failed.length, 0);
    const manifest = JSON.parse(readFileSync(path.join(ctx.folder!, "DOCS/Root-100/.attachments.json"), "utf8"));
    assert.notEqual(manifest["1"].name, manifest["2"].name);
    assert.equal(downloads, 2);
    assert.equal((await confluence.sync!(ctx, { full: false })).failed.length, 0);
    assert.equal(downloads, 2);
  } finally { globalThis.fetch = original; }
});

test("failed Notion root enumeration retains descendant scope", async () => {
  const dir = fixture();
  const id = "00000001-0000-0000-0000-000000000000";
  const child = "00000002-0000-0000-0000-000000000000";
  const ctx = context(dir, "notion", { pages: [id] });
  const file = path.join(ctx.folder!, "Child/index.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nid: ${child}\ntitle: Child\nservice: notion:notion\nurl: u\nupdated: x\nsynced: y\nroot: ${id}\ninScope: true\n---\nbody`);
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: "Not found" }, { status: 404 });
  try {
    assert.equal((await notionService.sync!(ctx, { full: false })).failed.length, 1);
    assert.match(readFileSync(file, "utf8"), /inScope: true/);
  } finally { globalThis.fetch = original; }
});

test("Projects-only tasks start with their board context instead of a generic brief", async () => {
  const { runTaskStart } = await import("../src/commands/task.ts");
  const { saveConfig } = await import("../src/core/project-config.ts");
  const dir = fixture();
  const seed = fixture();
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(seed, ["init", "--quiet", "--initial-branch=main"]);
  git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "start"]);
  git(dir, ["clone", "--quiet", seed, "repository"]);
  saveConfig(dir, { version: 1, versioning: { service: "github:github", repo: "acme/web" }, services: [{ service: "github:github-projects", scope: { projects: ["acme/1"] } }], conventions: {} });
  const item = path.join(dir, "github-projects/acme-1/draft-123/item.md");
  mkdirSync(path.dirname(item), { recursive: true });
  writeFileSync(item, '---\nid: draft-123\ntitle: Board task\nservice: github:github-projects\nurl: u\nupdated: x\nsynced: y\ninScope: true\n---\nBoard context');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runTaskStart(registry, quiet, "draft-123", {});
    const brief = readFileSync(path.join(dir, "tasks/draft-123/brief.md"), "utf8");
    assert.match(brief, /Board task/);
    assert.match(brief, /github-projects\/acme-1\/draft-123\/item.md/);
  } finally { process.chdir(cwd); }
});

test("interactive scope changes require config permission", () => {
  const map = classifiers(registry);
  assert.equal(judge("dev jira scope --choose", { ...DEFAULT_POLICY, config: "deny" }, map).decision, "deny");
  assert.equal(judge("dev jira scope", DEFAULT_POLICY, map).decision, "allow");
});

test("redirects are followed, and credentials never cross to another origin", async () => {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = async (value, init) => {
    const url = String(value);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url === "https://service.invalid/old") return new Response(null, { status: 301, headers: { location: "/new" } });
    if (url === "https://service.invalid/new") return new Response(null, { status: 302, headers: { location: "https://media.invalid/file" } });
    return new Response("bytes");
  };
  try {
    const api = new AtlassianClient({ url: "https://service.invalid", email: "a", token: "fake" });
    assert.equal((await api.download("/old")).toString(), "bytes");
    assert.deepEqual(seen.map((request) => [request.url, request.auth !== null]), [["https://service.invalid/old", true], ["https://service.invalid/new", true], ["https://media.invalid/file", false]]);
  } finally { globalThis.fetch = original; }
});

test("writes work through a symlinked folder, and still never replace a symlink", () => {
  const dir = fixture();
  mkdirSync(path.join(dir, "real"));
  symlinkSync(path.join(dir, "real"), path.join(dir, "alias"));
  atomicWriteSync(path.join(dir, "alias", "nested", "state.json"), "saved");
  assert.equal(readFileSync(path.join(dir, "real", "nested", "state.json"), "utf8"), "saved");
  symlinkSync(path.join(dir, "real", "nested", "state.json"), path.join(dir, "real", "link.json"));
  assert.throws(() => atomicWriteSync(path.join(dir, "alias", "link.json"), "x"), /symlink/);
});

test("a session keeps the folder it started in when a later hook fires from another", async () => {
  const dir = fixture();
  mkdirSync(path.join(dir, "worktrees", "X"), { recursive: true });
  const input = { tool: "claude" as const, sessionId: "bbbbbbbb-1", reason: null, standDown: false, raw: {} };
  await recordSession(dir, { ...input, cwd: dir }, "start");
  const folder = await recordSession(dir, { ...input, cwd: path.join(dir, "worktrees", "X") }, "end");
  assert.equal(JSON.parse(readFileSync(path.join(folder!, "session-ref.json"), "utf8")).workingDir, ".");
});

test("a failed attachment keeps its page, and names keep their extension", async () => {
  const dir = fixture();
  const ctx = context(dir, "confluence", { roots: ["100"] });
  const original = globalThis.fetch;
  globalThis.fetch = async (value) => {
    const url = new URL(String(value));
    if (url.pathname.endsWith("/download/1")) return new Response("png");
    if (url.pathname.endsWith("/download/2")) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/attachments")) return Response.json({ results: [
      { id: "1", title: "diagram.png", downloadLink: "/download/1", version: { number: 1 } },
      { id: "2", title: "gone.pdf", downloadLink: "/download/2", version: { number: 1 } },
    ] });
    if (url.pathname.endsWith("/descendants")) return Response.json({ results: [] });
    if (url.pathname.endsWith("/spaces/1")) return Response.json({ key: "DOCS" });
    return Response.json({ id: "100", title: "Root", spaceId: "1", version: { number: 1, createdAt: "2026-11-01" }, body: { storage: { value: "<p>Content</p>" } } });
  };
  try {
    assert.equal((await confluence.sync!(ctx, { full: false })).failed.length, 0);
    const page = path.join(ctx.folder!, "DOCS/Root-100");
    assert.ok(existsSync(path.join(page, "index.md")));
    const manifest = JSON.parse(readFileSync(path.join(page, ".attachments.json"), "utf8"));
    assert.match(manifest["1"].name, /^diagram-[0-9a-f]{12}\.png$/);
    assert.equal(manifest["2"], undefined);
  } finally { globalThis.fetch = original; }
});

test("a session recorded before provenance existed is still saved", async () => {
  const dir = fixture();
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
  try {
    const reference = { version: 1 as const, tool: "claude" as const, sessionId: "cccccccc-1", started: "2026-11-09T00:00:00Z", ended: "2026-11-09T01:00:00Z", endReason: null, task: null, workingDir: "." };
    const folder = path.join(dir, "work-sessions", "2026-11-09", "00-00-cccccccc");
    mkdirSync(folder, { recursive: true });
    const transcripts = path.join(dir, "claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(transcripts, "cccccccc-1.jsonl"), `${JSON.stringify({ type: "user", timestamp: "2026-11-09T00:00:00Z", message: { role: "user", content: "hello" } })}\n`);
    assert.equal(await saveSession(dir, folder, reference, registry), true);
    assert.ok(existsSync(path.join(folder, "session.md")));
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});
