// Behavioural tests for the release principal guard.
//
// The release workflow had no actor check at all. Ownership of the repository
// was the only thing standing between a write-capable account and a published
// release, and moving the repository into an organization turns that single
// account into an organization-level grant. These tests pin what the guard
// refuses, because a guard that fails open is worse than no guard: it reads as
// protection in the workflow log while authorizing everyone.
//
// Each case drives the exported validators directly rather than the workflow,
// so the refusals are asserted here instead of being discovered on a release.
//
// Run: node --test tests/release-actor-state.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHORIZED_RELEASE_ACTOR_ID,
  MCP_REPOSITORY_ID,
  authorizeReleaseActor,
  validateOriginalReleaseActor,
  validateReleaseRunAttempt,
} from '../.github/scripts/release-actor-state.mjs'

const REPOSITORY = 'agent-passport-system/agent-passport-mcp'
const RUN_ID = 36966151267
const RUN_ATTEMPT = 1

const context = (overrides = {}) => ({
  repository: REPOSITORY,
  repositoryId: MCP_REPOSITORY_ID,
  runId: RUN_ID,
  runAttempt: RUN_ATTEMPT,
  ...overrides,
})

const attemptDocument = (overrides = {}) => ({
  id: RUN_ID,
  run_attempt: RUN_ATTEMPT,
  repository: { full_name: REPOSITORY, id: MCP_REPOSITORY_ID },
  triggering_actor: { id: AUTHORIZED_RELEASE_ACTOR_ID },
  ...overrides,
})

const ok = (document = attemptDocument()) => ({ status: 200, document })

const env = (overrides = {}) => ({
  GITHUB_ACTOR_ID: String(AUTHORIZED_RELEASE_ACTOR_ID),
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REPOSITORY_ID: String(MCP_REPOSITORY_ID),
  GITHUB_RUN_ID: String(RUN_ID),
  GITHUB_RUN_ATTEMPT: String(RUN_ATTEMPT),
  GH_TOKEN: 'test-token',
  ...overrides,
})

// The pinned identities are the whole point of the guard, so they are asserted
// rather than left to a reader to confirm against the repository settings.
test('the guard pins the release actor and the repository it releases from', () => {
  assert.equal(AUTHORIZED_RELEASE_ACTOR_ID, 171286556)
  assert.equal(MCP_REPOSITORY_ID, 1166022414)
})

test('the authorized actor id passes the original-actor check', () => {
  assert.equal(
    validateOriginalReleaseActor(String(AUTHORIZED_RELEASE_ACTOR_ID)),
    AUTHORIZED_RELEASE_ACTOR_ID,
  )
})

// Moving into an organization is exactly the case that makes this bite: every
// other organization member is a different actor id with the same write access.
test('another actor id is refused even with identical write access', () => {
  assert.throws(
    () => validateOriginalReleaseActor('1'),
    /release tags must be pushed by the authorized release actor/,
  )
})

test('a missing, empty or non-numeric actor id is refused rather than skipped', () => {
  for (const value of [undefined, null, '', ' ', '0', '171286556x', 'aeoess', '+171286556']) {
    assert.throws(
      () => validateOriginalReleaseActor(value),
      /release tags must be pushed by the authorized release actor/,
      `expected ${JSON.stringify(value)} to be refused`,
    )
  }
})

test('a complete, matching run attempt document is accepted', () => {
  const summary = validateReleaseRunAttempt(context(), ok())
  assert.deepEqual(summary, {
    repository: REPOSITORY,
    repositoryId: MCP_REPOSITORY_ID,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    triggeringActorId: AUTHORIZED_RELEASE_ACTOR_ID,
  })
})

// The rerun case the guard exists for: attempt 1 was authorized, someone else
// asks for attempt 2. GITHUB_ACTOR_ID still names the original actor, so only
// the triggering actor of this attempt can catch it.
test('a rerun requested by another actor is refused', () => {
  assert.throws(
    () => validateReleaseRunAttempt(
      context({ runAttempt: 2 }),
      ok(attemptDocument({ run_attempt: 2, triggering_actor: { id: 1 } })),
    ),
    /this release attempt must be requested by the authorized release actor/,
  )
})

test('a run attempt lookup that did not return 200 fails closed', () => {
  for (const status of [301, 401, 403, 404, 422, 500, undefined]) {
    assert.throws(
      () => validateReleaseRunAttempt(context(), { status, document: attemptDocument() }),
      /the requesting release actor is not established/,
      `expected HTTP ${status} to fail closed`,
    )
  }
})

test('a non-object document is refused rather than read as empty', () => {
  for (const document of [null, undefined, 'ok', 42, [attemptDocument()]]) {
    assert.throws(
      () => validateReleaseRunAttempt(context(), { status: 200, document }),
      /non-object document/,
      `expected ${JSON.stringify(document)} to be refused`,
    )
  }
})

test('a document naming a different repository is refused', () => {
  assert.throws(
    () => validateReleaseRunAttempt(
      context(),
      ok(attemptDocument({ repository: { full_name: 'aeoess/agent-passport-mcp', id: MCP_REPOSITORY_ID } })),
    ),
    /does not name this repository/,
  )
})

