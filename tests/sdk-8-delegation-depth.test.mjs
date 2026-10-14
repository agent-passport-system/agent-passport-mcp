// Regression: the MCP runs on agent-passport-system 8.x and its create_delegation input
// matches what that SDK will sign.
//
// SDK 8.0.0 refuses to sign a delegation whose maxDepth is not a non-negative integer
// (createDelegation throws), and verifyDelegation reports such a signed record invalid instead
// of coercing it. Before this change create_delegation accepted any number for max_depth, so
// -1 or 1.5 reached the SDK and came back as a thrown error. The tool schema now rejects those
// values up front.
//
// Run: node --test tests/sdk-8-delegation-depth.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDelegation, generateKeyPair, verifyDelegation } from 'agent-passport-system'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const SDK_PKG = JSON.parse(
  readFileSync(new URL('../node_modules/agent-passport-system/package.json', import.meta.url), 'utf8'),
)
const INDEX_SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

function delegationInput(maxDepth) {
  const from = generateKeyPair()
  const to = generateKeyPair()
  return {
    input: {
      delegatedBy: from.publicKey,
      delegatedTo: to.publicKey,
      scope: ['web_search'],
      spendLimit: 10,
      maxDepth,
      expiresInHours: 1,
      privateKey: from.privateKey,
    },
  }
}

test('the declared and resolved SDK are on the 8.x line', () => {
  assert.match(PKG.dependencies['agent-passport-system'], /^\^8\./)
  assert.equal(SDK_PKG.version.split('.')[0], '8')
})

test('the SDK signs and verifies a non-negative integer maxDepth', () => {
  const d = createDelegation(delegationInput(1).input)
  assert.equal(d.maxDepth, 1)
  assert.equal(verifyDelegation(d).valid, true)
})

test('the SDK refuses to sign a negative or fractional maxDepth', () => {
  assert.throws(() => createDelegation(delegationInput(-1).input))
  assert.throws(() => createDelegation(delegationInput(1.5).input))
})

test('create_delegation rejects those values in its input schema', () => {
  const start = INDEX_SRC.indexOf('server.registerTool("create_delegation"')
  assert.ok(start >= 0, 'create_delegation must be registered')
  const schema = INDEX_SRC.slice(start, INDEX_SRC.indexOf('async (args)', start))
  assert.match(schema, /max_depth: z\.number\(\)\.int\(\)\.min\(0\)/)
})
