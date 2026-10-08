// Host conformance: prove the seams this guard depends on still exist in the INSTALLED pi build.
//
// The guard admits traffic by injecting a per-request `fetch`. The seam whose silent failure would
// dispatch requests unguarded is whether that fetch still builds the final outgoing request, so it
// is checked by *running* the real built-in adapter against a fake transport; adapter support alone
// is not enough, because the guard admits traffic by decorating `ModelRuntime.prototype`, so a
// second check drives a dispatch *through* a decorated prototype and proves the injected fetch sees
// it. Seams that cannot be exercised offline (a supplied Anthropic client, the Codex WebSocket
// branch) are checked against the installed source and labelled `static` so nobody mistakes them
// for end-to-end proof.
//
// Offline by construction: every transport here is a fake, the credential is a synthetic string,
// and no request leaves the machine.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KNOWN_GLOBAL_HOST = '/Users/kerf/.local/lib/node_modules/@earendil-works/pi-coding-agent';
const SYNTHETIC_KEY = 'synthetic-not-a-real-key';
const REQUIRED_APIS = ['openai-codex-responses', 'openai-completions', 'anthropic-messages'];

/** Resolve the installed host: explicit PI_HOST_PATH, then resolution, then the well-known global path. */
export async function resolveHost() {
  const candidates = [];
  if (process.env.PI_HOST_PATH) candidates.push(process.env.PI_HOST_PATH);
  try {
    candidates.push(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent/package.json'));
  } catch { /* not a local dependency; the global path below is the normal case */ }
  candidates.push(join(KNOWN_GLOBAL_HOST, 'package.json'));

  for (const candidate of candidates) {
    const packagePath = candidate.endsWith('package.json') ? candidate : join(candidate, 'package.json');
    if (!existsSync(packagePath)) continue;
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    const root = dirname(packagePath);
    // pi-ai physically nests under the host package (and may also exist at the top level).
    const nested = join(root, 'node_modules', '@earendil-works', 'pi-ai');
    const piAiRoot = existsSync(nested) ? nested : join(dirname(root), 'pi-ai');
    return { packagePath, root, piAiRoot, name: pkg.name, version: pkg.version };
  }
  throw new Error(`host not found: set PI_HOST_PATH, or install @earendil-works/pi-coding-agent (tried ${candidates.join(', ')})`);
}

const result = (name, ok, detail, kind = 'runtime') => ({ name, ok: ok === true, detail, kind });

/** Synthetic SSE body: one content chunk, one terminal chunk, then [DONE]. */
function syntheticSseBody() {
  const chunks = [
    { id: 'chatcmpl-synthetic', object: 'chat.completion.chunk', created: 0, model: 'synthetic-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'chatcmpl-synthetic', object: 'chat.completion.chunk', created: 0, model: 'synthetic-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

const syntheticModel = () => ({
  api: 'openai-completions',
  provider: 'commandcode',
  id: 'synthetic-model',
  name: 'Synthetic',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  contextWindow: 8192,
  maxTokens: 128,
  input: ['text'],
});

/**
 * THE check: does the injected fetch still receive the final built request?
 * `transport` is injectable so the negative control can prove this check can fail.
 */
export async function checkFetchReachesFinalRequest(host, transport) {
  const name = 'the injected fetch receives the final OpenAI-compatible request';
  let stream;
  try {
    ({ stream } = await import(pathToFileURL(join(host.piAiRoot, 'dist', 'api', 'openai-completions.js')).href));
  } catch (error) {
    return result(name, false, `could not load the built-in openai-completions adapter: ${error.message}`);
  }
  const calls = [];
  const fetchImpl = transport ?? (async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url: String(input), method: init?.method, authorization: headers.get('authorization') });
    return new Response(syntheticSseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] };
  try {
    for await (const event of stream(syntheticModel(), context, { apiKey: SYNTHETIC_KEY, fetch: fetchImpl })) {
      if (event.type === 'error') return result(name, false, `adapter reported: ${event.error?.errorMessage ?? 'error'}`);
    }
  } catch (error) {
    return result(name, false, `adapter threw: ${error.message}`);
  }
  const expectedUrl = 'https://api.commandcode.ai/provider/v1/chat/completions';
  const ok = calls.length === 1 && calls[0].url === expectedUrl && calls[0].method === 'POST'
    && calls[0].authorization === `Bearer ${SYNTHETIC_KEY}`;
  return result(name, ok, ok
    ? `${calls[0].method} ${calls[0].url} with a synthetic bearer`
    : `expected exactly one POST to ${expectedUrl} carrying the synthetic bearer, observed ${JSON.stringify(calls)}`);
}

/**
 * THE dispatch check: a call made *through* a decorated `ModelRuntime.prototype` must reach the
 * injected fetch. The guard's gate is a decorator on that prototype, so adapter support alone (the
 * check above) does not prove the arrangement the guard actually relies on.
 *
 * No real `ModelRuntime` instance is constructed: its constructor is private and `create()` reads
 * credential state this offline check must not touch. Instead the dispatch runs on a minimal
 * receiver whose prototype chain IS the real `ModelRuntime.prototype` - `prepareRequest`, the lazy
 * stream wrapper and the built-in adapter all execute for real; only the credential/provider
 * lookups the caller owns are stubbed with the synthetic string. `transport` is injectable so the
 * negative control can prove this check can fail.
 */
export async function checkRuntimeDispatchReachesInjectedFetch(host, transport) {
  const name = 'a dispatch through a decorated ModelRuntime.prototype reaches the injected fetch';
  let ModelRuntime;
  try {
    ({ ModelRuntime } = await import(pathToFileURL(join(host.root, 'dist', 'index.js')).href));
  } catch (error) {
    return result(name, false, `could not import ModelRuntime from the host entry: ${error.message}`);
  }
  const prototype = ModelRuntime?.prototype;
  if (typeof prototype?.stream !== 'function' || typeof prototype?.streamSimple !== 'function') {
    return result(name, false, 'the host ModelRuntime prototype no longer exposes stream/streamSimple');
  }
  let adapterStream;
  try {
    ({ stream: adapterStream } = await import(
      pathToFileURL(join(host.piAiRoot, 'dist', 'api', 'openai-completions.js')).href));
  } catch (error) {
    return result(name, false, `could not load the built-in openai-completions adapter: ${error.message}`);
  }

  const calls = [];
  const fetchImpl = transport ?? (async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url: String(input), method: init?.method, authorization: headers.get('authorization') });
    return new Response(syntheticSseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  // Minimal receiver: the real prototype, plus only the seams `prepareRequest` reads. The credential
  // is the synthetic string; nothing is loaded from disk.
  const receiver = Object.create(prototype);
  receiver.models = {
    getProvider: () => ({ id: 'commandcode', stream: adapterStream }),
    getAuth: async () => ({ auth: { apiKey: SYNTHETIC_KEY, headers: {} }, env: {} }),
  };
  receiver.config = { getProvider: () => undefined };
  receiver.extensionProviders = new Map();

  const originalStream = prototype.stream;
  const originalSimple = prototype.streamSimple;
  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] };
  let failure;
  try {
    // Mirrors the guard: inject the fake fetch into the caller's options, then delegate with the live
    // receiver so the instance - not the prototype - answers the private lookups.
    prototype.stream = function (model, contextArg, options) {
      return originalStream.call(this, model, contextArg, { ...(options ?? {}), fetch: fetchImpl });
    };
    for await (const event of receiver.stream(syntheticModel(), context, {})) {
      if (event.type === 'error') {
        failure = `runtime reported: ${event.error?.errorMessage ?? 'error'}`;
        break;
      }
    }
  } catch (error) {
    failure = `runtime threw: ${error.message}`;
  } finally {
    prototype.stream = originalStream;
  }
  if (prototype.stream !== originalStream || prototype.streamSimple !== originalSimple) {
    return result(name, false, 'the probe left ModelRuntime.prototype decorated - it would corrupt the host it is checking');
  }
  if (failure) return result(name, false, failure);

  const expectedUrl = 'https://api.commandcode.ai/provider/v1/chat/completions';
  const ok = calls.length === 1 && calls[0].url === expectedUrl && calls[0].method === 'POST'
    && calls[0].authorization === `Bearer ${SYNTHETIC_KEY}`;
  return result(name, ok, ok
    ? `the decorated prototype delivered POST ${calls[0].url} with a synthetic bearer to the injected fetch`
    : `expected the injected fetch to receive exactly one POST to ${expectedUrl} carrying the synthetic bearer, observed ${JSON.stringify(calls)}`);
}

