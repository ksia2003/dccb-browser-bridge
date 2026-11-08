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
