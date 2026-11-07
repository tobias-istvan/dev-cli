import { load } from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// HTML and Confluence storage format to Markdown, shared by Jira and Confluence.

export type CheerioApi = ReturnType<typeof load>;

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
    filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
    replacement: (_content, node) => {
      const codeEl = node.firstChild as unknown as { getAttribute(name: string): string | null; textContent: string | null };
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
      const siblings = node.parentNode ? Array.from(node.parentNode.childNodes) : [];
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
export function stripBookkeepingAttributes($: CheerioApi): void {
  $("*").each((_i, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs;
    if (!attribs) return;

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
  });
}

function renameTag(el: unknown, tagName: "th" | "td"): void {
  (el as { tagName: string }).tagName = tagName;
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
export function normalizeTables($: CheerioApi): void {
  $("table").each((_i, tableEl) => {
    const $table = $(tableEl);

    // Column widths carry no meaning in Markdown, and a <colgroup> sitting
    // before <tbody> defeats the plugin's heading-row detection outright.
    $table.children("colgroup").remove();

    const $rows = $table.find("tr");
    if ($rows.length === 0) return;

    const $firstRow = $rows.first();
    const $firstRowCells = $firstRow.children("th, td");
    if ($firstRowCells.length === 0) return;

    // Already a clean heading row — nothing to do.
    if ($firstRow.children("th").length === $firstRowCells.length) return;

    if ($table.find("th").length === 0) {
      // Header row styled rather than marked up: promote it.
      $firstRowCells.each((_j, cell) => renameTag(cell, "th"));
      return;
    }

    // Mixed <th>/<td> means row headers ("Status | Pending"), which GFM has no
    // way to express. Demote them to ordinary cells and prepend an empty
    // heading row so the table still converts instead of being left as HTML.
    $table.find("th").each((_j, cell) => renameTag(cell, "td"));

    const columnCount = Math.max(
      ...$rows.toArray().map((row) => $(row).children("th, td").length),
    );
    $firstRow.before(`<tr>${"<th></th>".repeat(columnCount)}</tr>`);
  });
}

const plainTurndown = createTurndownService();

/**
 * Converts ordinary HTML (as returned by Jira's `renderedFields`) to Markdown.
 * Confluence storage format needs its own macro-aware path — see
 * commands/confluence/markdown.ts — and must not use this.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";

  const $ = load(html, { xmlMode: false });
  stripBookkeepingAttributes($);
  normalizeTables($);

  return plainTurndown.turndown($.html()).trim();
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
 * mangles their content. So we first walk the tree with cheerio (in XML
 * mode, which parses namespaced tags correctly) and rewrite every
 * Confluence macro into plain HTML, then hand the result to turndown.
 */
export function convertStorageToMarkdown(
  storageHtml: string,
  resolver: MarkdownLinkResolver,
): ConvertResult {
  const warnings: string[] = [];
  const $ = load(storageHtml, { xmlMode: true });

  // Macros can nest (e.g. a "status" macro inside a "details" or "panel"
  // macro's rich-text-body). Unwrapping a macro re-parses its inner HTML as
  // new elements, which a single pass over a selector snapshot won't revisit.
  // So run every pass repeatedly until a pass leaves no ac:/ri: tags behind,
  // capped so malformed content can't spin forever.
  const hasConfluenceTags = () =>
    $("*").toArray().some((el) => (el as { tagName?: string }).tagName?.includes(":"));

  for (let iteration = 0; iteration < 6 && hasConfluenceTags(); iteration += 1) {
    runMacroPasses($, resolver, warnings);
  }

  // Only once every macro that has a specific handler has had its chance
  // (across every iteration above) do we sweep up whatever's left unmapped -
  // otherwise a macro exposed mid-iteration by e.g. the links pass could be
  // caught here before it gets routed to its own handler on the next pass.
  for (
    let iteration = 0;
    iteration < 3 && $("ac\\:structured-macro").length > 0;
    iteration += 1
  ) {
    handleUnmappedMacros($, warnings);
  }

  // --- safety net: unwrap any other stray ac:/ri: tag we didn't anticipate ---
  $("*").each((_i, el) => {
    const tagName = (el as { tagName?: string }).tagName;
    if (tagName?.includes(":")) {
      $(el).replaceWith($(el).text());
    }
  });

  // Tables are normalized after the macro passes, not before: a macro body
  // (e.g. "details") can itself contain a table, so a pre-pass would miss it.
  stripBookkeepingAttributes($);
  normalizeTables($);

  const cleanedHtml = $.html();
  const markdown = turndownService.turndown(cleanedHtml).trim() + "\n";

  return { markdown, warnings };
}

function runMacroPasses(
  $: ReturnType<typeof load>,
  resolver: MarkdownLinkResolver,
  warnings: string[],
): void {
  // --- images -------------------------------------------------------
  $("ac\\:image").each((_i, el) => {
    const attachment = $(el).find("ri\\:attachment").first();
    const url = $(el).find("ri\\:url").first();
    const alt = $(el).attr("ac:alt") || "";

    let src: string | null = null;
    if (attachment.length > 0) {
      const filename = attachment.attr("ri:filename") || "";
      src = resolver.resolveAttachment(filename);
      if (!src) warnings.push(`Image attachment not found: "${filename}"`);
    } else if (url.length > 0) {
      src = url.attr("ri:value") || null;
    }

    $(el).replaceWith(
      src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">` : alt,
    );
  });

  // --- code blocks ----------------------------------------------------
  $('ac\\:structured-macro[ac\\:name="code"]').each((_i, el) => {
    const language =
      $(el).find('ac\\:parameter[ac\\:name="language"]').text().trim() ||
      "text";
    const code = $(el).find("ac\\:plain-text-body").text();
    const $pre = $("<pre><code></code></pre>");
    $pre.find("code").addClass(`language-${language}`).text(code);
    $(el).replaceWith($pre);
  });

  // --- task lists -------------------------------------------------------
  $("ac\\:task-list").each((_i, el) => {
    const items = $(el)
      .find("ac\\:task")
      .toArray()
      .map((taskEl) => {
        const status = $(taskEl).find("ac\\:task-status").text().trim();
        const body = $(taskEl).find("ac\\:task-body").html() ?? "";
        const checked = status === "complete" ? " checked" : "";
        return `<li><input type="checkbox"${checked} disabled>${body}</li>`;
      })
      .join("");
    $(el).replaceWith(`<ul>${items}</ul>`);
  });

  // --- panels (info/note/tip/warning) and expandable sections --------
  $("ac\\:structured-macro").each((_i, el) => {
    const name = $(el).attr("ac:name") || "";
    const bodyHtml = $(el).find("ac\\:rich-text-body").first().html() ?? "";

    if (name in PANEL_MACROS) {
      $(el).replaceWith(
        `\n<blockquote><p><strong>${PANEL_MACROS[name]}</strong></p>${bodyHtml}</blockquote>\n`,
      );
    } else if (name === "panel") {
      const title = $(el)
        .find('ac\\:parameter[ac\\:name="title"]')
        .text()
        .trim();
      const heading = title
        ? `<p><strong>${escapeText(title)}</strong></p>`
        : "";
      $(el).replaceWith(`\n<blockquote>${heading}${bodyHtml}</blockquote>\n`);
    } else if (name === "expand") {
      const title =
        $(el).find('ac\\:parameter[ac\\:name="title"]').text().trim() ||
        "Details";
      $(el).replaceWith(
        `\n<details><summary>${escapeText(title)}</summary>${bodyHtml}</details>\n`,
      );
    } else if (name === "details") {
      // The "details" macro is a properties box (usually a small table), not
      // a collapsible section - unwrap it in place rather than dropping it.
      $(el).replaceWith(`\n${bodyHtml}\n`);
    } else if (name === "status") {
      const title =
        $(el).find('ac\\:parameter[ac\\:name="title"]').text().trim() ||
        "status";
      $(el).replaceWith(`<code>${escapeText(title)}</code>`);
    } else if (name === "jira") {
      const key = $(el).find('ac\\:parameter[ac\\:name="key"]').text().trim();
      if (key) {
        $(el).replaceWith(
          `<a href="${escapeAttr(resolver.jiraBrowseUrl(key))}">${escapeText(key)}</a>`,
        );
      }
    }
  });

  // --- layout wrappers: keep content, drop the columns ----------------
  $("ac\\:layout, ac\\:layout-section, ac\\:layout-cell").each((_i, el) => {
    $(el).replaceWith($(el).html() ?? "");
  });

  // --- emoticons --------------------------------------------------------
  $("ac\\:emoticon").each((_i, el) => {
    $(el).replaceWith($(el).attr("ac:emoji-fallback") || "");
  });

  // --- links (to pages, attachments, external URLs, or users) --------
  $("ac\\:link").each((_i, el) => {
    const pageRef = $(el).find("ri\\:page").first();
    const attachmentRef = $(el).find("ri\\:attachment").first();
    const urlRef = $(el).find("ri\\:url").first();
    const userRef = $(el).find("ri\\:user").first();

    const explicitText = $(el).find("ac\\:plain-text-link-body").text().trim();

    let href: string | null = null;
    let fallbackText = explicitText;

    if (pageRef.length > 0) {
      const title = pageRef.attr("ri:content-title") || "";
      fallbackText = fallbackText || title;
      href = resolver.resolvePageLink(title);
      if (!href)
        warnings.push(
          `Could not resolve link to page "${title}" (not in this export)`,
        );
    } else if (attachmentRef.length > 0) {
      const filename = attachmentRef.attr("ri:filename") || "";
      fallbackText = fallbackText || filename;
      href = resolver.resolveAttachment(filename);
      if (!href)
        warnings.push(`Could not resolve link to attachment "${filename}"`);
    } else if (urlRef.length > 0) {
      href = urlRef.attr("ri:value") || null;
      fallbackText = fallbackText || href || "";
    } else if (userRef.length > 0) {
      const accountId = userRef.attr("ri:account-id") || "";
      fallbackText = fallbackText || `@${accountId}`;
      warnings.push(`User mention left unresolved: "${accountId}"`);
    }

    const text = escapeText(fallbackText || "link");
    $(el).replaceWith(
      href ? `<a href="${escapeAttr(href)}">${text}</a>` : text,
    );
  });
}

// Anything left unmapped (toc, jira, children, excerpt, ...). Best effort:
// keep whatever rich/plain text body it has rather than dropping the
// macro's content outright, just flag it as unhandled. Kept separate from
// runMacroPasses and run only after that loop settles, so a macro exposed
// mid-iteration still gets a chance at its own specific handler first.
function handleUnmappedMacros(
  $: ReturnType<typeof load>,
  warnings: string[],
): void {
  $("ac\\:structured-macro").each((_i, el) => {
    const name = $(el).attr("ac:name") || "unknown";
    const bodyHtml =
      $(el).find("ac\\:rich-text-body").first().html() ??
      $(el).find("ac\\:plain-text-body").first().text() ??
      "";
    warnings.push(
      `Unsupported macro "${name}" was ${bodyHtml ? "kept as best-effort content" : "dropped (kept as a placeholder)"}`,
    );
    $(el).replaceWith(
      `\n<p><em>[Confluence macro: ${escapeText(name)}]</em></p>${bodyHtml}\n`,
    );
  });
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
