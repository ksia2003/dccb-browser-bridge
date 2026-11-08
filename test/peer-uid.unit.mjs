/** loopbackPeerUid finds the caller's account for both ends of a loopback connection (11-06). */
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { loopbackPeerUid, trustedLocalUids, uidOfUser } from "../server/peer-uid.ts";

const server = createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const accepted = new Promise(resolve => server.once("connection", resolve));
const client = connect(server.address().port, "127.0.0.1");
await new Promise(resolve => client.once("connect", resolve));
const socket = await accepted;
assert.equal(loopbackPeerUid(socket), process.getuid(), "the accepting side sees the caller's account");
assert.equal(loopbackPeerUid({ remotePort: 1, localPort: 1 }), null, "an unknown connection has no account");
client.destroy(); server.close();

assert.deepEqual([...trustedLocalUids({ BRIDGE_TRUSTED_LOCAL_UIDS: "0, 1234,,x,-5" })].sort((a, b) => a - b), [...new Set([0, 1234, process.getuid()])].sort((a, b) => a - b));
assert.equal(uidOfUser("root"), 0);
assert.equal(uidOfUser("no-such-account-dccb"), null);
console.log("  PASS  loopback peer account, trusted account list, and passwd lookup");
