// Mutation checks for the coordinator and root invariants.
// Never touches a real source file: every mutant is applied to a temp copy and the
// focused suite runs against that copy only. Originals are hash-compared afterwards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Derived from this script, and its own Node, so it runs from any checkout. The script now lives in
// scripts/quota-guard/, so the repository root is two levels up.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourcesDir = join(repo, 'src', 'quota-guard');
const testsDir = join(repo, 'test', 'quota-guard');

const SHA = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Files the two focused suites import. Nothing else is needed to run them.
const sources = ['adapters.ts', 'controller.ts', 'coordinator.ts', 'policy.ts', 'types.ts', 'root.ts'];
const tests = ['coordinator.test.ts', 'root.test.ts', 'guard-fixtures.ts'];

const LANE_KEY_BODY = [
  "  if (scope.scope === 'provider') {",
  "    if (scope.accountId !== undefined || scope.providerId !== 'commandcode') throw new QuotaError('auth');",
  '    return `${scope.providerId}:provider`;',
  '  }',
  "  if (scope.scope === 'account') {",
  "    if (!scope.accountId || scope.providerId !== 'openai-codex') throw new QuotaError('auth');",
  '    return `${scope.providerId}:${scope.accountId}`;',
  '  }',
  "  throw new QuotaError('auth');",
].join('\n');

const mutants = [
  {
    name: 'lane-key-ignores-scope',
    file: 'coordinator.ts',
    test: 'coordinator.test.ts',
    needle: LANE_KEY_BODY,
    replacement: "  return `${scope.providerId}:${scope.accountId ?? 'provider'}`;",
  },
  {
    name: 'pinned-origin-check',
    file: 'coordinator.ts',
    test: 'coordinator.test.ts',
    needle: 'return FIRST_PARTY_ORIGINS[providerId].has(new URL(url).origin);',
    replacement: 'return true;',
  },
  {
    name: 'credential-drift-check',
    file: 'coordinator.ts',
    test: 'coordinator.test.ts',
    needle: "req.headers.get('authorization') !== `Bearer ${expected.credential}`",
    replacement: 'false',
  },
  {
    name: 'release-once-guard',
    file: 'coordinator.ts',
    test: 'coordinator.test.ts',
    needle: 'if (!released) { released = true; release(); }',
    replacement: 'release();',
  },
  {
    name: 'wrapper-double-install-check',
    file: 'root.ts',
    test: 'root.test.ts',
    needle: 'if (guardWrappers.has(originalStream) || guardWrappers.has(originalSimple)) {',
    replacement: 'if (false) {',
  },
];

// Hashed as Buffers: a malformed-byte change must not be hidden by lossy UTF-8 decoding.
const bytes = {};
const originals = {};
for (const file of sources) {
  bytes[file] = await readFile(join(sourcesDir, file));
  originals[file] = bytes[file].toString('utf8');
}
const originalTests = {};
for (const file of tests) originalTests[file] = await readFile(join(testsDir, file), 'utf8');
const before = Object.fromEntries(sources.map((f) => [f, SHA(bytes[f])]));

const root = await mkdtemp(join(repo, 'coordinator-mutations-'));
// The temp tree MIRRORS the repository layout because the suites import `../../src/quota-guard/…` and
// those modules pull in more of `src/`. A partial copy (or a flat one) makes a mutant fail to resolve
// its imports, which used to be counted as "killed" for the wrong reason; the baseline below is what
// catches that.
const tempSources = join(root, 'src', 'quota-guard');
const tempTests = join(root, 'test', 'quota-guard');
try {
  await cp(join(repo, 'src'), join(root, 'src'), { recursive: true });
  await cp(testsDir, tempTests, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 });

  // Baseline first: the pristine copies must PASS. Without this, a mutant "killed" by a broken import
  // looks identical to one killed by an assertion, which is exactly how this check can go vacuous.
  for (const suite of [...new Set(mutants.map((m) => m.test))]) {
    const baseline = spawnSync(process.execPath, ['--test', '--test-timeout=10000', join(tempTests, suite)], {
      encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(baseline.status, 0,
      `baseline ${suite} must pass before mutating; the harness would otherwise count load failures as kills\n`
      + `${baseline.stdout ?? ''}${baseline.stderr ?? ''}`.slice(0, 2000));
  }
  console.log('baseline green: pristine copies pass, so a kill means an assertion failed');

  const results = [];
  for (const [index, m] of mutants.entries()) {
    const source = originals[m.file];
    assert.ok(source.includes(m.needle), `${m.name}: needle not found in ${m.file}`);
    await writeFile(join(tempSources, m.file), source.replace(m.needle, m.replacement), { mode: 0o600 });
    // --test-timeout surfaces a hanging test as a normal non-zero exit instead of a 60s ETIMEDOUT.
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=10000', join(tempTests, m.test)], {
      encoding: 'utf8', timeout: 60_000,
    });
    const killed = result.status !== 0 && !result.error && result.status !== null;
    results.push({ ...m, status: result.status, killed, error: result.error?.message });
    console.log(`${killed ? 'killed' : 'SURVIVED'} ${index + 1}/${mutants.length} ${m.name} (node --test test/quota-guard/${m.test}) exit=${result.status}`);
    // Restore the pristine file for the next mutant.
    await writeFile(join(tempSources, m.file), source, { mode: 0o600 });
  }

  const killed = results.filter((r) => r.killed).length;
  console.log(`${killed}/${mutants.length} coordinator/root mutants killed; originals untouched`);

  // Prove the real source files are byte-identical to their pre-run state.
  const after = {};
  for (const f of sources) after[f] = SHA(await readFile(join(sourcesDir, f)));
  assert.deepEqual(after, before, 'a real source file changed');
  console.log(`originals byte-identical (sha256 ${before['coordinator.ts'].slice(0, 12)}... coordinator.ts, ${before['root.ts'].slice(0, 12)}... root.ts)`);
  assert.equal(killed, mutants.length, `${mutants.length - killed} mutant(s) survived`);
} finally { await rm(root, { recursive: true, force: true }); }
