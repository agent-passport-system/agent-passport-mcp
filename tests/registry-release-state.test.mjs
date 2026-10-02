// Behavioural tests for the MCP registry publication precondition.
//
// The registry authorizes an io.github.<owner> name against two things: the
// owner in the OIDC claim, and the mcpName baked into the published npm
// package the descriptor points at. The second half is the one this
// repository cannot satisfy by editing files. npm 6.1.0 was packed under
// io.github.aeoess/agent-passport-mcp, a published npm version is immutable,
// and renaming the server in server.json does not rename anything npm serves.
//
// Without this check, the first organization release would authenticate with
// the organization's identity and only then be refused by the registry, which
// is the wrong order to discover it in. These cases pin the refusals.
//
// Run: node --test tests/registry-release-state.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RegistryReleaseError,
  authorizeRegistryPublication,
  lookupPublishedNpmPackage,
  validateDescriptorConsistency,
  validatePublishedNpmPackage,
} from '../.github/scripts/registry-release-state.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const NPM_PACKAGE = 'agent-passport-system-mcp'
const VERSION = '9.9.9'
const MCP_NAME = 'io.github.agent-passport-system/agent-passport-mcp'
const OLD_MCP_NAME = 'io.github.aeoess/agent-passport-mcp'

const packageJson = (overrides = {}) => ({
  name: NPM_PACKAGE,
  version: VERSION,
  mcpName: MCP_NAME,
  ...overrides,
})

const descriptor = (overrides = {}) => ({
  name: MCP_NAME,
  version: VERSION,
  packages: [{ registryType: 'npm', identifier: NPM_PACKAGE, version: VERSION }],
  ...overrides,
})

const tree = (overrides = {}) => ({
  packageJson: packageJson(),
  serverJson: descriptor(),
  mcpServerJson: descriptor(),
  ...overrides,
})

const expected = { mcpName: MCP_NAME, version: VERSION, npmPackage: NPM_PACKAGE }

const npmDocument = (overrides = {}) => ({
  name: NPM_PACKAGE,
  version: VERSION,
  mcpName: MCP_NAME,
  ...overrides,
})

const refuses = (fn, pattern) => assert.throws(fn, (error) => {
  assert.ok(error instanceof RegistryReleaseError, `expected a refusal, got ${error}`)
  assert.match(error.message, pattern)
  return true
})

// --- descriptor consistency -------------------------------------------------

test('a consistent tree resolves to the name, version and package being claimed', () => {
  assert.deepEqual(validateDescriptorConsistency(tree()), expected)
})

test('server.json naming a different server than package.json mcpName is refused', () => {
  refuses(
    () => validateDescriptorConsistency(tree({ serverJson: descriptor({ name: OLD_MCP_NAME }) })),
    /server\.json name .* does not equal package\.json mcpName/,
  )
})

test('.mcp/server.json naming a different server is refused', () => {
  refuses(
    () => validateDescriptorConsistency(tree({ mcpServerJson: descriptor({ name: OLD_MCP_NAME }) })),
    /\.mcp\/server\.json name .* does not equal package\.json mcpName/,
  )
})

test('a descriptor version that is not the package version is refused', () => {
  refuses(
    () => validateDescriptorConsistency(tree({ serverJson: descriptor({ version: '6.1.0' }) })),
    /server\.json version 6\.1\.0 does not equal package\.json version/,
  )
})

test('a descriptor npm entry pinned to an older version than the package is refused', () => {
  const stale = descriptor({
    packages: [{ registryType: 'npm', identifier: NPM_PACKAGE, version: '6.1.0' }],
  })
  refuses(
    () => validateDescriptorConsistency(tree({ serverJson: stale })),
    /server\.json npm package version 6\.1\.0 does not equal package\.json version/,
  )
})

test('a descriptor npm entry naming a different package is refused', () => {
  const wrong = descriptor({
    packages: [{ registryType: 'npm', identifier: 'some-other-package', version: VERSION }],
  })
  refuses(
    () => validateDescriptorConsistency(tree({ mcpServerJson: wrong })),
    /npm package identifier some-other-package does not equal package\.json name/,
  )
})

test('two npm entries are refused rather than resolved by picking one', () => {
  const ambiguous = descriptor({
    packages: [
      { registryType: 'npm', identifier: NPM_PACKAGE, version: VERSION },
      { registryType: 'npm', identifier: NPM_PACKAGE, version: '6.1.0' },
    ],
  })
  refuses(
    () => validateDescriptorConsistency(tree({ serverJson: ambiguous })),
    /exactly one npm package entry, found 2/,
  )
})

