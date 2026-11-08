/**
 * DCCB Browser Bridge — tool registry + dispatcher for the few tools the extension itself serves
 * (1.2.0): `fetch` (a request with the person's cookies, no tab), `handoff` and `notify` (the
 * person), `extension` (version / reload). Page work goes through the pipe (lib/pipe.ts).
 *
 * `dispatch` runs the tool and normalises the outcome into a `ToolResponse` ({result} or
 * {error}). It never throws, so the caller can always forward what it returns to the relay.
 */
import type { ToolRequest, ToolResponse } from "../../shared/protocol";
import { normalizeWorkspace, setLastWorkspace } from "./target";

export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs) => Promise<unknown>;

const registry = new Map<string, ToolHandler>();

/** Register a tool handler. Throws on duplicate name (programmer error). */
export function register(name: string, handler: ToolHandler): void {
  if (registry.has(name)) throw new Error(`tool already registered: ${name}`);
  registry.set(name, handler);
}

/** Names of all registered tools (for diagnostics). */
export function toolNames(): string[] {
  return [...registry.keys()];
}

export async function dispatch(req: ToolRequest): Promise<ToolResponse> {
  const handler = registry.get(req.tool);
  if (!handler) {
    return {
      id: req.id,
      type: "tool_response",
      error: `unknown_tool: ${req.tool} (known: ${toolNames().join(", ") || "none"}; page work goes through pc-browser)`,
    };
  }
  const args = { ...req.args };
  try {
    const workspace = normalizeWorkspace(args.workspace);
    setLastWorkspace(workspace);
    args.workspace = workspace;
    return { id: req.id, type: "tool_response", result: await handler(args) };
  } catch (e) {
    return { id: req.id, type: "tool_response", error: e instanceof Error ? e.message : String(e) };
  }
}
