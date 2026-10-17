// create_access_receipt must verify the governance block before it signs.
// A receipt that says governance_verified without a check is a false record,
// so the tool refuses when the block does not verify against the content and
// the publisher's key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, embedGovernance } from "agent-passport-system";

const SERVER = fileURLToPath(new URL("../build/index.js", import.meta.url));

async function withServer(fn) {
  const home = mkdtempSync(join(tmpdir(), "aps-mcp-receipt-"));
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
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "receipt-test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn((name, args) => request("tools/call", { name, arguments: args }));
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

const CONTENT = "An article the publisher governs.";
const publisher = generateKeyPair();
const otherPublisher = generateKeyPair();
const agent = generateKeyPair();
const { block } = embedGovernance({ content: CONTENT, publicKey: publisher.publicKey, privateKey: publisher.privateKey, terms: { training: "prohibited" } });

const baseArgs = {
  agentPublicKey: agent.publicKey,
  agentPrivateKey: agent.privateKey,
  block: JSON.stringify(block),
  content: CONTENT,
  publisherPublicKey: publisher.publicKey,
  sourceUrl: "https://example.org/article",
  intendedUsage: "inference",
};

const text = (r) => r.content.map((c) => c.text).join("\n");

test("create_access_receipt signs when the block verifies", async () => {
  await withServer(async (call) => {
    const r = await call("create_access_receipt", baseArgs);
    assert.notEqual(r.isError, true, text(r));
    assert.match(text(r), /Access Receipt Created/);
    assert.match(text(r), /Governance block: verified/);
  });
});

test("create_access_receipt refuses when the content does not match the block", async () => {
  await withServer(async (call) => {
    const r = await call("create_access_receipt", { ...baseArgs, content: CONTENT + " changed" });
    assert.equal(r.isError, true);
    assert.match(text(r), /refused/);
    assert.doesNotMatch(text(r), /Access Receipt Created/);
  });
});

test("create_access_receipt refuses when the publisher key does not match", async () => {
  await withServer(async (call) => {
    const r = await call("create_access_receipt", { ...baseArgs, publisherPublicKey: otherPublisher.publicKey });
    assert.equal(r.isError, true);
    assert.doesNotMatch(text(r), /Access Receipt Created/);
  });
});

test("create_access_receipt refuses a tampered block", async () => {
  const tampered = { ...block, terms: { ...block.terms, training: "permitted" } };
  await withServer(async (call) => {
    const r = await call("create_access_receipt", { ...baseArgs, block: JSON.stringify(tampered) });
    assert.equal(r.isError, true);
    assert.doesNotMatch(text(r), /Access Receipt Created/);
  });
});
