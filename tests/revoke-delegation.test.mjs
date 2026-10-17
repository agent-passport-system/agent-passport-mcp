// revoke_delegation issues a draft-03 section 3.5.1 AuthorityRevocationV1.
//
// In agent-passport-system 8, revokeDelegation and cascadeRevoke are throw-only stubs
// ("This function has moved to DelegationStore in @aeoess/gateway"), so the tool used to
// fail on every call. It now signs an AuthorityRevocationV1 for an AuthorityDelegationV1
// with the server's key, records it in an in-memory store and returns the signed record.
// These tests check the returned record with the SDK's own verifier and chain verifier,
// and check the refusals.
//
// Run: node --test tests/revoke-delegation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateKeyPair,
  issueAuthorityDelegation, issueSubAuthorityDelegation, verifyAuthorityDelegationChain,
  verifyAuthorityRevocation, isAuthorityRevocationV1,
  InMemoryAuthorityRevocationStore, recordAuthorityRevocation, createAuthorityRevocationResolver,
} from "agent-passport-system";

// The SDK's package entry does not re-export these constants, so their draft values are
// written here.
const AUTHORITY_DELEGATION_RECORD_TYPE = "aps:authority-delegation:v1";
const AUTHORITY_DELEGATION_VERSION = "1.0";
const SCOPE_PROFILE_V1 = "aps-hierarchical-v1";
const REPUTATION_PROFILE_V1 = "aps-score-0-100-v1";
const VALUES_PROFILE_V1 = "aps-values-identifiers-v1";
const REVERSIBILITY_PROFILE_V1 = "aps-tci-v1";

const SERVER = fileURLToPath(new URL("../build/index.js", import.meta.url));

