/**
 * Jira's rendered HTML and Confluence's storage format, converted to Markdown. Each sample in
 * fixtures/atlassian-html has its expected Markdown beside it; UPDATE_FIXTURES=1 rewrites them
 * after a deliberate change, so the diff shows exactly what changed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { convertStorageToMarkdown, htmlToMarkdown } from "../src/plugins/atlassian/html.ts";

const dir = path.join(import.meta.dirname, "fixtures", "atlassian-html");
const pages = new Set(["Other Page"]);
const files = new Set(["spec.pdf", "diagram.png"]);
const resolver = {
  resolvePageLink: (title: string) => (pages.has(title) ? `../${title}/index.md` : null),
  resolveAttachment: (name: string) => (files.has(name) ? `attachments/${name}` : null),
  jiraBrowseUrl: (key: string) => `https://example.atlassian.net/browse/${key}`,
};

function convert(name: string): string {
  const input = readFileSync(path.join(dir, name), "utf8");
  if (name.endsWith(".html")) return `${htmlToMarkdown(input)}\n`;
  const { markdown, warnings } = convertStorageToMarkdown(input, resolver);
  return `${markdown}\n<!-- warnings -->\n${warnings.map((w) => `${w}\n`).join("")}`;
}

for (const name of readdirSync(dir).filter((f) => /\.(html|xml)$/.test(f)).sort()) {
  test(`${name} converts to the expected Markdown`, () => {
    const expected = path.join(dir, `${name.replace(/\.\w+$/, "")}.md`);
    const actual = convert(name);
    if (process.env.UPDATE_FIXTURES) writeFileSync(expected, actual);
    assert.equal(actual, readFileSync(expected, "utf8"));
  });
}

test("empty input converts to nothing", () => {
  assert.equal(htmlToMarkdown(""), "");
  assert.equal(htmlToMarkdown("  \n"), "");
  assert.deepEqual(convertStorageToMarkdown("", resolver), { markdown: "\n", warnings: [] });
});
