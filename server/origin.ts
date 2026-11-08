/** Accept only an origin issued for a Chrome extension. */
export function isChromeExtensionOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "chrome-extension:"
      && parsed.hostname.length > 0
      && parsed.port.length === 0
      && (parsed.pathname === "" || parsed.pathname === "/")
      && parsed.search.length === 0
      && parsed.hash.length === 0
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

/**
 * Let the extension call its two bootstrap routes (/api/enroll/redeem, /api/auth/refresh) even when
 * the person limited its site access in Chrome ("on click" / specific sites): Chrome then applies
 * CORS to the extension, and the JSON POST is preflighted. Only a chrome-extension:// origin is
 * answered; these routes are authenticated by the one-time code or the refresh token they carry,
 * so allowing the extension to read the answer grants nothing a web page could use. A Local
 * Network Access preflight (a tailnet or LAN address) is answered too.
 */
export function allowExtensionOrigin(req: { headers: Record<string, string | string[] | undefined> }, res: { setHeader(name: string, value: string): unknown }): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!origin || !isChromeExtensionOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
}