async function withServer(keys, fn) {
  const home = mkdtempSync(join(tmpdir(), "aps-mcp-revoke-"));
  const env = { ...process.env, HOME: home, APS_PROFILE: "full", AGENT_KEY: keys.publicKey, AGENT_PRIVATE_KEY: keys.privateKey };
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
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "revoke-test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn((name, args) => request("tools/call", { name, arguments: args }));
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

const text = (r) => r.content.map((c) => c.text).join("\n");

const ISSUER = "did:example:root";
const ISSUER_VM = `${ISSUER}#key-1`;
const SUBJECT = "did:example:agent-a";
const SUBJECT_VM = `${SUBJECT}#key-1`;
const CHILD_SUBJECT = "did:example:agent-b";

const serverKeys = generateKeyPair();
const subjectKeys = generateKeyPair();
const otherKeys = generateKeyPair();

const ms = (t) => new Date(t).toISOString();
const T0 = Date.now() - 60_000;

function vector(grants, perAction, depth, notBefore, notAfter) {
  return {
    scope: { profile: SCOPE_PROFILE_V1, grants },
    spend: { mode: "bounded", unit: "iso4217:USD:minor", per_action: perAction, cumulative: perAction },
    depth: { remaining: depth },
    time: { not_before: ms(notBefore), not_after: ms(notAfter) },
    reputation: { profile: REPUTATION_PROFILE_V1, ceiling: 80 },
    values: { profile: VALUES_PROFILE_V1, required: ["F-001"] },
    reversibility: { profile: REVERSIBILITY_PROFILE_V1, ceiling: "compensable" },
  };
}

function rootSignedBy(privateKey, nonce = "00112233445566778899aabbccddeeff") {
  return issueAuthorityDelegation({
    record_type: AUTHORITY_DELEGATION_RECORD_TYPE,
    version: AUTHORITY_DELEGATION_VERSION,
    parent_delegation_id: null,
    issuer: ISSUER,
    subject: SUBJECT,
    verification_method: ISSUER_VM,
    issued_at: ms(T0),
    nonce,
    authority: vector(["commerce:*"], "100", 3, T0, T0 + 3_600_000),
  }, privateKey);
}

const keysByMethod = new Map([[ISSUER_VM, serverKeys.publicKey], [SUBJECT_VM, subjectKeys.publicKey]]);
const resolveVerificationKey = (_issuer, method) => keysByMethod.get(method) ?? null;

test("revoke_delegation returns a signed AuthorityRevocationV1 that verifies and revokes descendants", async () => {
  const root = rootSignedBy(serverKeys.privateKey);
  const child = issueSubAuthorityDelegation(root, {
    record_type: AUTHORITY_DELEGATION_RECORD_TYPE,
    version: AUTHORITY_DELEGATION_VERSION,
    parent_delegation_id: root.delegation_id,
    issuer: SUBJECT,
    subject: CHILD_SUBJECT,
    verification_method: SUBJECT_VM,
    issued_at: ms(T0 + 1_000),
    nonce: "ffeeddccbbaa99887766554433221100",
    authority: vector(["commerce:checkout"], "50", 2, T0 + 1_000, T0 + 1_800_000),
  }, subjectKeys.privateKey, { now: ms(T0 + 2_000), resolveVerificationKey, resolveRevocation: () => "active" });

  await withServer(serverKeys, async (call) => {
    const r = await call("revoke_delegation", { delegation: JSON.stringify(root), reason_code: "key_compromise", reason: "test detail" });
    assert.notEqual(r.isError, true, text(r));
    const out = JSON.parse(text(r));
    assert.equal(out.inserted, true);
    assert.equal(out.verification, "valid");
    const rev = out.revocation;
    assert.equal(isAuthorityRevocationV1(rev), true);
    assert.equal(rev.record_type, "aps:authority-revocation:v1");
    assert.equal(rev.delegation_id, root.delegation_id);
    assert.equal(rev.revoker, ISSUER);
    assert.equal(rev.verification_method, ISSUER_VM);
    assert.equal(rev.reason_code, "key_compromise");
    assert.equal(rev.detail, "test detail");

    // An independent verifier with its own key resolution accepts the record.
    assert.equal(verifyAuthorityRevocation(rev, root, { resolveVerificationKey }).state, "valid");

    // A chain verifier holding the record rejects the descendant chain, with no
    // per-descendant record.
    const store = new InMemoryAuthorityRevocationStore();
    store.track(root.delegation_id);
    store.track(child.delegation_id);
    assert.equal(recordAuthorityRevocation(store, root, rev, { resolveVerificationKey }).recorded, true);
    const chain = verifyAuthorityDelegationChain([root, child], {
      now: ms(T0 + 3_000),
      resolveVerificationKey,
      trustRoot: (d) => d.delegation_id === root.delegation_id,
      resolveRevocation: createAuthorityRevocationResolver(store, { resolveVerificationKey }),
    });
    assert.equal(chain.valid, false);
    assert.ok(chain.failures.some((f) => f.code === "REVOKED"), JSON.stringify(chain.failures));

    // A repeat call returns the record already held, unchanged.
    const again = await call("revoke_delegation", { delegation: root, reason_code: "other" });
    assert.notEqual(again.isError, true, text(again));
    const out2 = JSON.parse(text(again));
    assert.equal(out2.inserted, false);
    assert.equal(out2.revocation.revocation_id, rev.revocation_id);
  });
});

test("revoke_delegation refuses a delegation this server's key did not sign", async () => {
  const foreign = rootSignedBy(otherKeys.privateKey, "0123456789abcdef0123456789abcdef");
  await withServer(serverKeys, async (call) => {
    const r = await call("revoke_delegation", { delegation: foreign, reason_code: "x" });
    assert.equal(r.isError, true);
    assert.match(text(r), /does not verify under this server's public key/);
  });
});

test("revoke_delegation refuses a legacy session delegation with an explanation", async () => {
  await withServer(serverKeys, async (call) => {
    const created = await call("create_delegation", {
      delegated_to: generateKeyPair().publicKey, scope: ["web_search"], spend_limit: 1, max_depth: 1, expires_in_hours: 1,
    });
    assert.notEqual(created.isError, true, text(created));
    const { delegationId } = JSON.parse(text(created));
    // `reason` is also the argument the SDK-7 tool took, so on the previous code this call
    // reaches cascadeRevoke and fails with the SDK 8 "has moved to" stub error.
    const r = await call("revoke_delegation", { delegation_id: delegationId, reason_code: "x", reason: "no longer needed" });
    assert.doesNotMatch(text(r), /has moved to/);
    assert.equal(r.isError, true);
    assert.match(text(r), /legacy delegation/);
  });
});
