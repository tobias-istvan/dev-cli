import { boundedFetch, providerUrl } from "../../core/network.ts";
import { createHash } from "node:crypto";
import { DevError } from "../../core/output.ts";

/**
 * The two ways dev can look at a design: Figma's REST API with a personal access token,
 * and the Figma desktop app's local MCP server. Both give a fingerprint of a frame's
 * content, so a sync can tell when the design itself changed, not only the link.
 */

export function apiBase(): string {
  return (process.env.DEV_FIGMA_API_URL ?? "https://api.figma.com").replace(/\/$/, "");
}

export function mcpUrl(): string {
  return process.env.DEV_FIGMA_MCP_URL ?? "http://127.0.0.1:3845/mcp";
}

export function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// REST

interface NodesResponse {
  name: string;
  lastModified: string;
  nodes: Record<string, { document?: { name?: string } & Record<string, unknown> } | null>;
}

async function rest<T>(token: string, path: string): Promise<T> {
  let response: Response;
  try {
    response = await boundedFetch(providerUrl(`${apiBase()}${path}`, apiBase()), { headers: { "X-Figma-Token": token } });
  } catch (error) {
    throw new DevError(`Couldn't reach Figma: ${(error as Error).message}.`);
  }
  if (response.status === 403 || response.status === 401) throw new DevError("Figma rejected the saved token.", 'Run "dev login figma" again.');
  if (response.status === 404) throw new DevError(`Figma has no file at ${path.split("?")[0]}, or you can't see it.`);
  if (response.status === 429) throw new DevError("Figma's rate limit was reached.", "Wait a minute, then sync again.");
  if (!response.ok) throw new DevError(`Figma answered ${response.status} for ${path.split("?")[0]}.`);
  return (await response.json()) as T;
}

export async function whoAmI(token: string): Promise<string> {
  const me = await rest<{ handle?: string; email?: string }>(token, "/v1/me");
  return me.email ?? me.handle ?? "unknown";
}

export interface NodeState {
  fileName: string;
  lastModified: string;
  nodeName: string;
  fingerprint: string;
}

/** Each node's current state, from one request per file. Nodes that no longer exist are left out. */
export async function restNodes(token: string, fileKey: string, nodeIds: string[]): Promise<Map<string, NodeState>> {
  const ids = nodeIds.filter(Boolean);
  const response = await rest<NodesResponse>(token, `/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids.join(","))}${ids.length === 0 ? "&depth=1" : ""}`);
  const states = new Map<string, NodeState>();
  for (const [id, node] of Object.entries(response.nodes ?? {})) {
    if (!node?.document) continue;
    states.set(id, {
      fileName: response.name,
      lastModified: response.lastModified,
      nodeName: String(node.document.name ?? ""),
      fingerprint: fingerprint(JSON.stringify(node.document)),
    });
  }
  return states;
}

// ---------------------------------------------------------------------------
// Local MCP: the Figma desktop app's server, spoken to directly

let session: string | null = null;

function parseMessage(text: string): Record<string, unknown> | null {
  // Answers come as server-sent events or plain JSON; the last data line holds the result.
  const data = text.includes("data:") ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).at(-1) : text;
  try {
    return data ? (JSON.parse(data) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const response = await boundedFetch(mcpUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  session = response.headers.get("mcp-session-id") ?? session;
  if (!response.ok) throw new Error(`the local Figma server answered ${response.status}`);
  return parseMessage(await response.text());
}

/** Whether the Figma desktop app's MCP server is running. */
export async function mcpAvailable(): Promise<boolean> {
  try {
    session = null;
    const answer = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dev-cli", version: "0" } } });
    if (!answer || !("result" in answer)) return false;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => null);
    return true;
  } catch {
    return false;
  }
}

/**
 * A node's structure from the file open in Figma desktop. The server can't say which file
 * that is, so callers compare the node's name with the one recorded before trusting it.
 */
export async function mcpNode(nodeId: string): Promise<{ nodeName: string; fingerprint: string } | null> {
  const answer = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_metadata", arguments: { nodeId, clientFrameworks: "unknown", clientLanguages: "unknown" } },
  });
  const result = answer?.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
  if (result?.isError || !text) return null;
  // The first element for this node id: its name, and everything that describes it.
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const element = text.match(new RegExp(`<\\w+ id="${escaped}" name="([^"]*)"`));
  if (!element) return null;
  // Leave out the tool's own advice, which isn't part of the design.
  const structure = text.slice(text.indexOf(element[0])).replace(/IMPORTANT:[\s\S]*$/, "");
  return { nodeName: element[1] ?? "", fingerprint: fingerprint(structure) };
}
