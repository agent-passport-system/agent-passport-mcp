// issue_authority_delegation mints the AuthorityDelegationV1 that revoke_delegation can
// revoke, and check_authority_delegation verifies it, including revocation status.
// Before these tools, an MCP user could create delegations (create_delegation) that
// revoke_delegation refuses, with no tool to mint a revocable one.
//
// Run: node --test tests/issue-authority-delegation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, issueAuthorityDelegation, verifyAuthorityDelegation } from "agent-passport-system";

const SERVER = fileURLToPath(new URL("../build/index.js", import.meta.url));

async function withServer(keys, fn, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "aps-mcp-issue-"));
  const env = { ...process.env, HOME: home, APS_PROFILE: "full", AGENT_KEY: keys.publicKey, AGENT_PRIVATE_KEY: keys.privateKey, ...extraEnv };
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
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "issue-test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn((name, args) => request("tools/call", { name, arguments: args }));
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

const text = (r) => r.content.map((c) => c.text).join("\n");
const serverKeys = generateKeyPair();
const SPEND = { spend_unit: "iso4217:USD:minor", spend_per_action: 500, spend_cumulative: 2000 };

test("issued delegation verifies independently, checks valid, and checks REVOKED after revoke_delegation", async () => {
  await withServer(serverKeys, async (call) => {
    const r = await call("issue_authority_delegation", { subject: "did:example:agent-a", grants: ["commerce:checkout"], ...SPEND, depth_remaining: 1, ttl_hours: 1 });
    assert.notEqual(r.isError, true, text(r));
    const { delegation } = JSON.parse(text(r));
    assert.equal(delegation.record_type, "aps:authority-delegation:v1");
    assert.equal(delegation.parent_delegation_id, null);
    assert.equal(delegation.subject, "did:example:agent-a");
    assert.deepEqual(delegation.authority.scope.grants, ["commerce:checkout"]);
    assert.deepEqual(delegation.authority.spend, { mode: "bounded", unit: "iso4217:USD:minor", per_action: "500", cumulative: "2000" });
    assert.equal(delegation.authority.depth.remaining, 1);

    // An independent verifier that resolves the issuer's method to the server key accepts it.
    const indep = verifyAuthorityDelegation(delegation, {
      now: new Date().toISOString(),
      resolveVerificationKey: (iss, vm) => (iss === delegation.issuer && vm === delegation.verification_method ? serverKeys.publicKey : null),
      trustRoot: () => true,
      resolveRevocation: () => "active",
    });
    assert.equal(indep.valid, true, JSON.stringify(indep.failures));

    const c1 = JSON.parse(text(await call("check_authority_delegation", { delegation })));
    assert.equal(c1.issued_by_this_server, true);
    assert.equal(c1.valid, true, JSON.stringify(c1.failures));

    const rv = await call("revoke_delegation", { delegation, reason_code: "withdrawn" });
    assert.notEqual(rv.isError, true, text(rv));
    assert.equal(JSON.parse(text(rv)).verification, "valid");

    const c2 = JSON.parse(text(await call("check_authority_delegation", { delegation: JSON.stringify(delegation) })));
    assert.equal(c2.valid, false);
    assert.ok(c2.failures.some((f) => f.code === "REVOKED"), JSON.stringify(c2.failures));
  });
});

test("issue_authority_delegation refuses a missing, partial or inverted spend limit", async () => {
  await withServer(serverKeys, async (call) => {
    const none = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"] });
    assert.equal(none.isError, true); assert.match(text(none), /no spend limit given/);
    const partial = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], spend_unit: "iso4217:USD:minor" });
    assert.equal(partial.isError, true); assert.match(text(partial), /all three/);
    const inverted = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], spend_unit: "u", spend_per_action: 9, spend_cumulative: 1 });
    assert.equal(inverted.isError, true); assert.match(text(inverted), /larger than spend_cumulative/);
    const unb = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], spend_unbounded: true });
    assert.notEqual(unb.isError, true, text(unb));
    assert.deepEqual(JSON.parse(text(unb)).delegation.authority.spend, { mode: "unbounded" });
  });
});