/** Static: the supplied-client bypass is the fail-open case the guard refuses at activation. */
export async function checkAnthropicClientBypass(host) {
  const name = 'a supplied Anthropic client still bypasses the injected fetch (refused by the guard)';
  try {
    const source = await readFile(join(host.piAiRoot, 'dist', 'api', 'anthropic-messages.js'), 'utf8');
    const found = /options\?\.client/.test(source);
    return result(name, found, found
      ? 'static: options?.client short-circuits the injected fetch, so the guard must refuse it'
      : 'static: the client short-circuit is gone — re-derive whether a supplied client still bypasses fetch', 'static');
  } catch (error) {
    return result(name, false, `could not read the anthropic adapter: ${error.message}`, 'static');
  }
}

/** Static: Codex must be forced onto SSE because fetch cannot see the WebSocket path. */
export async function checkCodexSseBranch(host) {
  const name = 'the Codex adapter still branches on transport (SSE vs WebSocket)';
  try {
    const source = await readFile(join(host.piAiRoot, 'dist', 'api', 'openai-codex-responses.js'), 'utf8');
    const found = /transport !== "sse"/.test(source) || /transport !== 'sse'/.test(source);
    return result(name, found, found
      ? 'static: the SSE branch exists; the guard forces transport:"sse" so fetch can see the request'
      : 'static: no transport branch found — the WebSocket path may no longer be avoidable this way', 'static');
  } catch (error) {
    return result(name, false, `could not read the codex adapter: ${error.message}`, 'static');
  }
}

