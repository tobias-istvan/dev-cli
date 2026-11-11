import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, atomicWriteSync, safePath } from "../../core/files.ts";
import type { AtlassianClient } from "./client.ts";

/**
 * Attachments, kept next to the page or ticket they belong to, in its attachments/ folder.
 * Shared by Confluence and Jira.
 */

export interface RemoteAttachment {
  /** Stable for the attachment, like its id. */
  key: string;
  /** Its filename in the service. */
  title: string;
  /** Where to download it, on the site. */
  link: string;
  /** Changes when the content does. Without one, it's downloaded every time. */
  version?: number;
}

function safeFilename(title: string): string {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 150).trim() || "untitled";
}

/** The suffix goes before the extension, so "diagram.png" still opens as an image. */
function attachmentName(title: string, suffix: string): string {
  const safe = safeFilename(title);
  const extension = path.extname(safe);
  return `${safe.slice(0, safe.length - extension.length)}-${suffix}${extension}`;
}

/**
 * Downloads attachments into `dir`/attachments, under collision-resistant names, and only
 * when their version changed. One that can't be downloaded keeps its previous copy, if
 * there is one, and is warned about: it doesn't fail its page. Returns each attachment's
 * file, relative to `dir`, by key.
 *
 * Copies no attachment owns any more are removed: every other file in the folder with
 * `own`, where the folder is the mirror's alone, and otherwise only files an earlier sync
 * put there, so a person's own are left.
 */
export async function mirrorAttachments(api: AtlassianClient, dir: string, attachments: RemoteAttachment[], warn: (message: string) => void, own: boolean): Promise<Map<string, string>> {
  const recordFile = safePath(dir, ".attachments.json");
  let previous: Record<string, { version?: number; name: string }> = {};
  try { previous = JSON.parse(await readFile(recordFile, "utf8")); } catch {}
  const record: typeof previous = {};
  const files = new Map<string, string>();
  for (const attachment of attachments) {
    const suffix = createHash("sha256").update(attachment.key).digest("hex").slice(0, 12);
    const name = attachmentName(attachment.title, suffix);
    const relative = `attachments/${name}`;
    const file = safePath(dir, relative);
    let version = attachment.version;
    if (!existsSync(file) || version === undefined || previous[attachment.key]?.version !== version) {
      try {
        await atomicWrite(file, await api.download(attachment.link));
      } catch (error) {
        warn(`Couldn't download "${attachment.title}": ${(error as Error).message}`);
        // The copy from before names had a suffix is better than none.
        const unsuffixed = safePath(dir, `attachments/${safeFilename(attachment.title)}`);
        if (!existsSync(file) && existsSync(unsuffixed)) await rename(unsuffixed, file);
        if (!existsSync(file)) continue;
        // Recorded at its old version, so the next sync tries again.
        version = previous[attachment.key]?.version;
      }
    }
    files.set(attachment.key, relative);
    record[attachment.key] = { version, name };
  }
  const kept = new Set(Object.values(record).map((entry) => entry.name));
  const attachmentsDir = safePath(dir, "attachments");
  if (existsSync(attachmentsDir)) {
    const stale = own ? await readdir(attachmentsDir) : Object.values(previous).map((entry) => entry.name);
    for (const entry of stale) {
      if (!kept.has(entry)) await rm(safePath(attachmentsDir, entry), { recursive: true, force: true });
    }
  }
  if (attachments.length > 0 || Object.keys(previous).length > 0) atomicWriteSync(recordFile, JSON.stringify(record));
  return files;
}