test('no npm entry at all is refused', () => {
  const remoteOnly = descriptor({ packages: [{ registryType: 'oci', identifier: 'x', version: VERSION }] })
  refuses(
    () => validateDescriptorConsistency(tree({ serverJson: remoteOnly })),
    /exactly one npm package entry, found 0/,
  )
})

test('a missing packages array is refused', () => {
  const noPackages = { name: MCP_NAME, version: VERSION }
  refuses(
    () => validateDescriptorConsistency(tree({ serverJson: noPackages })),
    /server\.json has no packages array/,
  )
})

test('package.json without mcpName is refused', () => {
  const noName = packageJson()
  delete noName.mcpName
  refuses(
    () => validateDescriptorConsistency(tree({ packageJson: noName })),
    /package\.json mcpName is missing or not a string/,
  )
})

for (const [label, value] of [['null', null], ['an array', []], ['a string', 'server.json']]) {
  test(`a descriptor that is ${label} is refused`, () => {
    refuses(
      () => validateDescriptorConsistency(tree({ serverJson: value })),
      /server\.json is not a JSON object/,
    )
  })
}

// --- published npm metadata -------------------------------------------------

test('npm metadata carrying the claimed mcpName passes', () => {
  assert.deepEqual(validatePublishedNpmPackage(expected, { status: 200, document: npmDocument() }), expected)
})

// This is the live case the whole check exists for. 6.1.0 is published and
// carries the old name; nothing in the working tree can change that.
test('npm metadata carrying the old mcpName is refused with the new-version instruction', () => {
  refuses(
    () => validatePublishedNpmPackage(expected, {
      status: 200,
      document: npmDocument({ mcpName: OLD_MCP_NAME }),
    }),
    /carries mcpName io\.github\.aeoess\/agent-passport-mcp, not io\.github\.agent-passport-system\/agent-passport-mcp[\s\S]*Publish a new npm version/,
  )
})

test('npm metadata carrying no mcpName at all is refused', () => {
  const bare = npmDocument()
  delete bare.mcpName
  refuses(
    () => validatePublishedNpmPackage(expected, { status: 200, document: bare }),
    /carries no mcpName/,
  )
})

test('an empty mcpName is refused rather than read as a match', () => {
  refuses(
    () => validatePublishedNpmPackage(expected, { status: 200, document: npmDocument({ mcpName: '' }) }),
    /carries no mcpName/,
  )
})

test('a 404 is a refusal, not an absence that can be ignored', () => {
  refuses(
    () => validatePublishedNpmPackage(expected, { status: 404, document: undefined }),
    /returned HTTP 404; the published mcpName is not established/,
  )
})

test('a 500 is a refusal', () => {
  refuses(
    () => validatePublishedNpmPackage(expected, { status: 500, document: undefined }),
    /returned HTTP 500/,
  )
})

test('a non-object document is refused', () => {
  refuses(
    () => validatePublishedNpmPackage(expected, { status: 200, document: [npmDocument()] }),
    /non-object document/,
  )
})

test('metadata for a different package is refused', () => {
  refuses(
    () => validatePublishedNpmPackage(expected, { status: 200, document: npmDocument({ name: 'other' }) }),
    /names a different package/,
  )
})

test('metadata for a different version is refused', () => {
  refuses(
    () => validatePublishedNpmPackage(expected, { status: 200, document: npmDocument({ version: '6.1.0' }) }),
    /names a different version/,
  )
})

// --- lookup behaviour -------------------------------------------------------

test('the lookup asks npm for the exact package and version, and refuses redirects', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { status: 200, text: async () => JSON.stringify(npmDocument()) }
  }
  const result = await lookupPublishedNpmPackage({ npmPackage: NPM_PACKAGE, version: VERSION, fetchImpl })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://registry.npmjs.org/${NPM_PACKAGE}/${VERSION}`)
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(result.status, 200)
})

test('a 404 is retried, because a freshly published version can lag the CDN', async () => {
  let attempts = 0
  const fetchImpl = async () => {
    attempts += 1
    if (attempts < 3) return { status: 404, text: async () => '' }
    return { status: 200, text: async () => JSON.stringify(npmDocument()) }
  }
  const slept = []
  const result = await lookupPublishedNpmPackage({
    npmPackage: NPM_PACKAGE,
    version: VERSION,
    fetchImpl,
    sleep: async (ms) => { slept.push(ms) },
  })
  assert.equal(attempts, 3)
  assert.deepEqual(slept, [15_000, 15_000])
  assert.equal(result.status, 200)
})

