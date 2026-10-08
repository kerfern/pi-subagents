// Mutation checks for the coordinator and root invariants.
// Never touches a real source file: every mutant is applied to a temp copy and the
// focused suite runs against that copy only. Originals are hash-compared afterwards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Derived from this script, and its own Node, so it runs from any checkout.
const guard = dirname(fileURLToPath(import.meta.url));
const sourcesDir = join(guard, '..', 'src', 'quota-guard');

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
for (const file of tests) originalTests[file] = await readFile(join(guard, 'test', file), 'utf8');
const before = Object.fromEntries(sources.map((f) => [f, SHA(bytes[f])]));

const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'coordinator-mutations-'));
try {
  await mkdir(join(root, 'test'), { mode: 0o700 });
  await writeFile(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  for (const file of sources) await writeFile(join(root, file), originals[file], { mode: 0o600 });
  for (const file of tests) await writeFile(join(root, 'test', file), originalTests[file], { mode: 0o600 });

  const results = [];
  for (const [index, m] of mutants.entries()) {
    const source = originals[m.file];
    assert.ok(source.includes(m.needle), `${m.name}: needle not found in ${m.file}`);
    await writeFile(join(root, m.file), source.replace(m.needle, m.replacement), { mode: 0o600 });
    // --test-timeout surfaces a hanging test as a normal non-zero exit instead of a 60s ETIMEDOUT.
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=10000', join(root, 'test', m.test)], {
      encoding: 'utf8', timeout: 60_000,
    });
    const killed = result.status !== 0 && !result.error && result.status !== null;
    results.push({ ...m, status: result.status, killed, error: result.error?.message });
    console.log(`${killed ? 'killed' : 'SURVIVED'} ${index + 1}/${mutants.length} ${m.name} (node --test test/${m.test}) exit=${result.status}`);
    // Restore the pristine file for the next mutant.
    await writeFile(join(root, m.file), source, { mode: 0o600 });
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
