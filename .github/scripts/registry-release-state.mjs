#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The MCP registry authorizes a server name against two things: the GitHub
// owner in the OIDC claim, and the npm package the descriptor points at. The
// second half is the one a local edit cannot satisfy. Registry ownership
// validation for an npm package reads the published package metadata and
// requires its `mcpName` field to equal the server name being claimed. That
// field is baked into the tarball at publish time and a published npm version
// is immutable, so renaming the server in server.json does not rename anything
// npm already serves.
//
// Concretely: npm agent-passport-system-mcp 6.1.0 carries
// io.github.aeoess/agent-passport-mcp. Pointing the descriptors at
// io.github.agent-passport-system/agent-passport-mcp while still naming 6.1.0
// produces a descriptor the registry will reject, and it would reject it after
// the OIDC login, which is the step that spends the organization's identity.
// The first publication under the new name needs a NEW npm version whose
// package.json carried the new mcpName when it was packed.
//
// This guard refuses registry publication unless all of that already holds. It
// is a precondition check, not a cleanup: every unestablished state raises.
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';

const BOUNDED_ERROR_LENGTH = 120;
const TIMEOUT_MS = 15_000;

// npm serves a freshly published version through a CDN, so the version
// document can lag the publish by a few minutes. On the 6.1.1 release npm
// reported the package as still processing and the version document returned
// 404 for longer than the earlier four attempts covered. A 404 immediately after a
// successful publish is far more likely to be propagation than a real absence,
// so the lookup is retried a bounded number of times. It still fails closed:
// exhausting the attempts is a refusal, not a pass.
export const LOOKUP_ATTEMPTS = 12;
export const LOOKUP_RETRY_MS = 15_000;

export class RegistryReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryReleaseError';
  }
}

function boundedCause(error) {
  const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error?.message === 'string' ? error.message : '';
  return message ? `${name}: ${message.slice(0, BOUNDED_ERROR_LENGTH)}` : name;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RegistryReleaseError(`${label} is missing or not a string`);
  }
  return value;
}

// One npm package entry, naming this package at this version. More than one npm
// entry is ambiguous about what is being claimed, so it is refused rather than
// resolved by picking the first.
function readNpmPackageEntry(descriptor, label) {
  const { packages } = descriptor;
  if (!Array.isArray(packages)) {
    throw new RegistryReleaseError(`${label} has no packages array`);
  }
  const npmEntries = packages.filter(
    (entry) => isPlainObject(entry) && entry.registryType === 'npm',
  );
  if (npmEntries.length !== 1) {
    throw new RegistryReleaseError(
      `${label} must declare exactly one npm package entry, found ${npmEntries.length}`,
    );
  }
  const [entry] = npmEntries;
  return {
    identifier: requireString(entry.identifier, `${label} npm package identifier`),
    version: requireString(entry.version, `${label} npm package version`),
  };
}

export function validateDescriptorConsistency({ packageJson, serverJson, mcpServerJson }) {
  for (const [label, document] of [
    ['package.json', packageJson],
    ['server.json', serverJson],
    ['.mcp/server.json', mcpServerJson],
  ]) {
    if (!isPlainObject(document)) {
      throw new RegistryReleaseError(`${label} is not a JSON object`);
    }
  }

  const npmPackage = requireString(packageJson.name, 'package.json name');
  const version = requireString(packageJson.version, 'package.json version');
  const mcpName = requireString(packageJson.mcpName, 'package.json mcpName');

  for (const [label, descriptor] of [
    ['server.json', serverJson],
    ['.mcp/server.json', mcpServerJson],
  ]) {
    if (requireString(descriptor.name, `${label} name`) !== mcpName) {
      throw new RegistryReleaseError(
        `${label} name ${descriptor.name} does not equal package.json mcpName ${mcpName}`,
      );
    }
    if (requireString(descriptor.version, `${label} version`) !== version) {
      throw new RegistryReleaseError(
        `${label} version ${descriptor.version} does not equal package.json version ${version}`,
      );
    }
    const entry = readNpmPackageEntry(descriptor, label);
    if (entry.identifier !== npmPackage) {
      throw new RegistryReleaseError(
        `${label} npm package identifier ${entry.identifier} does not equal package.json name ${npmPackage}`,
      );
    }
    if (entry.version !== version) {
      throw new RegistryReleaseError(
        `${label} npm package version ${entry.version} does not equal package.json version ${version}`,
      );
    }
  }

  return { mcpName, version, npmPackage };
}

