// Placement tests for the release guards.
//
// tests/release-actor-state.test.mjs proves the guard refuses the right
// things. It does not prove the guard runs. Deleting the "Require the
// authorized release actor" step from release.yml leaves that file's twenty
// cases passing, because none of them reads a workflow. A guard nobody calls
// is the same as no guard, and it is worse at the audit, because the script is
// still in the tree and still reviewed.
//
// So these tests assert placement instead of logic. The rule they enforce:
// every job that has a protected effect must run the release actor guard, and
// must run it before its first protected effect. Protected means an effect
// that leaves this repository and cannot be taken back. Publishing to npm,
// publishing to the MCP registry, creating a GitHub release, signing a
// provenance attestation.
//
// Placement alone was not enough either. The first version of this file looked
// for the guard script's filename in the step's text and compared step indices,
// and a step can keep the filename while enforcing nothing: `if: false`,
// `continue-on-error: true`, `run: echo node .github/scripts/...`, `|| true`.
// All four passed. So each gate now has to run its actual command, with nothing
// that can skip it and nothing that can discard its exit status.
//
// The rule is applied to every workflow file, not to a list of known ones, so
// a new workflow that publishes is covered the day it is added.
//
// Run: node --test tests/release-workflow-placement.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  commandsIn,
  parseWorkflow,
  runCommandOf,
  stepFields,
  stepMatches,
} from './helpers/workflow-steps.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows')

// The release workflow is the one every protected effect is expected to live
// in. Named explicitly so that deleting a publishing step cannot make the
// placement rule pass by having nothing left to guard.
const RELEASE_WORKFLOW = 'release.yml'
const REGISTRY_WORKFLOW = 'mcp-registry-publish.yml'

const GUARD = /release-actor-state\.mjs(?![\w.-])/
const REGISTRY_PRECONDITION = /registry-release-state\.mjs(?![\w.-])/

// --- the gates, and what makes one enforced ---------------------------------
//
// Finding the script's filename in a step proves the filename is there. It does
// not prove the step runs the script, or that the job stops when the script
// refuses. Four ways to keep the filename and lose the gate, all of which the
// first version of this suite accepted: `if: false` skips the step,
// `continue-on-error: true` lets the job continue past it, replacing the command
// with `echo` runs nothing, and `|| true` discards the exit status. So each gate
// carries the command it must actually run, and that command is required
// exactly.
//
// `if:` is rejected outright rather than analysed. A condition that only repeats
// the job's own trigger would be harmless, but telling that apart from one that
// can be false at release time means evaluating GitHub expressions, which is a
// much larger thing than this reader is. None of these steps has an `if:`, so
// requiring none costs nothing and leaves no expression to interpret.
const GATES = [
  {
    id: 'release actor guard',
    pattern: GUARD,
    command: 'node .github/scripts/release-actor-state.mjs',
  },
  {
    id: 'registry descriptor precondition',
    pattern: REGISTRY_PRECONDITION,
    command: 'node .github/scripts/registry-release-state.mjs',
  },
]

// Shapes that turn a failing command into a passing step. Not a shell parser:
// a fixed list of the ways a one-line gate invocation gets its exit status
// thrown away.
const FAILURE_SWALLOWED = [
  { id: 'an || fallback', pattern: /\|\|/ },
  { id: 'set +e', pattern: /(?:^|[\s;&|])set\s+\+[A-Za-z]*e/m },
  { id: 'a trailing true', pattern: /(?:^|[;&\n])\s*(?:true|:)\s*$/m },
  { id: 'exit 0', pattern: /(?:^|[;&|\n])\s*exit\s+0\b/ },
]

