/**
 * The toolbar badge and the "new version" test, as pure functions so background.ts (badge) and the
 * popup (notice) agree and tests can run them without Chrome.
 */
import { compareExtensionVersions, isExtensionVersion } from "../../shared/protocol";
import type { AuthState, ConnectionIssue } from "./v8-auth";

export interface BadgeMark { text: string; color: string }

/** An unpacked copy updates from the dashboard ZIP; a Web Store copy updates itself, so it has nothing to announce. */
export function updateAvailable(version: string, latest: string | null, fromStore: boolean): boolean {
  return !fromStore && isExtensionVersion(version) && isExtensionVersion(latest) && compareExtensionVersions(version, latest) < 0;
}

/**
 * One mark at a time, by precedence: the AI working (a dot) > switched off ("OFF") > not connected
 * ("!": the login ended, the address is wrong, or a connection attempt failed) > a newer version ("NEW").
 * A Chrome that was never set up, and one that is still making its first attempt, show nothing.
 */
export function badgeFor(input: { working: boolean; state: AuthState; retryReason: ConnectionIssue | null; updateAvailable: boolean }): BadgeMark {
  if (input.working) return { text: " ", color: "#6d5efc" };
  if (input.state === "off") return { text: "OFF", color: "#8a8f98" };
  const disconnected = input.state === "login_ended" || input.state === "address_error"
    || (input.state === "connecting" && input.retryReason !== null);
  if (disconnected) return { text: "!", color: "#d93025" };
  if (input.updateAvailable) return { text: "NEW", color: "#1a73e8" };
  return { text: "", color: "#6d5efc" };
}