// The published npm metadata is the half of the claim that lives outside this
// repository. Nothing in the working tree can make this pass for a version that
// was packed under a different mcpName.
export function validatePublishedNpmPackage(expected, { status, document }) {
  const { mcpName, version, npmPackage } = expected;

  if (status !== 200) {
    throw new RegistryReleaseError(
      `npm metadata lookup for ${npmPackage}@${version} returned HTTP ${status}; `
      + 'the published mcpName is not established',
    );
  }
  if (!isPlainObject(document)) {
    throw new RegistryReleaseError('npm metadata lookup returned a non-object document');
  }
  if (document.name !== npmPackage) {
    throw new RegistryReleaseError('npm metadata names a different package');
  }
  if (document.version !== version) {
    throw new RegistryReleaseError('npm metadata names a different version');
  }
  if (typeof document.mcpName !== 'string' || document.mcpName.length === 0) {
    throw new RegistryReleaseError(
      `npm ${npmPackage}@${version} carries no mcpName, so the registry cannot validate `
      + `ownership of ${mcpName}. Publish a new npm version whose package.json sets mcpName.`,
    );
  }
  if (document.mcpName !== mcpName) {
    throw new RegistryReleaseError(
      `npm ${npmPackage}@${version} carries mcpName ${document.mcpName}, not ${mcpName}. `
      + 'A published npm version is immutable, so this cannot be corrected by editing the '
      + 'descriptors. Publish a new npm version packed with the new mcpName and point '
      + 'server.json and .mcp/server.json at that version.',
    );
  }

  return { mcpName, version, npmPackage };
}

export async function lookupPublishedNpmPackage({
  npmPackage,
  version,
  fetchImpl = fetch,
  attempts = LOOKUP_ATTEMPTS,
  retryMs = LOOKUP_RETRY_MS,
  sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }),
} = {}) {
  const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(npmPackage)}/${encodeURIComponent(version)}`;
  let last = { status: 0, document: undefined };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'agent-passport-mcp-registry-guard',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new RegistryReleaseError(`npm metadata lookup failed (${boundedCause(error)})`);
    }

    const status = response?.status;
    if (status === 200) {
      let text;
      try {
        text = await response.text();
      } catch (error) {
        throw new RegistryReleaseError(`npm metadata lookup failed (${boundedCause(error)})`);
      }
      let document;
      try {
        document = JSON.parse(text);
      } catch {
        throw new RegistryReleaseError('npm metadata lookup returned invalid JSON');
      }
      return { status, document };
    }

    last = { status, document: undefined };
    // Only absence and server-side faults are treated as propagation. A 401,
    // 403 or 451 is an answer, and retrying it just spends time before the
    // same refusal.
    const retryable = status === 404 || (Number.isInteger(status) && status >= 500);
    if (!retryable || attempt === attempts) break;
    await sleep(retryMs);
  }

  return last;
}

export async function authorizeRegistryPublication({
  root,
  readJson,
  fetchImpl = fetch,
  attempts = LOOKUP_ATTEMPTS,
  retryMs = LOOKUP_RETRY_MS,
  sleep,
} = {}) {
  const read = readJson ?? ((relative) => JSON.parse(readFileSync(resolve(root, relative), 'utf8')));

  const expected = validateDescriptorConsistency({
    packageJson: read('package.json'),
    serverJson: read('server.json'),
    mcpServerJson: read('.mcp/server.json'),
  });

  const response = await lookupPublishedNpmPackage({
    npmPackage: expected.npmPackage,
    version: expected.version,
    fetchImpl,
    attempts,
    retryMs,
    ...(sleep ? { sleep } : {}),
  });

  return validatePublishedNpmPackage(expected, response);
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const summary = await authorizeRegistryPublication({ root: resolve(here, '..', '..') });
  console.log(
    `registry publication precondition: npm ${summary.npmPackage}@${summary.version} carries `
    + `mcpName ${summary.mcpName}, and server.json and .mcp/server.json agree with it`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