/** Static: the api ids the guard reasons about must still be declared. */
export async function checkRequiredApis(host) {
  const name = 'every api id the guard reasons about is still declared';
  try {
    const types = await readFile(join(host.piAiRoot, 'dist', 'types.d.ts'), 'utf8');
    const missing = REQUIRED_APIS.filter((api) => !types.includes(`"${api}"`));
    return result(name, missing.length === 0, missing.length === 0
      ? `static: ${REQUIRED_APIS.join(', ')}`
      : `static: missing ${missing.join(', ')}`, 'static');
  } catch (error) {
    return result(name, false, `could not read pi-ai types: ${error.message}`, 'static');
  }
}

/** Static: the runtime must still expose a public getAuth, which the guard uses for identity. */
export async function checkPublicGetAuth(host) {
  const name = 'ModelRuntime still declares a public getAuth(model)';
  try {
    const dts = await readFile(join(host.root, 'dist', 'core', 'model-runtime.d.ts'), 'utf8');
    const found = /getAuth\(model/.test(dts);
    return result(name, found, found
      ? 'static: getAuth(model, overrides?) is declared'
      : 'static: getAuth(model) is no longer declared — identity resolution has no supported route', 'static');
  } catch (error) {
    return result(name, false, `could not read the host runtime declarations: ${error.message}`, 'static');
  }
}

/** The negative control: a deliberately broken transport must make the runtime check FAIL. */
export async function checkNegativeControl(host) {
  const name = 'negative control: a broken transport is detected rather than passed';
  const broken = await checkFetchReachesFinalRequest(host, async () => {
    throw new Error('synthetic transport failure (negative control)');
  });
  return result(name, broken.ok === false,
    broken.ok ? 'the harness PASSED a transport that cannot work — the harness is unsound' : 'a broken transport is reported as a failure', 'static');
}

/** Negative control for the dispatch check: a broken transport must make it FAIL. */
export async function checkDispatchNegativeControl(host) {
  const name = 'negative control: the dispatch check fails when the injected transport is broken';
  const broken = await checkRuntimeDispatchReachesInjectedFetch(host, async () => {
    throw new Error('synthetic transport failure (negative control)');
  });
  return result(name, broken.ok === false,
    broken.ok ? 'the dispatch check PASSED a transport that cannot work - it is unsound' : 'a broken transport fails the dispatch check', 'static');
}

export async function runChecks(host) {
  return [
    await checkFetchReachesFinalRequest(host),
    await checkRuntimeDispatchReachesInjectedFetch(host),
    await checkDispatchNegativeControl(host),
    await checkAnthropicClientBypass(host),
    await checkCodexSseBranch(host),
    await checkRequiredApis(host),
    await checkPublicGetAuth(host),
    await checkNegativeControl(host),
  ];
}

async function main() {
  let host;
  try {
    host = await resolveHost();
  } catch (error) {
    console.error(`FAIL host resolution: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`host: ${host.name}@${host.version}`);
  console.log(`  package: ${host.packagePath}`);
  console.log(`  pi-ai:   ${host.piAiRoot}`);
  const checks = await runChecks(host);
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} [${check.kind}] ${check.name}`);
    console.log(`     ${check.detail}`);
  }
  const failed = checks.filter((check) => !check.ok);
  console.log(failed.length === 0
    ? `\n${checks.length}/${checks.length} checks passed. The guard's seams match this host.`
    : `\n${failed.length}/${checks.length} checks FAILED. Keep the guard disabled; see docs/quota-guard-compatibility.md.`);
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