// The repository id is the part a transfer cannot change, so a document whose
// full name matches but whose id does not is the impersonation case.
test('a document whose repository id is not the pinned id is refused', () => {
  assert.throws(
    () => validateReleaseRunAttempt(
      context(),
      ok(attemptDocument({ repository: { full_name: REPOSITORY, id: 1161268529 } })),
    ),
    /does not name this repository id/,
  )
})

test('a document with no repository id is refused rather than treated as absent', () => {
  for (const id of [undefined, null, '1166022414', 1166022414.5]) {
    assert.throws(
      () => validateReleaseRunAttempt(
        context(),
        ok(attemptDocument({ repository: { full_name: REPOSITORY, id } })),
      ),
      /has no repository id/,
      `expected repository id ${JSON.stringify(id)} to be refused`,
    )
  }
})

test('a document naming a different run or attempt is refused', () => {
  assert.throws(
    () => validateReleaseRunAttempt(context(), ok(attemptDocument({ id: RUN_ID + 1 }))),
    /does not name this run/,
  )
  assert.throws(
    () => validateReleaseRunAttempt(context(), ok(attemptDocument({ run_attempt: 2 }))),
    /does not name this attempt/,
  )
})

test('a document with no triggering actor id is refused', () => {
  for (const actor of [undefined, null, {}, { id: null }, { id: '171286556' }]) {
    assert.throws(
      () => validateReleaseRunAttempt(context(), ok(attemptDocument({ triggering_actor: actor }))),
      /has no triggering actor id/,
      `expected triggering actor ${JSON.stringify(actor)} to be refused`,
    )
  }
})

// Ordering matters. The original-actor check must run before anything reaches
// the network, so an unauthorized actor never causes a lookup at all.
test('an unauthorized original actor is refused before any request is made', async () => {
  let calls = 0
  await assert.rejects(
    () => authorizeReleaseActor({
      env: env({ GITHUB_ACTOR_ID: '1' }),
      fetchImpl: () => { calls += 1; throw new Error('unreachable') },
    }),
    /release tags must be pushed by the authorized release actor/,
  )
  assert.equal(calls, 0, 'the guard must not reach the network for an unauthorized actor')
})

test('a repository id from the environment that is not the pin is refused before any request', async () => {
  let calls = 0
  await assert.rejects(
    () => authorizeReleaseActor({
      env: env({ GITHUB_REPOSITORY_ID: '1161268529' }),
      fetchImpl: () => { calls += 1; throw new Error('unreachable') },
    }),
    /GITHUB_REPOSITORY_ID is not the pinned release repository id/,
  )
  assert.equal(calls, 0)
})

test('a missing token is refused before any request', async () => {
  let calls = 0
  await assert.rejects(
    () => authorizeReleaseActor({
      env: env({ GH_TOKEN: '' }),
      fetchImpl: () => { calls += 1; throw new Error('unreachable') },
    }),
    /GH_TOKEN is required/,
  )
  assert.equal(calls, 0)
})

test('a malformed GITHUB_REPOSITORY is refused', async () => {
  for (const repository of [undefined, '', 'agent-passport-mcp', 'a/b/c', 'a b/c']) {
    await assert.rejects(
      () => authorizeReleaseActor({
        env: env({ GITHUB_REPOSITORY: repository }),
        fetchImpl: () => { throw new Error('unreachable') },
      }),
      /invalid GITHUB_REPOSITORY/,
      `expected ${JSON.stringify(repository)} to be refused`,
    )
  }
})

// A redirect is how the old address would answer after the transfer. Following
// it would authorize a run against whatever the redirect points at, so the
// lookup sets redirect: 'error' and the failure must surface as a refusal.
test('a lookup that throws, including on a redirect, fails closed with a bounded cause', async () => {
  await assert.rejects(
    () => authorizeReleaseActor({
      env: env(),
      fetchImpl: () => { throw new TypeError('unexpected redirect') },
    }),
    (error) => {
      assert.match(error.message, /release run attempt lookup failed \(TypeError: unexpected redirect\)/)
      return true
    },
  )
})

test('invalid JSON from the lookup is refused rather than parsed as empty', async () => {
  await assert.rejects(
    () => authorizeReleaseActor({
      env: env(),
      fetchImpl: async () => ({ status: 200, text: async () => 'not json' }),
    }),
    /returned invalid JSON/,
  )
})

test('the happy path asks for this run attempt and accepts the authorized requester', async () => {
  const seen = []
  const summary = await authorizeReleaseActor({
    env: env(),
    fetchImpl: async (url, options) => {
      seen.push({ url, redirect: options.redirect })
      return { status: 200, text: async () => JSON.stringify(attemptDocument()) }
    },
  })
  assert.equal(summary.triggeringActorId, AUTHORIZED_RELEASE_ACTOR_ID)
  assert.equal(seen.length, 1)
  assert.equal(
    seen[0].url,
    `https://api.github.com/repos/agent-passport-system/agent-passport-mcp/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`,
  )
  assert.equal(seen[0].redirect, 'error', 'the lookup must not follow a redirect')
})
