import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostDescriptor } from '../../src/quota-guard/compatibility.ts';
import {
  checkHostCompatibility,
  compatibilityRefusal,
  GUARDED_APIS,
  REQUIRED_APIS,
} from '../../src/quota-guard/compatibility.ts';

/** A descriptor that satisfies every observable seam, so each test can break exactly one thing. */
const compatible = (overrides: Partial<HostDescriptor> = {}): HostDescriptor => ({
  hasStream: true,
  hasStreamSimple: true,
  hasGetAuth: true,
  apiIds: [...REQUIRED_APIS],
  hostPackage: { name: '@earendil-works/pi-coding-agent', version: '1.1.0' },
  ...overrides,
});

test('a host with every seam present is compatible and reports its build', () => {
  const verdict = checkHostCompatibility(compatible());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.hostIdentity, '@earendil-works/pi-coding-agent@1.1.0');
});

test('a missing public stream() fails closed on its own line', () => {
  const verdict = checkHostCompatibility(compatible({ hasStream: false }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0], /stream\(\)/);
});

test('a missing public streamSimple() fails closed on its own line', () => {
  const verdict = checkHostCompatibility(compatible({ hasStreamSimple: false }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0], /streamSimple\(\)/);
});

test('a missing public getAuth() is reported as unverified, not as a passed check', () => {
  const verdict = checkHostCompatibility(compatible({ hasGetAuth: false }));
  assert.equal(verdict.ok, true, 'identity resolves from the instance, so this alone does not fail');
  assert.equal(verdict.failures.length, 0);
  assert.equal(verdict.unverified.length, 1);
  assert.match(verdict.unverified[0], /getAuth/);
});

test('a familiar version string is not proof: a lost seam still fails', () => {
  // The point of the boundary: a build claiming the version we tested against, but missing a seam,
  // must be refused rather than trusted.
  const verdict = checkHostCompatibility(compatible({ hasStream: false }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.hostIdentity, /1\.1\.0$/);
  assert.equal(verdict.failures.length, 1);
});

test('every required api must still exist, and the failure names the api', () => {
  const verdict = checkHostCompatibility(compatible({ apiIds: ['openai-completions', 'anthropic-messages'] }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0], /openai-codex-responses/);
});

test('per-provider drift is caught when the runtime exposes provider apis', () => {
  const providerApis = new Map<string, readonly string[]>([
    ['openai-codex', ['openai-codex-responses']],
    // commandcode still registered, but no longer serving the Anthropic path the guard sides on.
    ['commandcode', ['openai-completions']],
  ]);
  const verdict = checkHostCompatibility(compatible({ providerApis }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0], /commandcode/);
  assert.match(verdict.failures[0], /anthropic-messages/);
});

test('a guarded provider that vanished entirely is reported as unregistered', () => {
  const verdict = checkHostCompatibility(compatible({
    providerApis: new Map<string, readonly string[]>([['commandcode', [...GUARDED_APIS.commandcode]]]),
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0], /openai-codex/);
  assert.match(verdict.failures[0], /not registered/);
});

test('an unknown host identity is reported without crashing', () => {
  const verdict = checkHostCompatibility(compatible({ hostPackage: undefined }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.hostIdentity, 'unknown-host@unknown-version');
});

test('every failure is collected, not just the first', () => {
  const verdict = checkHostCompatibility(compatible({ hasStream: false, hasGetAuth: false, apiIds: [] }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 4); // stream and the three required apis (getAuth is unverified)
});

test('the refusal message names the build, every failure, and the repair path', () => {
  const verdict = checkHostCompatibility(compatible({ hasStreamSimple: false, apiIds: ['openai-completions'] }));
  const message = compatibilityRefusal(verdict);
  assert.match(message, /refusing to activate on @earendil-works\/pi-coding-agent@1\.1\.0/);
  assert.match(message, /streamSimple\(\)/);
  assert.match(message, /openai-codex-responses/);
  assert.match(message, /anthropic-messages/);
  assert.match(message, /check:quota-host/);
  assert.match(message, /docs\/quota-guard-compatibility\.md/);
  assert.match(message, /never falls back/);
});

test('asking for a refusal message on a compatible host is a programming error', () => {
  assert.throws(() => compatibilityRefusal(checkHostCompatibility(compatible())), /compatible host/);
});
