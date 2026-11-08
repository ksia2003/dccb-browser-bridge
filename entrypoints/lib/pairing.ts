/** Setting up from one paste of the dashboard's address and code (6.0.0). */

/**
 * The dashboard shows the address and the code together; take both from one paste (any order,
 * spaces, a code block's backticks). Returns null for what is missing.
 */
export function parsePairing(text: string): { address: string | null; code: string | null } {
  const url = /https?:\/\/[^\s`'"<>]+/i.exec(text)?.[0] ?? null;
  const rest = (url ? text.replace(url, " ") : text).toUpperCase();
  const code = /(?:^|[^A-Z0-9])([A-Z2-9]{4})[\s-]?([A-Z2-9]{4})(?![A-Z0-9])/.exec(rest);
  return { address: url, code: code ? code[1] + code[2] : null };
}