test('exhausting the retries is a refusal, not a pass', async () => {
  const fetchImpl = async () => ({ status: 404, text: async () => '' })
  const result = await lookupPublishedNpmPackage({
    npmPackage: NPM_PACKAGE,
    version: VERSION,
    fetchImpl,
    sleep: async () => {},
  })
  assert.equal(result.status, 404)
  refuses(() => validatePublishedNpmPackage(expected, result), /returned HTTP 404/)
})

test('a 403 is an answer and is not retried', async () => {
  let attempts = 0
  const fetchImpl = async () => {
    attempts += 1
    return { status: 403, text: async () => '' }
  }
  const result = await lookupPublishedNpmPackage({
    npmPackage: NPM_PACKAGE,
    version: VERSION,
    fetchImpl,
    sleep: async () => {},
  })
  assert.equal(attempts, 1)
  assert.equal(result.status, 403)
})

test('a transport failure is a bounded refusal, not a stack trace', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(
    () => lookupPublishedNpmPackage({ npmPackage: NPM_PACKAGE, version: VERSION, fetchImpl }),
    (error) => {
      assert.ok(error instanceof RegistryReleaseError)
      assert.match(error.message, /npm metadata lookup failed \(TypeError: fetch failed\)/)
      return true
    },
  )
})

test('invalid JSON from npm is a refusal', async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => 'not json' })
  await assert.rejects(
    () => lookupPublishedNpmPackage({ npmPackage: NPM_PACKAGE, version: VERSION, fetchImpl }),
    /invalid JSON/,
  )
})

// --- the two halves together ------------------------------------------------

test('an inconsistent tree is refused before npm is contacted at all', async () => {
  let called = false
  const fetchImpl = async () => { called = true; return { status: 200, text: async () => '{}' } }
  const readJson = (relative) => ({
    'package.json': packageJson(),
    'server.json': descriptor({ name: OLD_MCP_NAME }),
    '.mcp/server.json': descriptor(),
  })[relative]

  await assert.rejects(
    () => authorizeRegistryPublication({ readJson, fetchImpl }),
    /does not equal package\.json mcpName/,
  )
  assert.equal(called, false, 'npm was contacted despite an inconsistent tree')
})

test('a consistent tree backed by matching npm metadata authorizes publication', async () => {
  const readJson = (relative) => ({
    'package.json': packageJson(),
    'server.json': descriptor(),
    '.mcp/server.json': descriptor(),
  })[relative]
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify(npmDocument()) })
  assert.deepEqual(await authorizeRegistryPublication({ readJson, fetchImpl }), expected)
})

// --- what the repository actually declares right now ------------------------

test('the descriptors in this tree agree with each other', () => {
  const read = (relative) => JSON.parse(readFileSync(join(ROOT, relative), 'utf8'))
  const resolved = validateDescriptorConsistency({
    packageJson: read('package.json'),
    serverJson: read('server.json'),
    mcpServerJson: read('.mcp/server.json'),
  })
  assert.equal(resolved.npmPackage, NPM_PACKAGE)
  assert.equal(resolved.mcpName, MCP_NAME)
})

// The descriptors agreeing with each other is not the same as the registry
// accepting them. This pins the gap that is still open: the version the
// descriptors name is one npm already published under the old mcpName, so
// publication is refused until a new npm version carries the new name.
test('the version this tree names is one npm published under the old mcpName', async () => {
  const read = (relative) => JSON.parse(readFileSync(join(ROOT, relative), 'utf8'))
  const local = validateDescriptorConsistency({
    packageJson: read('package.json'),
    serverJson: read('server.json'),
    mcpServerJson: read('.mcp/server.json'),
  })

  // The published metadata for 6.1.0, read once from npm on 2026-10-02 and
  // frozen here. A published version is immutable, so this cannot drift.
  const published = {
    name: 'agent-passport-system-mcp',
    version: '6.1.0',
    mcpName: 'io.github.aeoess/agent-passport-mcp',
  }
  if (local.version !== published.version) return // a new version was cut; the gap is closed

  refuses(
    () => validatePublishedNpmPackage(local, { status: 200, document: published }),
    /Publish a new npm version packed with the new mcpName/,
  )
})
