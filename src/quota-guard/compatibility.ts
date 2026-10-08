import type { GuardedProvider } from './types.ts';

/**
 * Explicit compatibility boundary for the host seams this guard depends on.
 *
 * The guard assumes four things about the host: the runtime exposes `stream`/`streamSimple` and a
 * public `getAuth`, the api ids it reasons about still exist, and a caller-supplied `fetch` reaches
 * the final built request. Of those, only the first three are cheaply observable from a descriptor.
 * The fourth — the one whose silent failure would dispatch requests unguarded — is what
 * `host-contract.test.ts` and `check-host.mjs` exist to prove against the installed host, because
 * nothing here can prove it from a descriptor alone.
 *
 * Evaluated only when an operator enables the guard. A failed or unknown check refuses to install
 * rather than degrading to unguarded dispatch. Version metadata identifies which host build the
 * evidence came from; it never substitutes for the capability checks themselves, and a version that
 * looks familiar is not evidence that a seam still behaves the same way.
 */

/** The api ids the guard reasons about: Codex responses, the OpenAI-compatible path, and Anthropic. */
export const REQUIRED_APIS = Object.freeze([
  'openai-codex-responses',
  'openai-completions',
  'anthropic-messages',
] as const);

/** Per guarded provider, the apis whose built-in implementation the guard can actually side on. */
export const GUARDED_APIS: Readonly<Record<GuardedProvider, readonly string[]>> = Object.freeze({
  'openai-codex': Object.freeze(['openai-codex-responses']),
  commandcode: Object.freeze(['openai-completions', 'anthropic-messages']),
});

/** What the guard can see about the host without reaching into private state or making a request. */
export interface HostDescriptor {
  hasStream: boolean;
  hasStreamSimple: boolean;
  hasGetAuth: boolean;
  /**
   * Every api id the loaded catalog knows about. Omitted when the caller cannot see the catalogue
   * (an extension reaching the runtime through the harness hook cannot enumerate it); the check then
   * reports that contract as unverified rather than pretending it passed.
   */
  apiIds?: readonly string[];
  /** Optional per-provider api list, when the runtime exposes one. */
  providerApis?: ReadonlyMap<string, readonly string[]>;
  /** Identity of the build this descriptor was read from; reported, never trusted as proof. */
  hostPackage?: { name?: string; version?: string };
}

export interface CompatibilityVerdict {
  ok: boolean;
  /** One actionable line per failed check; empty when `ok`. */
  failures: readonly string[];
  /** Contracts this descriptor could not speak to at all. Not failures, but not proof either. */
  unverified: readonly string[];
  /** Best-effort identity of the checked build, for the operator-visible message. */
  hostIdentity: string;
}

function identityOf(host: HostDescriptor): string {
  const name = host.hostPackage?.name ?? 'unknown-host';
  const version = host.hostPackage?.version ?? 'unknown-version';
  return `${name}@${version}`;
}

/**
 * Check the observable seams. Pure: no I/O, no requests, no mutation of `host`.
 *
 * Anything that cannot be verified is reported as a failure rather than assumed, because the cost
 * of a false pass here is an unguarded request rather than a refused one.
 */
export function checkHostCompatibility(host: HostDescriptor): CompatibilityVerdict {
  const failures: string[] = [];
  const where = identityOf(host);
  const unverified: string[] = [];

  if (!host.hasStream) failures.push(`${where}: runtime does not expose a public stream()`);
  if (!host.hasStreamSimple) failures.push(`${where}: runtime does not expose a public streamSimple()`);
  if (!host.hasGetAuth) {
    // Not a failure: the guard resolves identity from the dispatching instance, and an instance may
    // carry getAuth without the prototype advertising it. A host that truly lacks it still fails
    // closed at first dispatch (identity pause) rather than dispatching unguarded.
    unverified.push(`${where}: getAuth was not visible on the decorated runtime`);
  }

  if (host.apiIds === undefined) {
    unverified.push(`${where}: api ids were not supplied, so the api-id contract is unverified`);
  } else {
    const present = new Set(host.apiIds);
    for (const api of REQUIRED_APIS) {
      if (!present.has(api)) failures.push(`${where}: required api "${api}" is missing from the catalog`);
    }
  }

  if (host.providerApis) {
    for (const [provider, apis] of Object.entries(GUARDED_APIS) as [GuardedProvider, readonly string[]][]) {
      const served = host.providerApis.get(provider);
      if (!served) {
        failures.push(`${where}: guarded provider "${provider}" is not registered on this host`);
        continue;
      }
      for (const api of apis) {
        if (!served.includes(api)) {
          failures.push(`${where}: provider "${provider}" no longer serves api "${api}"`);
        }
      }
    }
  }

  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures),
    unverified: Object.freeze(unverified),
    hostIdentity: where,
  });
}

/**
 * Operator-facing message for a refused activation. Names the build, every failed check, and the
 * command that produces the fuller evidence — `check-host.mjs` proves the fetch seam, which a
 * descriptor cannot.
 */
export function compatibilityRefusal(verdict: CompatibilityVerdict): string {
  if (verdict.ok) throw new Error('compatibilityRefusal called for a compatible host');
  return [
    `Quota guard: refusing to activate on ${verdict.hostIdentity} — the host changed in a way this guard relies on.`,
    ...verdict.failures.map((failure) => `  - ${failure}`),
    '  Run `npm run check:quota-host` for the full host-conformance evidence, then repair the boundary in',
    '  src/quota-guard/ and re-run it. See docs/quota-guard-compatibility.md. The guard never falls back to',
    '  dispatching unguarded requests.',
  ].join('\n');
}