export function gateStepViolations(where, job, gate, step) {
  const violations = []
  const label = `${where} runs the ${gate.id} at step ${step.index + 1} (line ${step.startLine}) but it`
  const fields = stepFields(step.text)

  if (fields.has('if')) {
    violations.push(`${label} carries an if: condition, so the gate can be skipped`)
  }

  const stepSkip = fields.get('continue-on-error')
  if (stepSkip && stepSkip.inline !== 'false') {
    violations.push(
      `${label} sets continue-on-error: ${stepSkip.inline}, `
      + 'so its failure does not stop the job',
    )
  }
  if (job.continueOnError !== null && job.continueOnError !== 'false') {
    violations.push(
      `${label} sits in a job with continue-on-error: ${job.continueOnError}, `
      + 'so its failure does not stop the job',
    )
  }

  const run = runCommandOf(step.text)
  if (run === null) {
    violations.push(`${label} has no run command, so it cannot invoke ${gate.command}`)
    return violations
  }

  const swallowed = FAILURE_SWALLOWED.find((shape) => shape.pattern.test(run))
  const commands = commandsIn(run)
  if (swallowed) {
    violations.push(`${label} discards the gate's exit status with ${swallowed.id}`)
  } else if (commands.length !== 1 || commands[0] !== gate.command) {
    violations.push(
      `${label} does not invoke ${gate.command}, it runs: ${commands.join(' ; ') || '(nothing)'}`,
    )
  }

  return violations
}

// Every gate step in every workflow, wherever it appears. The placement rule
// below only reaches the gates a publishing job is required to carry; this
// reaches the ones in jobs that have no protected effect of their own, where a
// neutralized gate would otherwise go unread.
export function gateEnforcementViolations(workflows) {
  const violations = []
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const where = `${workflow.path} job ${job.name}`
      for (const gate of GATES) {
        for (const step of job.steps) {
          if (!stepMatches(step.text, gate.pattern)) continue
          violations.push(...gateStepViolations(where, job, gate, step))
        }
      }
    }
  }
  return violations
}

// Each pattern is matched against the step's whole text with comment lines
// removed, not just against `run`. A protected effect moved into a composite
// action input or a different key is still a protected effect.
const PROTECTED_EFFECTS = [
  { id: 'npm publish', pattern: /(?:^|[\s;&|(])npm\s+publish(?![\w-])/m },
  { id: 'MCP registry login', pattern: /(?:^|[\s;&|(./])mcp-publisher\s+login(?![\w-])/m },
  { id: 'MCP registry publish', pattern: /(?:^|[\s;&|(./])mcp-publisher\s+publish(?![\w-])/m },
  { id: 'GitHub release creation', pattern: /(?:^|[\s;&|(])gh\s+release\s+create(?![\w-])/m },
  { id: 'build provenance attestation', pattern: /uses:\s*actions\/attest-[\w-]+@/ },
]

function protectedEffectsIn(step) {
  return PROTECTED_EFFECTS.filter((effect) => stepMatches(step.text, effect.pattern))
}

function firstStepMatching(job, pattern) {
  return job.steps.find((step) => stepMatches(step.text, pattern))
}

// The rule, as a function over parsed workflows, so the same code can be run
// against the real files and against deliberately broken ones.
export function guardPlacementViolations(workflows) {
  const violations = []

  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const protectedSteps = job.steps
        .map((step) => ({ step, effects: protectedEffectsIn(step) }))
        .filter((entry) => entry.effects.length > 0)
      if (protectedSteps.length === 0) continue

      const where = `${workflow.path} job ${job.name}`
      const first = protectedSteps[0]
      const effectNames = first.effects.map((effect) => effect.id).join(', ')
      const guard = firstStepMatching(job, GUARD)

      if (!guard) {
        violations.push(
          `${where} performs ${effectNames} at step ${first.step.index + 1} `
          + '(line ' + first.step.startLine + ') and never runs the release actor guard',
        )
        continue
      }
      if (guard.index > first.step.index) {
        violations.push(
          `${where} runs the release actor guard at step ${guard.index + 1} `
          + `(line ${guard.startLine}), after ${effectNames} at step ${first.step.index + 1} `
          + `(line ${first.step.startLine})`,
        )
      }

      // Present and early is not the same as enforced. A guard that is skipped,
      // that the job continues past, that runs something other than the script,
      // or whose exit status is discarded leaves the protected steps below it
      // ungated, so the job counts as unguarded here too.
      violations.push(...gateStepViolations(where, job, GATES[0], guard))

      // The guard reads this run's attempt through the Actions API, so a job
      // that calls it without `actions: read` fails closed at release time
      // rather than at review time. Catch it here instead.
      if (!/^\s+actions:\s*read\b/m.test(job.text)) {
        violations.push(`${where} runs the release actor guard without declaring actions: read`)
      }

      // Registry publication is authorized against the published npm package's
      // mcpName, which no local edit can change. The precondition check is what
      // refuses a descriptor the registry would reject after the OIDC login has
      // already been spent, so it has to run before the login, not after it.
      const registryStep = protectedSteps.find(
        (entry) => entry.effects.some((effect) => effect.id.startsWith('MCP registry')),
      )
      if (registryStep) {
        const precondition = firstStepMatching(job, REGISTRY_PRECONDITION)
        if (!precondition) {
          violations.push(
            `${where} reaches the MCP registry without the descriptor precondition check`,
          )
        } else if (precondition.index > registryStep.step.index) {
          violations.push(
            `${where} runs the descriptor precondition check at step ${precondition.index + 1}, `
            + `after reaching the MCP registry at step ${registryStep.step.index + 1}`,
          )
        } else {
          violations.push(...gateStepViolations(where, job, GATES[1], precondition))
        }
      }
    }
  }

  return violations
}

function readWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => parseWorkflow(readFileSync(join(WORKFLOW_DIR, name), 'utf8'), { path: name }))
}

