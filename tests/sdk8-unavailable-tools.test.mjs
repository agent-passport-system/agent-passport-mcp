// Tools whose SDK 8 dependency is missing must refuse up front instead of
// doing part of the work. review_promotion depends on createPromotionReview,
// which always throws in agent-passport-system 8. rotate_key has no delegation
// revocation wired in, so it refuses a delegation list before generating a key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "agent-passport-system";

const SERVER = fileURLToPath(new URL("../build/index.js", import.meta.url));

async function withServer(fn) {
  const home = mkdtempSync(join(tmpdir(), "aps-mcp-sdk8-"));
  const env = { ...process.env, HOME: home, APS_PROFILE: "full" };
  delete env.MCP_REMOTE;
  delete env.MCP_TRANSPORT;
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
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sdk8-test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn((name, args) => request("tools/call", { name, arguments: args }));
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

const text = (r) => r.content.map((c) => c.text).join("\n");
const agent = generateKeyPair();

test("review_promotion returns isError without creating a review", async () => {
  await withServer(async (call) => {
    const r = await call("review_promotion", {
      agentId: "agent-x", principalId: "principal-x", scope: "code",
      toTier: 1, verdict: "promoted", reasoning: "test",
    });
    assert.equal(r.isError, true);
    const body = JSON.parse(text(r));
    assert.equal(body.error, "review_promotion is unavailable with SDK 8. No review is created.");

    const history = await call("get_promotion_history", {});
    assert.notEqual(history.isError, true, text(history));
    assert.equal(JSON.parse(text(history)).count, 0);
  });
});

test("rotate_key refuses a non-empty delegation list and rotates nothing", async () => {
  await withServer(async (call) => {
    const r = await call("rotate_key", {
      mode: "emergency",
      old_private_key: agent.privateKey,
      delegation_ids_to_revoke: ["del_abc"],
    });
    assert.equal(r.isError, true);
    const body = text(r);
    assert.match(body, /delegation revocation is not integrated in this server/);
    assert.match(body, /No key was rotated, no delegation was revoked, and no background completion is scheduled/);
    assert.doesNotMatch(body, /New private key/);
    assert.doesNotMatch(body, /Key Rotation/);

    // A later rotation from the same key still starts from that key: the
    // refused call changed nothing the next call reads.
    const later = await call("rotate_key", { mode: "emergency", old_private_key: agent.privateKey });
    assert.notEqual(later.isError, true, text(later));
    assert.match(text(later), new RegExp(`^Old key: ${agent.publicKey.slice(0, 16)}\\.\\.\\.$`, "m"));
  });
});

test("rotate_key with an empty delegation list still rotates", async () => {
  await withServer(async (call) => {
    const r = await call("rotate_key", {
      mode: "planned",
      old_private_key: agent.privateKey,
      delegation_ids_to_revoke: [],
    });
    assert.notEqual(r.isError, true, text(r));
    const body = text(r);
    assert.match(body, /Key Rotation \(planned\)/);
    assert.match(body, new RegExp(`^Old key: ${agent.publicKey.slice(0, 16)}\\.\\.\\.$`, "m"));
    const m = body.match(/^New private key: ([0-9a-f]+)$/m);
    assert.ok(m, body);
    assert.notEqual(m[1], agent.privateKey);
    assert.match(body, /^Rotation log entries: \d+$/m);
  });
});
