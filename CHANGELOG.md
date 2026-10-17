# Changelog

## 8.0.0 (2026-10-17)

Several tools gave answers that the SDK 8 code behind them could not back. This release makes each of them either do the real check or refuse.

### Breaking

- **`create_access_receipt` requires `content` and `publisherPublicKey`.** The tool used to sign `governance_verified: true` without checking anything. It now runs `verifyGovernanceBlock` against the governed content and the publisher's key, and refuses without signing when the block does not verify. Migration: pass the content the block covers as `content` and the publisher's Ed25519 public key (hex) as `publisherPublicKey`. A call that omits either now fails input validation. The tool still returns a text summary, not the signed receipt.
- **`revoke_delegation` takes a delegation record, not a session id.** In SDK 8 `revokeDelegation` and `cascadeRevoke` always throw, so the old tool failed on every call. The tool now issues a signed AuthorityRevocationV1 for an AuthorityDelegationV1 and returns it as JSON. Migration: pass the AuthorityDelegationV1 as `delegation` (a JSON string or object), and a non-empty `reason_code`, which is now required. `delegation_id` is optional and is checked against `delegation.delegation_id` when both are given. The optional `reason` text is written to the record's `detail` member. `cascade` is still accepted and has no effect, because a chain verifier that holds the ancestor record rejects every descendant chain. Legacy `del_...` records from `create_delegation` and `sub_delegate` are refused, because SDK 8 has no revocation for them.
- **`create_principal` requires `replace=true` to replace a principal.** A second call used to discard the current principal's private key and fleet without warning. It is now refused while a principal exists in the process. Migration: pass `replace=true` when replacing is intended. The tool now returns the full private key once on a local (stdio) server, redacted in remote mode, instead of its first 16 characters.
- **`review_promotion` is unavailable.** SDK 8 replaced `createPromotionReview` with a function that always throws. The tool now returns `isError` on every call without calling the SDK, creates no review, and leaves the session promotion history unchanged. Migration: there is no replacement in this server. The input schema is unchanged, so existing callers get the explanation instead of a validation error.
- **`rotate_key` refuses a non-empty `delegation_ids_to_revoke`.** No delegation revocation is wired into rotation, so the old tool rotated the key and reported every requested revocation as an error. It now refuses before generating any key, revokes nothing and schedules nothing. Migration: call `rotate_key` without the list, or with an empty list, and revoke each AuthorityDelegationV1 separately with `revoke_delegation`. The response no longer has a `Revocations` line.
- **`rotate_key` redacts the new private key on a remote server.** With `MCP_TRANSPORT=sse` or `MCP_REMOTE=1` the summary now shows the same redaction string as `generate_keys` instead of the full key. Local stdio servers still return it. Migration: rotate keys through a local server.

### Tool annotations

Every tool now carries a `title` and the four MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) in `tools/list`, from one table in `src/toolAnnotations.ts`. A tool registered without an entry fails the build. Clients that gate calls on these hints may now ask for confirmation before tools marked destructive, such as `revoke_delegation` and `create_principal`. The README tool tables are generated from `tools/list` by `scripts/generate-readme-tools.mjs`, and the test suite fails when they are stale.

## 7.0.0 (2026-10-14)

The server now runs on `agent-passport-system ^8.0.0`, up from `^6.0.0`. Every 6.x install resolved SDK 6.x and missed the SDK 7.x and 8.0.0 verification changes. The major version moves for the same reason as 6.0.0: a tool answer changes on the same input, not because this server's own API changed shape.

### Breaking

- **`create_delegation` takes `max_depth` as a non-negative integer.** SDK 8.0.0 refuses to sign any other depth, so a value such as `-1` or `1.5` used to reach the SDK and come back as an error. The input schema now rejects it.
- **Delegation depth follows SDK 8.0.0.** A present `maxDepth` or `currentDepth` that is not a non-negative integer is invalid instead of coerced, and `maxDepth: null` reads as absent instead of 0. Sub-delegating from a parent without a non-negative integer `maxDepth` fails.

