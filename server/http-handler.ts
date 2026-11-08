import type { ServerResponse } from "node:http";

/** Turn an async route rejection into an HTTP 500 instead of an unhandled rejection. */
export function runHttpHandler(
  label: string,
  res: ServerResponse,
  handler: () => Promise<void>,
): void {
  const fail = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[server] HTTP handler ${label} failed: ${detail}`);
    if (res.headersSent || res.writableEnded || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  };
  try {
    void handler().catch(fail);
  } catch (error) {
    fail(error);
  }
}