test("check_authority_delegation does not accept a delegation another key signed", async () => {
  const other = generateKeyPair();
  const now = Date.now();
  const foreign = issueAuthorityDelegation({
    record_type: "aps:authority-delegation:v1", version: "1.0", parent_delegation_id: null,
    issuer: "did:example:other", subject: "did:example:agent-a", verification_method: "did:example:other#key-1",
    issued_at: new Date(now - 1000).toISOString(), nonce: "00112233445566778899aabbccddeeff",
    authority: {
      scope: { profile: "aps-hierarchical-v1", grants: ["commerce:checkout"] },
      spend: { mode: "unbounded" }, depth: { remaining: 0 },
      time: { not_before: new Date(now - 1000).toISOString(), not_after: new Date(now + 3_600_000).toISOString() },
      reputation: { profile: "aps-score-0-100-v1", ceiling: 100 },
      values: { profile: "aps-values-identifiers-v1", required: [] },
      reversibility: { profile: "aps-tci-v1", ceiling: "compensable" },
    },
  }, other.privateKey);
  await withServer(serverKeys, async (call) => {
    const c = JSON.parse(text(await call("check_authority_delegation", { delegation: foreign })));
    assert.equal(c.issued_by_this_server, false);
    assert.equal(c.valid, false);
    assert.ok(c.failures.some((f) => f.code === "KEY_NOT_FOUND"), JSON.stringify(c.failures));
  });
});

const T = Date.now();
function rootFields(issuer, overrides = {}) {
  return {
    record_type: "aps:authority-delegation:v1", version: "1.0", parent_delegation_id: null,
    issuer, subject: "did:example:agent-a", verification_method: `${issuer}#key-1`,
    issued_at: new Date(T - 2000).toISOString(), nonce: "0123456789abcdef0123456789abcdef",
    authority: {
      scope: { profile: "aps-hierarchical-v1", grants: ["commerce:checkout"] },
      spend: { mode: "unbounded" }, depth: { remaining: 0 },
      time: { not_before: new Date(T - 2000).toISOString(), not_after: new Date(T + 3_600_000).toISOString() },
      reputation: { profile: "aps-score-0-100-v1", ceiling: 100 },
      values: { profile: "aps-values-identifiers-v1", required: [] },
      reversibility: { profile: "aps-tci-v1", ceiling: "compensable" },
    },
    ...overrides,
  };
}

test("issue_authority_delegation has no issuer override and always names the server key", async () => {
  await withServer(serverKeys, async (call) => {
    const r = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], ...SPEND, issuer: "did:web:bank.example" });
    assert.notEqual(r.isError, true, text(r));
    const { delegation } = JSON.parse(text(r));
    assert.equal(delegation.issuer, `aps:ed25519:${serverKeys.publicKey}`);
    assert.equal(delegation.verification_method, `aps:ed25519:${serverKeys.publicKey}#key-1`);
  });
});

test("check_authority_delegation rejects a record the server key signed under another issuer name", async () => {
  const forged = issueAuthorityDelegation(rootFields("did:web:bank.example"), serverKeys.privateKey);
  await withServer(serverKeys, async (call) => {
    const c = JSON.parse(text(await call("check_authority_delegation", { delegation: forged })));
    assert.equal(c.issued_by_this_server, false);
    assert.equal(c.valid, false);
    assert.ok(c.failures.some((f) => f.code === "KEY_NOT_FOUND"), JSON.stringify(c.failures));
  });
});