### Unchanged

Of the SDK names this server imports, only `createDelegation`, `subDelegate` and `verifyDelegation` appear in a breaking entry of the SDK changelog between 6.0.1 and 8.0.0. Tool names, input schemas other than `max_depth`, and the 152 tool inventory are unchanged.

## 6.1.2 (2026-10-02)

No server code changes from 6.1.1. The 6.1.1 release reached npm but stopped before the MCP Registry step, because npm took longer than the descriptor check waited. This release goes through the corrected workflow so the server is listed in the MCP Registry as `io.github.agent-passport-system/agent-passport-mcp`.

## 6.1.1 (2026-10-02)

First release from the agent-passport-system organization. No server code changes from 6.1.0.

- Package metadata points at the repository's new home, `agent-passport-system/agent-passport-mcp`, and the MCP registry name is `io.github.agent-passport-system/agent-passport-mcp`.
- The release workflow publishes from the organization repository through npm trusted publishing with release guards, and the second, unguarded registry publishing path is closed.
- README links name the current SDK releases, TypeScript 7.2.1 and Python 4.2.1.

## 6.1.0 (2026-09-22)

Capability-token replay state is now stored on disk instead of only in process memory. Processes using the same store share the same consumed-token records.

- New setting `APS_NULLIFIER_DIR`. Local mode defaults to `~/.agent-passport-nullifiers`.
- When `MCP_REMOTE=1`, `APS_NULLIFIER_DIR` must point to a directory provisioned in advance with a `.aps-nullifier-store` sentinel file. Capability redemption fails closed if the hosted store is not configured correctly.
- Operators using hosted mode need to provision the store before upgrading.
- Consumed-token markers are named by a SHA-256 hash of the authority token preimage, not the preimage itself.

Persistence across a hosted service restart still depends on the configured storage. Verify it after deployment by confirming that a token consumed before a restart remains rejected afterward.

## 6.0.1 (2026-09-04)

Documentation only. The README now names the package by its published name, agent-passport-system-mcp, and the supported-version table lists the 6.0.0 floor. No code change.

## 6.0.0 ({{RELEASE_DATE}})

Compatibility release for the SDK 6.0.0 security release. The full cross-SDK
account is in the advisory published at
https://github.com/aeoess/agent-passport-system/security/advisories.

### Breaking

- **The SDK dependency moves to `agent-passport-system ^6.0.0`**, up from
  `^5.0.0`. That release changes what several verification functions establish:
  authority now comes from caller-supplied trust rather than from a key the
  artifact carries, identities are bound to the keys that signed, chains are
  linked, and a timestamp the verifier cannot read fails closed. The major
  version moves here because a tool answer changes on the same input, not
  because this server's own API changed shape.
- **`aps_create_attribution_receipt` requires self-certifying party
  identifiers.** `citer` and `cited_principal` must be a DID that commits to
  the public key named beside it, which is what the SDK's `createDID` emits
  (the multibase `did:aps` form). A bare public key is refused as unresolved
  and the hex form from `createDIDHex` is refused as not canonical. Receipts
  minted by 5.x with either spelling do not verify and must be reissued.
- **`aps_sign_attribution_consent` signs against the bound key.** The consent
  signature is checked against the key the receipt carries for that party, and
  that key must be the one the party DID commits to.
- **`aps_verify_attribution_consent` binds each party to the key beside it.**
  It previously reported valid for a receipt carrying a victim's identifier
  next to an attacker's key. A party named by an identifier that does not
  self-certify is now refused as unresolved rather than assumed.
- **`aps_check_artifact_citations` inherits that refusal.** Artifacts citing
  receipts whose parties are named by opaque identifiers stop passing the gate.

### Changed

- Every tool description above now states what a valid result establishes and
  what it does not, in the advisory's terms. An integrity result is not an
  authorization decision.
- `server.json` and `.mcp/server.json` move to 6.0.0. Both were still declaring
  5.0.0 while the package was 5.0.2.

