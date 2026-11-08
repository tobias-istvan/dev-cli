import type { NotionApi } from "./api.ts";

/**
 * Notion blocks to Markdown. Nested blocks, like a list item's children or a toggle's
 * contents, are fetched and indented. Child pages become links to their own files, which the
 * caller names through `childLink`.
 */

export interface RichText {
  plain_text: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean };
}

export interface Block {
  id: string;
  type: string;
  has_children: boolean;
  [type: string]: unknown;
}

export function richText(parts: RichText[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      let text = part.plain_text;
      if (!text) return "";
      const a = part.annotations ?? {};
      if (a.code) text = `\`${text}\``;
      if (a.bold) text = `**${text}**`;
      if (a.italic) text = `_${text}_`;
      if (a.strikethrough) text = `~~${text}~~`;
      return part.href ? `[${text}](${part.href})` : text;
    })
    .join("");
}

function data(block: Block): { rich_text?: RichText[]; checked?: boolean; language?: string; url?: string; title?: string; caption?: RichText[]; expression?: string; icon?: { emoji?: string }; cells?: RichText[][]; type?: string; file?: { url: string }; external?: { url: string }; page_id?: string } {
  return (block[block.type] ?? {}) as ReturnType<typeof data>;
}

export interface ConvertOptions {
  /** The link to a child page's file, or null to leave it as plain text. */
  childLink(id: string, title: string): string | null;
  /** Called for each child page and database found, so the caller can sync them. */
  onChild?(id: string, title: string, kind: "page" | "database"): void;
}

async function children(api: NotionApi, id: string): Promise<Block[]> {
  return api.all<Block>("GET", `/blocks/${id}/children`);
}

export async function blocksToMarkdown(api: NotionApi, blocks: Block[], options: ConvertOptions, depth = 0): Promise<string> {
  const out: string[] = [];
  const indent = "    ".repeat(depth);
  let number = 0;

  for (const block of blocks) {
    const d = data(block);
    const text = richText(d.rich_text);
    number = block.type === "numbered_list_item" ? number + 1 : 0;
    let line: string;

    switch (block.type) {
      case "paragraph":
        line = text;
        break;
      case "heading_1":
      case "heading_2":
      case "heading_3":
        line = `${"#".repeat(Number(block.type.slice(-1)) + 1)} ${text}`;
        break;
      case "bulleted_list_item":
        line = `- ${text}`;
        break;
      case "numbered_list_item":
        line = `${number}. ${text}`;
        break;
      case "to_do":
        line = `- [${d.checked ? "x" : " "}] ${text}`;
        break;
      case "toggle":
        line = `- ${text}`;
        break;
      case "quote":
        line = `> ${text}`;
        break;
      case "callout":
        line = `> ${d.icon?.emoji ? `${d.icon.emoji} ` : ""}${text}`;
        break;
      case "code":
        line = `\`\`\`${d.language && d.language !== "plain text" ? d.language : ""}\n${richText(d.rich_text)}\n\`\`\``;
        break;
      case "divider":
        line = "---";
        break;
      case "equation":
        line = `$$${d.expression ?? ""}$$`;
        break;
      case "image":
      case "file":
      case "pdf":
      case "video": {
        const url = d.file?.url ?? d.external?.url ?? "";
        const caption = richText(d.caption) || block.type;
        // Notion's own file links expire within an hour, so they're named rather than linked.
        line = d.external ? `![${caption}](${url})` : `_${block.type}: ${caption} (stored in Notion)_`;
        break;
      }
      case "bookmark":
      case "embed":
      case "link_preview":
        line = d.url ? `[${richText(d.caption) || d.url}](${d.url})` : "";
        break;
      case "child_page": {
        const title = d.title ?? "Untitled";
        options.onChild?.(block.id, title, "page");
        const link = options.childLink(block.id, title);
        line = link ? `[${title}](${link})` : title;
        break;
      }
      case "child_database": {
        const title = d.title ?? "Untitled database";
        options.onChild?.(block.id, title, "database");
        const link = options.childLink(block.id, title);
        line = link ? `[${title}](${link}) (database)` : `${title} (database)`;
        break;
      }
      case "link_to_page": {
        const id = d.page_id ?? "";
        line = `[Linked page](https://www.notion.so/${id.replace(/-/g, "")})`;
        break;
      }
      case "table": {
        const rows = (await children(api, block.id)).map((row) => (data(row).cells ?? []).map((cell) => richText(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
        if (rows.length === 0) continue;
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
        line = [pad(rows[0] ?? []), pad(Array(width).fill("---")), ...rows.slice(1).map(pad)].join(`\n${indent}`);
        out.push(`${indent}${line}`, "");
        continue;
      }
      case "column_list":
      case "column":
      case "synced_block":
        // Containers: their contents follow, at the same level.
        if (block.has_children) out.push(await blocksToMarkdown(api, await children(api, block.id), options, depth));
        continue;
      default:
        line = text ? text : `_[Notion ${block.type.replace(/_/g, " ")}]_`;
    }

    out.push(`${indent}${line.split("\n").join(`\n${indent}`)}`);
    if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
      out.push(await blocksToMarkdown(api, await children(api, block.id), options, depth + 1));
    }
    const isList = /list_item|to_do|toggle/.test(block.type);
    if (!isList) out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