const parse = (text, path = 'synthetic.yml') => parseWorkflow(text, { path })

test('every publishing job in this repository runs the guard before its first protected effect', () => {
  assert.deepEqual(guardPlacementViolations(readWorkflows()), [])
})

test('every gate step in this repository runs its command and stops the job when it fails', () => {
  assert.deepEqual(gateEnforcementViolations(readWorkflows()), [])
})

test('the release workflow still contains the protected effects this rule exists to cover', () => {
  const release = readWorkflows().find((workflow) => workflow.path === RELEASE_WORKFLOW)
  assert.ok(release, `${RELEASE_WORKFLOW} is missing`)

  const found = new Set()
  for (const job of release.jobs) {
    for (const step of job.steps) {
      for (const effect of protectedEffectsIn(step)) found.add(effect.id)
    }
  }

  for (const effect of PROTECTED_EFFECTS) {
    assert.ok(found.has(effect.id), `${RELEASE_WORKFLOW} no longer performs ${effect.id}`)
  }
})

test('every job in the release workflow runs the guard, including ones with no protected step', () => {
  const release = readWorkflows().find((workflow) => workflow.path === RELEASE_WORKFLOW)
  assert.ok(release.jobs.length > 0)
  for (const job of release.jobs) {
    assert.ok(
      firstStepMatching(job, GUARD),
      `${RELEASE_WORKFLOW} job ${job.name} does not run the release actor guard`,
    )
  }
})

test('registry publication runs after npm publish, not before it', () => {
  const release = readWorkflows().find((workflow) => workflow.path === RELEASE_WORKFLOW)
  for (const job of release.jobs) {
    const npm = job.steps.find((step) => stepMatches(step.text, PROTECTED_EFFECTS[0].pattern))
    const registry = job.steps.find((step) => stepMatches(step.text, PROTECTED_EFFECTS[2].pattern))
    if (!registry) continue
    assert.ok(npm, `${RELEASE_WORKFLOW} job ${job.name} publishes to the registry without npm publish`)
    assert.ok(
      npm.index < registry.index,
      `${RELEASE_WORKFLOW} job ${job.name} reaches the registry at step ${registry.index + 1}, `
      + `before npm publish at step ${npm.index + 1}`,
    )
  }
})

test('the registry workflow is manual only, with no event that can start it unattended', () => {
  const registry = readWorkflows().find((workflow) => workflow.path === REGISTRY_WORKFLOW)
  if (!registry) return // removing the file entirely is also an acceptable close
  assert.deepEqual(registry.triggers, ['workflow_dispatch'])
})

// The three cases below are the rule biting. They are synthetic rather than
// mutations of the real file so that the proof lives in the suite and does not
// depend on anyone remembering to run a mutation by hand.