test("check_authority_delegation reports EXPIRED and ID_MISMATCH with exact codes", async () => {
  const issuer = `aps:ed25519:${serverKeys.publicKey}`;
  const expired = issueAuthorityDelegation(rootFields(issuer, {
    issued_at: new Date(T - 7_200_000).toISOString(),
    authority: { ...rootFields(issuer).authority, time: { not_before: new Date(T - 7_200_000).toISOString(), not_after: new Date(T - 3_600_000).toISOString() } },
  }), serverKeys.privateKey);
  const good = issueAuthorityDelegation(rootFields(issuer, { nonce: "fedcba9876543210fedcba9876543210" }), serverKeys.privateKey);
  const tampered = { ...good, authority: { ...good.authority, scope: { ...good.authority.scope, grants: ["commerce:*"] } } };
  await withServer(serverKeys, async (call) => {
    const e = JSON.parse(text(await call("check_authority_delegation", { delegation: expired })));
    assert.equal(e.valid, false);
    assert.ok(e.failures.some((f) => f.code === "EXPIRED"), JSON.stringify(e.failures));
    const m = JSON.parse(text(await call("check_authority_delegation", { delegation: tampered })));
    assert.equal(m.valid, false);
    assert.ok(m.failures.some((f) => f.code === "ID_MISMATCH"), JSON.stringify(m.failures));
  });
});

test("after a restart a revoked record is never reported valid", async () => {
  let delegation;
  await withServer(serverKeys, async (call) => {
    delegation = JSON.parse(text(await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], ...SPEND }))).delegation;
    const rv = await call("revoke_delegation", { delegation, reason_code: "withdrawn" });
    assert.notEqual(rv.isError, true, text(rv));
  });
  await withServer(serverKeys, async (call) => {
    const c = JSON.parse(text(await call("check_authority_delegation", { delegation })));
    assert.equal(c.valid, false);
    assert.ok(c.failures.some((f) => f.code === "REVOCATION_UNKNOWN"), JSON.stringify(c.failures));
  });
});

test("issue_authority_delegation refuses mismatched identify keys, spend plus unbounded, unsafe integers, and remote transports", async () => {
  const other = generateKeyPair();
  await withServer(serverKeys, async (call) => {
    const both = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], ...SPEND, spend_unbounded: true });
    assert.equal(both.isError, true); assert.match(text(both), /spend_unbounded is set together/);
    const big = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], spend_unit: "u", spend_per_action: 1, spend_cumulative: 2 ** 53 + 2 });
    assert.equal(big.isError, true, text(big));
    await call("identify", { public_key: serverKeys.publicKey, private_key: other.privateKey, agent_id: "mismatch" });
    const mm = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], ...SPEND });
    assert.equal(mm.isError, true); assert.match(text(mm), /do not belong together/);
  });
  await withServer(serverKeys, async (call) => {
    const r = await call("issue_authority_delegation", { subject: "s", grants: ["commerce:checkout"], ...SPEND });
    assert.equal(r.isError, true); assert.match(text(r), /only on a local \(stdio\) server/);
  }, { MCP_REMOTE: "1" });
});

test("the legacy refusal points to issue_authority_delegation", async () => {
  await withServer(serverKeys, async (call) => {
    const created = await call("create_delegation", { delegated_to: generateKeyPair().publicKey, scope: ["web_search"], spend_limit: 1, max_depth: 1, expires_in_hours: 1 });
    const { delegationId } = JSON.parse(text(created));
    const r = await call("revoke_delegation", { delegation_id: delegationId, reason_code: "x" });
    assert.equal(r.isError, true);
    assert.match(text(r), /use issue_authority_delegation/);
  });
});

test("list_tools_for_scope lists both tools under delegation and under the wildcard", async () => {
  await withServer(serverKeys, async (call) => {
    for (const scopes of [["delegation"], ["*"]]) {
      const r = await call("list_tools_for_scope", { scopes });
      assert.notEqual(r.isError, true, text(r));
      for (const name of ["issue_authority_delegation", "check_authority_delegation", "revoke_delegation"]) {
        assert.match(text(r), new RegExp(`\\b${name}\\b`), `${name} missing for ${JSON.stringify(scopes)}`);
      }
    }
    const other = await call("list_tools_for_scope", { scopes: ["commerce"] });
    assert.doesNotMatch(text(other), /\bissue_authority_delegation\b/);
  });
});
