// Every registered tool must carry a title and explicit boolean MCP hints.
//
// WHY THIS TEST EXISTS. The Claude connectors directory and the OpenAI plugin
// directory both require a title and readOnlyHint / destructiveHint /
// openWorldHint set to explicit booleans on every tool. None of the 152 tools
// had them. The hints now come from one table, src/toolAnnotations.ts, attached
// by the registerTool wrapper in src/index.ts.
//
// The main assertion reads tools/list from the built server over stdio, which
// is what a client sees. Checking the source table alone would pass even if the
// wrapper stopped forwarding the annotations.
//
// Run: npm run build && node --test tests/tool-annotations.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { listToolsOverStdio } from '../scripts/lib/list-tools.mjs'
import { renderToolsBlock, spliceReadme, firstSentence } from '../scripts/generate-readme-tools.mjs'

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
const manifest = JSON.parse(readFileSync(new URL('../tools-manifest.json', import.meta.url), 'utf8'))

let wireToolsPromise
const wireTools = () => (wireToolsPromise ??= listToolsOverStdio())

test('tools/list returns every manifest tool, each with a title and four boolean hints', async () => {
  const tools = await wireTools()
  assert.deepEqual(
    tools.map((t) => t.name).sort(), [...manifest.tools].sort(),
    'tools/list names differ from tools-manifest.json',
  )
  const problems = []
  for (const t of tools) {
    if (typeof t.title !== 'string' || t.title.trim() === '') problems.push(`${t.name}: missing title`)
    const a = t.annotations
    if (!a || typeof a !== 'object') { problems.push(`${t.name}: missing annotations`); continue }
    if (typeof a.title !== 'string' || a.title.trim() === '') problems.push(`${t.name}: missing annotations.title`)
    for (const h of HINTS) {
      if (typeof a[h] !== 'boolean') problems.push(`${t.name}: ${h} is ${JSON.stringify(a[h])}, not a boolean`)
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('hints are internally consistent: read-only tools are never destructive and always idempotent', async () => {
  const tools = await wireTools()
  const bad = tools
    .filter((t) => t.annotations?.readOnlyHint === true)
    .filter((t) => t.annotations.destructiveHint !== false || t.annotations.idempotentHint !== true)
    .map((t) => t.name)
  assert.deepEqual(bad, [], `read-only tools with destructive or non-idempotent hints: ${bad.join(', ')}`)
})

test('the annotation table has exactly one entry per registered tool, no stale extras', async () => {
  const mod = await import('../build/index.js')
  mod.createSandboxServer()
  const registered = new Set(mod.REGISTERED_TOOL_NAMES)
  const table = Object.keys(mod.TOOL_ANNOTATIONS)
  const stale = table.filter((n) => !registered.has(n))
  const missing = [...registered].filter((n) => !(n in mod.TOOL_ANNOTATIONS))
  assert.deepEqual(stale, [], `annotation entries for tools that are not registered: ${stale.join(', ')}`)
  assert.deepEqual(missing, [], `registered tools without an annotation entry: ${missing.join(', ')}`)
})

test('known side-effecting tools keep their hints (guards against a careless table edit)', async () => {
  const byName = Object.fromEntries((await wireTools()).map((t) => [t.name, t.annotations]))
  for (const n of ['revoke_delegation', 'revoke_endorsement', 'supersede_v2_delegation', 'remove_intent_card', 'aps_capability_sign_effect']) {
    assert.equal(byName[n].destructiveHint, true, `${n} must be destructive`)
  }
  for (const n of ['search_matches', 'get_digest', 'request_intro', 'respond_to_intro', 'remove_intent_card', 'register_agora_public', 'issue_passport']) {
    assert.equal(byName[n].openWorldHint, true, `${n} contacts an external host`)
  }
  for (const n of ['create_task_brief', 'post_agora_message', 'send_message', 'check_messages', 'aps_capability_sign_effect']) {
    assert.equal(byName[n].readOnlyHint, false, `${n} writes local files`)
  }
})

test('tools that overwrite a stored record are destructive and not idempotent', async () => {
  const byName = Object.fromEntries((await wireTools()).map((t) => [t.name, t.annotations]))
  // complete_task replaces unit.completion (new signature and timestamp) in the task store.
  // create_derivation_receipt replaces the session receipt stored under the same derivativeId.
  for (const n of ['complete_task', 'create_derivation_receipt']) {
    assert.equal(byName[n].readOnlyHint, false, `${n} writes state`)
    assert.equal(byName[n].destructiveHint, true, `${n} overwrites an existing record`)
    assert.equal(byName[n].idempotentHint, false, `${n} produces a different record on each call`)
  }
  // register_agora_agent upserts by public key but stamps a fresh joinedAt each call.
  assert.equal(byName.register_agora_agent.idempotentHint, false, 'register_agora_agent replaces joinedAt on identical calls')
})

test('README summaries do not stop at abbreviations', () => {
  assert.equal(firstSentence('Detect drift (e.g. research to commercial). Second sentence.'), 'Detect drift (e.g. research to commercial).')
  assert.equal(firstSentence('Pick one, i.e. the first. Then more.'), 'Pick one, i.e. the first.')
  assert.equal(firstSentence('Plain sentence. Another.'), 'Plain sentence.')
})

test('README tool rows contain no em dash', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const rows = readme.split('\n').filter((l) => l.startsWith('| `'))
  assert.ok(rows.length >= manifest.tools.length, `expected a README row per tool, found ${rows.length}`)
  const bad = rows.filter((l) => l.includes('—'))
  assert.deepEqual(bad, [], `README tool rows with U+2014:\n${bad.join('\n')}`)
})

test('README tool tables match the running server', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const expected = spliceReadme(readme, await renderToolsBlock())
  assert.equal(readme, expected, 'README.md tool tables are stale. Run: node scripts/generate-readme-tools.mjs')
})