const PUBLISHING_JOB = `
name: Example
on:
  push:
    tags: ['v*.*.*']
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v7
      - name: Require the authorized release actor
        run: node .github/scripts/release-actor-state.mjs
      - name: Publish to npm
        run: npm publish "./$TARBALL" --provenance --access public
`

test('the rule passes a job that guards before publishing', () => {
  assert.deepEqual(guardPlacementViolations([parse(PUBLISHING_JOB)]), [])
})

test('the rule fails when the guard step is removed', () => {
  const mutated = PUBLISHING_JOB.replace(
    `      - name: Require the authorized release actor\n`
    + `        run: node .github/scripts/release-actor-state.mjs\n`,
    '',
  )
  assert.notEqual(mutated, PUBLISHING_JOB, 'mutation did not apply')
  const violations = guardPlacementViolations([parse(mutated)])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /never runs the release actor guard/)
})

test('the rule fails when the guard runs after the publish step', () => {
  const mutated = `
name: Example
on:
  push:
    tags: ['v*.*.*']
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v7
      - name: Publish to npm
        run: npm publish "./$TARBALL" --provenance --access public
      - name: Require the authorized release actor
        run: node .github/scripts/release-actor-state.mjs
`
  const violations = guardPlacementViolations([parse(mutated)])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /after npm publish at step 2/)
})

test('the rule fails when the guarded job cannot read the run attempt', () => {
  const mutated = PUBLISHING_JOB.replace('      actions: read\n', '')
  assert.notEqual(mutated, PUBLISHING_JOB, 'mutation did not apply')
  const violations = guardPlacementViolations([parse(mutated)])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /without declaring actions: read/)
})

test('the rule fails when registry publication skips the descriptor precondition', () => {
  const mutated = `
name: Example
on:
  workflow_dispatch:
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      actions: read
    steps:
      - name: Require the authorized release actor
        run: node .github/scripts/release-actor-state.mjs
      - name: Authenticate
        run: ./mcp-publisher login github-oidc
      - name: Publish
        run: ./mcp-publisher publish .mcp/server.json
`
  const violations = guardPlacementViolations([parse(mutated)])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /without the descriptor precondition check/)
})

// A job whose protected effect is registry publication, so the descriptor
// precondition is a required gate in it and can be neutralized the same four
// ways the actor guard can.
const REGISTRY_JOB = `
name: Example
on:
  workflow_dispatch:
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v7
      - name: Require the authorized release actor
        run: node .github/scripts/release-actor-state.mjs
      - name: Require the registry descriptors to match the published npm version
        run: node .github/scripts/registry-release-state.mjs
      - name: Authenticate
        run: ./mcp-publisher login github-oidc
      - name: Publish
        run: ./mcp-publisher publish .mcp/server.json
`

const GATE_TARGETS = [
  {
    id: 'the release actor guard',
    workflow: PUBLISHING_JOB,
    nameLine: '      - name: Require the authorized release actor',
    runLine: '        run: node .github/scripts/release-actor-state.mjs',
  },
  {
    id: 'the registry descriptor precondition',
    workflow: REGISTRY_JOB,
    nameLine: '      - name: Require the registry descriptors to match the published npm version',
    runLine: '        run: node .github/scripts/registry-release-state.mjs',
  },
]

// The gate is left in place in every one of these. The filename is still there,
// the step is still first, and the step still refuses when it runs. Each
// mutation takes away one of those words.
const NEUTRALIZERS = [
  {
    id: 'a condition that can skip it',
    mutate: (text, gate) => text.replace(`${gate.nameLine}\n`, `${gate.nameLine}\n        if: false\n`),
    expect: /carries an if: condition/,
  },
  {
    id: 'continue-on-error on the step',
    mutate: (text, gate) => text.replace(
      `${gate.nameLine}\n`,
      `${gate.nameLine}\n        continue-on-error: true\n`,
    ),
    expect: /sets continue-on-error: true/,
  },
  {
    id: 'continue-on-error on the job',
    mutate: (text) => text.replace(
      '    runs-on: ubuntu-latest\n',
      '    runs-on: ubuntu-latest\n    continue-on-error: true\n',
    ),
    expect: /job with continue-on-error: true/,
  },
  {
    id: 'an echo in place of the command',
    mutate: (text, gate) => text.replace(gate.runLine, gate.runLine.replace('run: ', 'run: echo ')),
    expect: /does not invoke/,
  },
  {
    id: '|| true appended to the command',
    mutate: (text, gate) => text.replace(gate.runLine, `${gate.runLine} || true`),
    expect: /discards the gate's exit status with an \|\| fallback/,
  },
]

