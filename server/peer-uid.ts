/**
 * The Linux account at the other end of a loopback TCP connection.
 *
 * "From 127.0.0.1" only says the caller is on this box, and a shared box has
 * many accounts. The kernel records each socket's owner in /proc/net/tcp{,6};
 * the caller's socket is the row whose local port is our remote port and whose
 * remote port is our local port. (11-06 review: any account on the box could
 * otherwise attach as a browser or drive /send with a leaked secret.)
 */
import { readFileSync } from "node:fs";

interface SocketPorts { remotePort?: number; localPort?: number }

function rows(file: string): string[][] {
  try { return readFileSync(file, "utf8").split("\n").slice(1).map(line => line.trim().split(/\s+/)); }
  catch { return []; }
}

const port = (address: string | undefined): number => parseInt(address?.split(":")[1] ?? "", 16);

/** The caller's uid, or null when the connection is not found (it closed, or is not loopback TCP). */
export function loopbackPeerUid(socket: SocketPorts): number | null {
  if (!socket.remotePort || !socket.localPort) return null;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const fields of rows(file)) {
      if (port(fields[1]) === socket.remotePort && port(fields[2]) === socket.localPort) {
        const uid = Number(fields[7]);
        if (Number.isInteger(uid)) return uid;
      }
    }
  }
  return null;
}

/** This relay's own account, plus any listed in BRIDGE_TRUSTED_LOCAL_UIDS (the box's public door). */
export function trustedLocalUids(env: NodeJS.ProcessEnv = process.env): ReadonlySet<number> {
  const uids = new Set<number>([process.getuid?.() ?? -1]);
  for (const part of (env.BRIDGE_TRUSTED_LOCAL_UIDS ?? "").split(",")) {
    const uid = Number(part.trim());
    if (part.trim() !== "" && Number.isInteger(uid) && uid >= 0) uids.add(uid);
  }
  return uids;
}

/** uid of a local account by name from /etc/passwd, or null. */
export function uidOfUser(name: string): number | null {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields[0] === name) return Number.isInteger(Number(fields[2])) ? Number(fields[2]) : null;
    }
  } catch { /* no passwd file: no account matches */ }
  return null;
}