### Tests

- Two attacker cases added for the attribution-consent surface: a victim
  identifier beside an attacker key, and identifiers that do not self-certify.
  Both are refused, and the citation gate inherits the refusal.

## 5.0.0 (2026-08-20)

### Breaking

- **`evaluate_threshold` is removed.** It accepted a charter id and signature records whose `signature` field defaulted to the empty string, then answered THRESHOLD MET against the charter's amendment policy. It evaluated declared signer records without verifying that those signatures were valid for the amendment being considered, and no amendment ever reached it. There is no input-compatible replacement, deliberately: the answer the tool gave was not the answer it claimed to give.
- **The amendment threshold answer changes meaning.** Where a caller previously learned whether enough signatures had been declared, the replacement reports whether enough cryptographically valid signatures exist over that specific amendment. A workflow that returned MET can now return not met on the same signers.
- **The SDK dependency moves to `agent-passport-system ^4.4.0`**, up from `^3.3.1`. That line refuses a new write carrying an integer outside the interoperable IEEE 754 range at signing boundaries. Existing verification paths continue to use the unrestricted canonicalizer, so this write-policy change does not reject previously created artifacts during verification.

### Added

- **`propose_amendment`, `sign_amendment` and `verify_amendment`**, the charter amendment lifecycle, in the `governance` profile. `verify_amendment` reports each field of the SDK's verdict separately, `charter_exists`, `version_match`, `signatures_valid`, `proposed_charter_valid`, `threshold_met` and `errors`, with `valid` reported last and labelled as the conjunction of the others. A single verdict line is what made the removed tool misleading; a caller needs to see that signatures verified while the threshold fell short, and the reverse.
- **A generated tool manifest.** Tool metadata is now produced from the runtime registration path instead of maintained as separate counts, which prevents profile-dependent drift. The tool count moves from 150 to 152 and is no longer written by hand in any file.

### Security

- **The cryptographic boundary is enforced by automated checks.** This server does not construct a signing preimage, does not canonicalize governance content, and does not accept signed bytes from a caller. Automated checks prevent it from introducing independent cryptographic derivation logic, and they fail naming the rule and the offending symbol.
- New tests cover a forged signature failing to count with the forged signer named, a signature refusing to replay onto an amendment carrying a different proposed charter, and the SDK's rejection of an explicit `undefined` member reaching the caller unchanged in meaning.

### Compatibility

- Migration is a workflow change rather than a parameter change:
  `create_charter` then `propose_amendment`, `sign_amendment` for each signer, then `verify_amendment`.
- Amendments live in session state only. They do not survive a restart and carry no external trust; the SDK remains the authority for verification semantics.
- The `gateway` profile keeps no amendment capability. Its members are enforcement and runtime tools, and amendment review is a governance workflow.

## 4.0.0 (2026-07-31)

### Added
- MCP 2026-07-28 support through the existing stdio entry while preserving the current 2025-era flow. Modern connections receive the required `resultType`, cache hints (`ttlMs`/`cacheScope`), and server identity metadata from the SDK.

### Breaking
- Node.js 20 or later is now required by the MCP v2 SDK family.
- Corrected the input schemas for 32 fields across 23 tools. These fields were already required by their handlers but were previously declared as optional on the wire. Missing fields now fail at the validation boundary with a field-specific error instead of failing inside the handler.

### Compatibility
- All 150 tool names, profile membership, CLI entry points, and successful APS behavior are preserved.
- Existing 2025-era initialization and tool-call flows remain supported.

### Internal
- Migrated from `@modelcontextprotocol/sdk` 1.x to `@modelcontextprotocol/server` 2.0.0 and Zod 4.
- Retargeted the profile-filtering and handler-error wrapper from `.tool()` to `registerTool()`.
- Verified the packed package end to end through the remote MCP bridge.