for (const gate of GATE_TARGETS) {
  test(`the rule passes a job whose gate is ${gate.id} as written`, () => {
    assert.deepEqual(guardPlacementViolations([parse(gate.workflow)]), [])
    assert.deepEqual(gateEnforcementViolations([parse(gate.workflow)]), [])
  })

  for (const neutralizer of NEUTRALIZERS) {
    const title = `the rule fails when ${gate.id} keeps its filename `
      + `but is neutralized by ${neutralizer.id}`
    test(title, () => {
      const mutated = neutralizer.mutate(gate.workflow, gate)
      assert.notEqual(mutated, gate.workflow, 'mutation did not apply')

      // The filename is the only thing the previous version of this rule
      // looked for, so the mutation has to leave it in place to be the case
      // worth testing.
      const workflow = parse(mutated)
      const pattern = gate.workflow === PUBLISHING_JOB ? GUARD : REGISTRY_PRECONDITION
      assert.ok(
        workflow.jobs[0].steps.some((step) => stepMatches(step.text, pattern)),
        'mutation removed the gate instead of neutralizing it',
      )

      for (const [rule, violations] of [
        ['placement', guardPlacementViolations([workflow])],
        ['enforcement', gateEnforcementViolations([workflow])],
      ]) {
        assert.ok(
          violations.some((violation) => neutralizer.expect.test(violation)),
          `the ${rule} rule did not catch ${neutralizer.id}: ${JSON.stringify(violations)}`,
        )
      }
    })
  }
}

test('a job with no protected effect is not required to carry the guard', () => {
  const benign = `
name: Tests
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Test
        run: npm test
`
  assert.deepEqual(guardPlacementViolations([parse(benign)]), [])
})

// Prose about a protected effect is not a protected effect. Without this the
// rule would fire on the "Pack tarball" step, whose comment explains why
// letting npm publish pack a second time would attest one tarball and ship
// another.
test('a comment naming a protected effect does not make a step protected', () => {
  const commented = `
name: Example
on:
  push:
jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - name: Pack tarball
        # Letting \`npm publish\` pack a second time would attest one tarball
        # and ship another.
        run: npm pack
`
  assert.deepEqual(guardPlacementViolations([parse(commented)]), [])
})

// Reader tests. A reader that quietly finds no steps would make every rule
// above pass vacuously, so what it reads out of the real files is pinned.
test('the reader finds the jobs and steps the real workflows declare', () => {
  const workflows = readWorkflows()
  const byPath = Object.fromEntries(workflows.map((workflow) => [workflow.path, workflow]))

  assert.deepEqual(Object.keys(byPath).sort(), [
    'check-drift.yml',
    'contributor-check.yml',
    'mcp-registry-publish.yml',
    'release.yml',
  ])
  assert.deepEqual(byPath['release.yml'].jobs.map((job) => job.name), ['release'])
  assert.ok(byPath['release.yml'].jobs[0].steps.length >= 15)
  assert.deepEqual(byPath['mcp-registry-publish.yml'].jobs.map((job) => job.name), ['publish'])
  assert.ok(byPath['mcp-registry-publish.yml'].jobs[0].steps.length >= 6)
})

test('the reader does not split a step on sequence-looking lines inside a run block', () => {
  const tricky = `
name: Example
on:
  push:
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - name: Scan
        run: |
          cat <<'LIST'
          - not a step
          - also not a step
          LIST
      - name: Second
        run: echo done
`
  const [job] = parse(tricky).jobs
  assert.equal(job.steps.length, 2)
  assert.match(job.steps[1].text, /name: Second/)
})
