import { is, selectAll, selectOne } from "css-select";
import render from "dom-serializer";
import { type AnyNode, type Document, type Element, isTag } from "domhandler";
import { prepend, removeElement, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// HTML and Confluence storage format to Markdown, shared by Jira and Confluence.

/**
 * A parsed page and how it was parsed. Confluence storage format is XML, so it's parsed as
 * XML (which keeps namespaced ac:/ri: tags and CDATA intact); Jira's rendered HTML as HTML.
 * Markup added while rewriting is parsed the same way as the page it goes into.
 */
export interface Markup {
  doc: Document;
  xml: boolean;
}

function parse(source: string, xml: boolean): Markup {
  return { doc: parseDocument(source, { xmlMode: xml }), xml };
}

/** Every element matching `query` under `root`, not counting `root` itself, in document order. */
function all(markup: Markup, query: string, root: AnyNode = markup.doc): Element[] {
  return selectAll<AnyNode, Element>(query, root, { xmlMode: markup.xml });
}

function first(markup: Markup, query: string, root: AnyNode): Element | null {
  return selectOne<AnyNode, Element>(query, root, { xmlMode: markup.xml });
}

function children(markup: Markup, el: Element, query: string): Element[] {
  return el.children.filter(isTag).filter((child) => is<AnyNode, Element>(child, query, { xmlMode: markup.xml }));
}

/** The text of every element matching `query` under `root`, run together. */
function textOf(markup: Markup, query: string, root: AnyNode): string {
  return all(markup, query, root).map((el) => textContent(el)).join("");
}

function serialize(markup: Markup, nodes: AnyNode | AnyNode[]): string {
  return render(nodes, markup.xml ? { xmlMode: true } : { encodeEntities: "utf8" });
}

/** What's inside `el`, as markup. */
function inner(markup: Markup, el: Element | null): string | null {
  return el ? serialize(markup, el.children) : null;
}

/** Parses `source` and puts it just before `el`. */
function insertBefore(markup: Markup, el: Element, source: string): void {
  // Copied first: moving a node takes it out of the list being walked.
  for (const node of [...parse(source, markup.xml).doc.children]) prepend(el, node);
}

/** Parses `source` and puts it in place of `el`. */
function replaceWith(markup: Markup, el: Element, source: string): void {
  insertBefore(markup, el, source);
  removeElement(el);
}

/** The parts of a DOM node the rules below read. The lib has no DOM types to give them. */
type DomNode = { nodeName: string; firstChild: DomNode | null; parentNode: { childNodes: ArrayLike<unknown> } | null };
const dom = (node: unknown) => node as DomNode;

/**
 * A turndown instance configured the way both the Confluence and Jira syncs
 * need it. Kept here rather than in either caller because the table handling
 * below is the fiddly part, and having two copies drift would silently degrade
 * one of the two corpora.
 */
export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use(gfm);
  service.keep(["details", "summary"]);

  service.addRule("fencedCodeBlockWithLanguage", {
    filter: (node) => dom(node).nodeName === "PRE" && dom(node).firstChild?.nodeName === "CODE",
    replacement: (_content, node) => {
      const codeEl = dom(node).firstChild as unknown as { getAttribute(name: string): string | null; textContent: string | null };
      const language = (codeEl.getAttribute("class") || "").replace("language-", "");
      const code = codeEl.textContent || "";
      return `\n\n\`\`\`${language}\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;
    },
  });

  // GFM table cells can't contain literal newlines. Both Confluence and Jira
  // wrap cell content in <p> (and sometimes multiple <p>/<li> blocks), which the
  // plugin's default tableCell rule passes through with blank lines still in
  // it, corrupting the table. Collapse block breaks to <br> instead. This is
  // registered after service.use(gfm) so it takes priority (addRule prepends).
  service.addRule("tableCellWithoutBlankLines", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const collapsed = content.trim().replace(/\n+/g, "<br>");
      const parent = dom(node).parentNode;
      const siblings = parent ? Array.from(parent.childNodes) : [];
      const isFirst = siblings.indexOf(node) === 0;
      return (isFirst ? "| " : " ") + collapsed + " |";
    },
  });

  return service;
}

/**
 * Atlassian decorates almost every element with `ac:local-id` / `data-*`
 * bookkeeping attributes that mean nothing in Markdown. They're invisible when
 * an element converts cleanly, but turndown emits raw HTML verbatim for
 * anything it keeps, so they otherwise leak into the output in bulk.
 */
export function stripBookkeepingAttributes(markup: Markup): void {
  for (const { attribs } of all(markup, "*")) {
    for (const name of Object.keys(attribs)) {
      if (
        name.startsWith("ac:") ||
        name.startsWith("ri:") ||
        name.startsWith("data-") ||
        name === "local-id" ||
        name === "style"
      ) {
        delete attribs[name];
      }
    }
  }
}

function renameTag(el: Element, tagName: "th" | "td"): void {
  el.name = tagName;
}

/**
 * Makes every table convertible to a GFM table.
 *
 * turndown-plugin-gfm only converts a table whose first row is a proper heading
 * row; anything else it keeps as raw HTML. Three Atlassian habits trip that: a
 * <colgroup> before <tbody> (which defeats the plugin's "is this the first
 * row" check outright), a "label | value" table whose first row mixes <th> and
 * <td>, and a table whose header row is styled with a background colour rather
 * than marked up with <th>. Left alone, ~80% of pages in a real Confluence
 * space keep their tables as raw HTML — unreadable, and far more expensive to
 * load into an agent's context than the equivalent Markdown.
 */
export function normalizeTables(markup: Markup): void {
  for (const table of all(markup, "table")) {
    // Column widths carry no meaning in Markdown, and a <colgroup> sitting
    // before <tbody> defeats the plugin's heading-row detection outright.
    for (const colgroup of children(markup, table, "colgroup")) removeElement(colgroup);

    const rows = all(markup, "tr", table);
    const [firstRow] = rows;
    if (!firstRow) continue;

    const firstRowCells = children(markup, firstRow, "th, td");
    if (firstRowCells.length === 0) continue;

    // Already a clean heading row — nothing to do.
    if (children(markup, firstRow, "th").length === firstRowCells.length) continue;

    const headings = all(markup, "th", table);
    if (headings.length === 0) {
      // Header row styled rather than marked up: promote it.
      for (const cell of firstRowCells) renameTag(cell, "th");
      continue;
    }

    // Mixed <th>/<td> means row headers ("Status | Pending"), which GFM has no
    // way to express. Demote them to ordinary cells and prepend an empty
    // heading row so the table still converts instead of being left as HTML.
    for (const cell of headings) renameTag(cell, "td");

    const columnCount = Math.max(...rows.map((row) => children(markup, row, "th, td").length));
    insertBefore(markup, firstRow, `<tr>${"<th></th>".repeat(columnCount)}</tr>`);
  }
}

const plainTurndown = createTurndownService();

/**
 * Converts ordinary HTML (as returned by Jira's `renderedFields`) to Markdown.
 * Confluence storage format needs its own macro-aware path — see
 * commands/confluence/markdown.ts — and must not use this.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";

  const markup = parse(html, false);
  stripBookkeepingAttributes(markup);
  normalizeTables(markup);

  return plainTurndown.turndown(serialize(markup, markup.doc)).trim();
}

export interface MarkdownLinkResolver {
  /** Relative path (posix, e.g. "../Other Page-123/index.md") to link to another exported page by title, or null if unresolved. */
  resolvePageLink(title: string): string | null;
  /** Relative path to a downloaded attachment by its Confluence filename, or null if unresolved. */
  resolveAttachment(filename: string): string | null;
  /** Absolute URL for a Jira issue key (e.g. "FMM1-123"), for the "jira" macro. */
  jiraBrowseUrl(key: string): string;
}

export interface ConvertResult {
  markdown: string;
  warnings: string[];
}

const PANEL_MACROS: Record<string, string> = {
  info: "ℹ️ Info",
  note: "📝 Note",
  tip: "💡 Tip",
  warning: "⚠️ Warning",
};

const turndownService = createTurndownService();

/**
 * Converts a Confluence "storage format" body (an XHTML dialect with
 * custom ac:/ri: namespaced macro elements) into Markdown.
 *
 * Storage format can't be fed to an HTML->Markdown converter directly:
 * turndown's HTML parser doesn't understand ac:/ri: elements and silently
 * mangles their content. So we first parse it as XML (which keeps
 * namespaced tags and CDATA intact) and rewrite every
 * Confluence macro into plain HTML, then hand the result to turndown.
 */
export function convertStorageToMarkdown(
  storageHtml: string,
  resolver: MarkdownLinkResolver,
): ConvertResult {
  const warnings: string[] = [];
  const markup = parse(storageHtml, true);

  // Macros can nest (e.g. a "status" macro inside a "details" or "panel"
  // macro's rich-text-body). Unwrapping a macro re-parses its inner HTML as
  // new elements, which a single pass over a selector snapshot won't revisit.
  // So run every pass repeatedly until a pass leaves no ac:/ri: tags behind,
  // capped so malformed content can't spin forever.
  const hasConfluenceTags = () => all(markup, "*").some((el) => el.name.includes(":"));

  for (let iteration = 0; iteration < 6 && hasConfluenceTags(); iteration += 1) {
    runMacroPasses(markup, resolver, warnings);
  }

  // Only once every macro that has a specific handler has had its chance
  // (across every iteration above) do we sweep up whatever's left unmapped -
  // otherwise a macro exposed mid-iteration by e.g. the links pass could be
  // caught here before it gets routed to its own handler on the next pass.
  for (
    let iteration = 0;
    iteration < 3 && all(markup, "ac\\:structured-macro").length > 0;
    iteration += 1
  ) {
    handleUnmappedMacros(markup, warnings);
  }

  // --- safety net: unwrap any other stray ac:/ri: tag we didn't anticipate ---
  for (const el of all(markup, "*")) {
    if (el.name.includes(":")) replaceWith(markup, el, textContent(el));
  }

  // Tables are normalized after the macro passes, not before: a macro body
  // (e.g. "details") can itself contain a table, so a pre-pass would miss it.
  stripBookkeepingAttributes(markup);
  normalizeTables(markup);

  const cleanedHtml = serialize(markup, markup.doc);
  const markdown = turndownService.turndown(cleanedHtml).trim() + "\n";

  return { markdown, warnings };
}

/** The value of `ac:name="name"` parameters under `el`, run together and trimmed. */
function parameter(markup: Markup, el: Element, name: string): string {
  return textOf(markup, `ac\\:parameter[ac\\:name="${name}"]`, el).trim();
}

function runMacroPasses(
  markup: Markup,
  resolver: MarkdownLinkResolver,
  warnings: string[],
): void {
  // --- images -------------------------------------------------------
  for (const el of all(markup, "ac\\:image")) {
    const attachment = first(markup, "ri\\:attachment", el);
    const url = first(markup, "ri\\:url", el);
    const alt = el.attribs["ac:alt"] || "";

    let src: string | null = null;
    if (attachment) {
      const filename = attachment.attribs["ri:filename"] || "";
      src = resolver.resolveAttachment(filename);
      if (!src) warnings.push(`Image attachment not found: "${filename}"`);
    } else if (url) {
      src = url.attribs["ri:value"] || null;
    }

    replaceWith(
      markup,
      el,
      src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">` : alt,
    );
  }

  // --- code blocks ----------------------------------------------------
  for (const el of all(markup, 'ac\\:structured-macro[ac\\:name="code"]')) {
    const language = parameter(markup, el, "language") || "text";
    const code = textOf(markup, "ac\\:plain-text-body", el);
    replaceWith(
      markup,
      el,
      `<pre><code class="language-${escapeAttr(language)}">${escapeText(code)}</code></pre>`,
    );
  }

  // --- task lists -------------------------------------------------------
  for (const el of all(markup, "ac\\:task-list")) {
    const items = all(markup, "ac\\:task", el)
      .map((taskEl) => {
        const status = textOf(markup, "ac\\:task-status", taskEl).trim();
        const body = inner(markup, first(markup, "ac\\:task-body", taskEl)) ?? "";
        const checked = status === "complete" ? " checked" : "";
        return `<li><input type="checkbox"${checked} disabled>${body}</li>`;
      })
      .join("");
    replaceWith(markup, el, `<ul>${items}</ul>`);
  }

  // --- panels (info/note/tip/warning) and expandable sections --------
  for (const el of all(markup, "ac\\:structured-macro")) {
    const name = el.attribs["ac:name"] || "";
    const bodyHtml = inner(markup, first(markup, "ac\\:rich-text-body", el)) ?? "";

    if (name in PANEL_MACROS) {
      replaceWith(
        markup,
        el,
        `\n<blockquote><p><strong>${PANEL_MACROS[name]}</strong></p>${bodyHtml}</blockquote>\n`,
      );
    } else if (name === "panel") {
      const title = parameter(markup, el, "title");
      const heading = title
        ? `<p><strong>${escapeText(title)}</strong></p>`
        : "";
      replaceWith(markup, el, `\n<blockquote>${heading}${bodyHtml}</blockquote>\n`);
    } else if (name === "expand") {
      const title = parameter(markup, el, "title") || "Details";
      replaceWith(
        markup,
        el,
        `\n<details><summary>${escapeText(title)}</summary>${bodyHtml}</details>\n`,
      );
    } else if (name === "details") {
      // The "details" macro is a properties box (usually a small table), not
      // a collapsible section - unwrap it in place rather than dropping it.
      replaceWith(markup, el, `\n${bodyHtml}\n`);
    } else if (name === "status") {
      const title = parameter(markup, el, "title") || "status";
      replaceWith(markup, el, `<code>${escapeText(title)}</code>`);
    } else if (name === "jira") {
      const key = parameter(markup, el, "key");
      if (key) {
        replaceWith(
          markup,
          el,
          `<a href="${escapeAttr(resolver.jiraBrowseUrl(key))}">${escapeText(key)}</a>`,
        );
      }
    }
  }

  // --- layout wrappers: keep content, drop the columns ----------------
  for (const el of all(markup, "ac\\:layout, ac\\:layout-section, ac\\:layout-cell")) {
    replaceWith(markup, el, inner(markup, el) ?? "");
  }

  // --- emoticons --------------------------------------------------------
  for (const el of all(markup, "ac\\:emoticon")) {
    replaceWith(markup, el, el.attribs["ac:emoji-fallback"] || "");
  }

  // --- links (to pages, attachments, external URLs, or users) --------
  for (const el of all(markup, "ac\\:link")) {
    const pageRef = first(markup, "ri\\:page", el);
    const attachmentRef = first(markup, "ri\\:attachment", el);
    const urlRef = first(markup, "ri\\:url", el);
    const userRef = first(markup, "ri\\:user", el);

    const explicitText = textOf(markup, "ac\\:plain-text-link-body", el).trim();

    let href: string | null = null;
    let fallbackText = explicitText;

    if (pageRef) {
      const title = pageRef.attribs["ri:content-title"] || "";
      fallbackText = fallbackText || title;
      href = resolver.resolvePageLink(title);
      if (!href)
        warnings.push(
          `Could not resolve link to page "${title}" (not in this export)`,
        );
    } else if (attachmentRef) {
      const filename = attachmentRef.attribs["ri:filename"] || "";
      fallbackText = fallbackText || filename;
      href = resolver.resolveAttachment(filename);
      if (!href)
        warnings.push(`Could not resolve link to attachment "${filename}"`);
    } else if (urlRef) {
      href = urlRef.attribs["ri:value"] || null;
      fallbackText = fallbackText || href || "";
    } else if (userRef) {
      const accountId = userRef.attribs["ri:account-id"] || "";
      fallbackText = fallbackText || `@${accountId}`;
      warnings.push(`User mention left unresolved: "${accountId}"`);
    }

    const text = escapeText(fallbackText || "link");
    replaceWith(
      markup,
      el,
      href ? `<a href="${escapeAttr(href)}">${text}</a>` : text,
    );
  }
}

// Anything left unmapped (toc, jira, children, excerpt, ...). Best effort:
// keep whatever rich/plain text body it has rather than dropping the
// macro's content outright, just flag it as unhandled. Kept separate from
// runMacroPasses and run only after that loop settles, so a macro exposed
// mid-iteration still gets a chance at its own specific handler first.
function handleUnmappedMacros(markup: Markup, warnings: string[]): void {
  for (const el of all(markup, "ac\\:structured-macro")) {
    const name = el.attribs["ac:name"] || "unknown";
    const plain = first(markup, "ac\\:plain-text-body", el);
    const bodyHtml =
      inner(markup, first(markup, "ac\\:rich-text-body", el)) ??
      (plain ? textContent(plain) : "");
    warnings.push(
      `Unsupported macro "${name}" was ${bodyHtml ? "kept as best-effort content" : "dropped (kept as a placeholder)"}`,
    );
    replaceWith(
      markup,
      el,
      `\n<p><em>[Confluence macro: ${escapeText(name)}]</em></p>${bodyHtml}\n`,
    );
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
