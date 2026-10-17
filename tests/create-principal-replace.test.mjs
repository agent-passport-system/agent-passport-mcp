// create_principal must not silently discard the session principal, and must return the
// new principal's private key in full, once, on a local server.
//
// Before this change a second create_principal call replaced the principal held in memory
// without warning, and the response carried only the first 16 characters of the new
// private key, so the previous key was lost and the new one was never usable. Now a second
// call is refused unless replace=true, and the private key follows generate_keys: returned
// in full locally, redacted when MCP_TRANSPORT=sse or MCP_REMOTE=1.
//
// Run: node --test tests/create-principal-replace.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicKeyFromPrivate } from "agent-passport-system";

const SERVER = fileURLToPath(new URL("../build/index.js", import.meta.url));

async function withServer(extraEnv, fn) {
  const home = mkdtempSync(join(tmpdir(), "aps-mcp-principal-"));
  const env = { ...process.env, HOME: home, APS_PROFILE: "full" };
  delete env.MCP_REMOTE;
  delete env.MCP_TRANSPORT;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "principal-test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn((name, args) => request("tools/call", { name, arguments: args }));
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

const text = (r) => r.content.map((c) => c.text).join("\n");

test("create_principal returns the full private key once on a local server", async () => {
  await withServer({}, async (call) => {
    const r = await call("create_principal", { display_name: "Alice" });
    assert.notEqual(r.isError, true, text(r));
    const out = JSON.parse(text(r));
    assert.doesNotMatch(out.privateKey, /\.\.\./);
    assert.equal(publicKeyFromPrivate(out.privateKey), out.publicKey);
  });
});

test("a second create_principal is refused unless replace=true", async () => {
  await withServer({}, async (call) => {
    const first = JSON.parse(text(await call("create_principal", { display_name: "Alice" })));

    const refused = await call("create_principal", { display_name: "Bob" });
    assert.equal(refused.isError, true, text(refused));
    assert.match(text(refused), /replace=true/);
    assert.match(text(refused), /discards the current principal's private key/);

    // The refused call left the first principal in place.
    const fleet = await call("get_fleet_status", {});
    assert.match(text(fleet), new RegExp(first.principalId));

    const replaced = await call("create_principal", { display_name: "Bob", replace: true });
    assert.notEqual(replaced.isError, true, text(replaced));
    const second = JSON.parse(text(replaced));
    assert.notEqual(second.principalId, first.principalId);
    assert.equal(publicKeyFromPrivate(second.privateKey), second.publicKey);
  });
});

test("create_principal redacts the private key on a remote server, as generate_keys does", async () => {
  await withServer({ MCP_TRANSPORT: "sse" }, async (call) => {
    const out = JSON.parse(text(await call("create_principal", { display_name: "Alice" })));
    assert.match(out.privateKey, /^\[REDACTED/);
    const keys = JSON.parse(text(await call("generate_keys", {})));
    assert.equal(out.privateKey, keys.privateKey);
  });
});