### Note
- The essential profile contains 25 profile-gated tools. Because `list_profiles` is always exposed, an essential-profile server presents 26 tools in total.
- The `agent-passport-system` dependency remains on its current line (`^3.3.1`); updating that SDK is a separate change.

## 3.4.0 (2026-07-26)

### Fixed / Security
- **The replay nullifier is consumed after signing, not before, in `aps_capability_sign_effect`.** Consuming first meant a signing failure burned the nullifier, so a caller that retried after a transient error was rejected as a replay and the effect could never be signed. The nullifier is now claimed only once the signature exists.

### Added
- **`agent-passport-access-shim` 0.1.0**, a separate package that emits a signed `AccessReceipt` for each governed `tools/call`.

### Docs
- The browser verify page is linked and described across the navigation, footer, `llms.txt`, `AGENTS.md`, and README.
- Tool descriptions synced to the live registry entries.

### Note
- This release tracks the `agent-passport-system` 3.x line. Moving the dependency onto the 4.x SDK is a separate change with its own test pass.

## 3.3.1 (2026-07-10)

- Tracks SDK 3.3.1 (audit patch). commerce_preflight is gracefully deprecated: it returns a machine-readable moved-to-gateway result instead of calling the SDK's now-throw-only commercePreflight stub, so tools/list stays honest and the call fails cleanly. commerce_preflight also leaves the essential profile in this release (present through 3.3.0; essential is now 26 tools), since a deprecated stub must not be default-recommended. Also: server.json/.mcp/server.json version sync, README profile corrections (default full/150, essential opt-in/26), identify added to essential, mutualAuth tools added to the scope map, serverInfo and setup counts corrected.

## 3.3.0 (2026-07-10)

- Tracks SDK 3.3.0: the agent-passport-system root barrel now exposes audience-binding, bilateral-pair, revocation-observation, evidence-bundle, and jurisdiction-selection. Dependency moves from ^2.6.0-alpha to ^3.3.0; no MCP call-site changes were needed.

## 3.2.4

Dependency-hygiene patch. No tool, API, or behavior change in this server.

### Security (dependencies)
- Pinned the transitive `hono` to `^4.12.27` via an npm `overrides` entry, which clears the
  high-severity advisory (path traversal in `serve-static` on Windows, a CORS default-wildcard
  reflection, and several AWS Lambda adapter issues) reported against `hono <= 4.12.24`. `hono` is a
  transitive dependency of `@modelcontextprotocol/sdk` (via `@hono/node-server`); this is a stdio server
  that does not import or use hono's HTTP features, so the pin is for audit hygiene rather than to close
  a reachable issue here.

### Known remaining advisories
- Three moderate advisories remain (`@anthropic-ai/sdk` and `uuid`), reaching the tree transitively
  through `agent-passport-system`. They are tracked for a separate SDK dependency refresh and are not
  addressed here. `npm audit fix --force` is not used because it would downgrade `agent-passport-system`
  to a breaking older version.

## 3.2.3

Patch release. Behavior and security fixes; no new tools or public API. Tracks SDK v2.9.0.

### Fixed / Security
- **Capability-token `expires_at` is now enforced.** The challenge, authority-evaluation-request, and
  challenge-receipt verifiers (`src/capabilityToken/verify.ts`) now check `expires_at` against the
  current time, and an unparseable `expires_at` is treated as expired (fail closed) rather than ignored.
- **The M3 mint path now fails closed on an expired challenge** (`src/capabilityToken/challengeReceipt.ts`).
  `mintChallengeReceipt` minted a permit regardless of the challenge `expires_at`; it now downgrades an
  expired permit to a deny (`deny_reason: challenge_expired`).
- **Commerce spend gate reads accumulated spend.** The commerce preflight and spend-summary path now
  thread the session delegation's `spentAmount`, closing a read-but-never-written gap where the gate
  always saw 0 spent.

### Behavior changes (operations previously permitted now fail closed)
- A capability challenge that is expired, or whose `expires_at` cannot be parsed, is now rejected by the
  verifiers and denied at mint time, instead of being accepted.
