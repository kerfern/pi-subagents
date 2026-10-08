// Operator-authorised live certification of the quota guard's adapters.
//
// This is the only thing in this package that talks to a provider. It is read-only: one
// bearer-authenticated GET per endpoint, to the pinned first-party origins below, and it prints the
// normalised snapshot - never a credential, an Authorization header, or a raw response body.
// Nothing runs it automatically: not the guard, not the test suite, not CI.
//
//   node quota-guard/certify-live.mjs --dry-run commandcode   # plan only: origins and paths
//   node quota-guard/certify-live.mjs commandcode             # one read-only GET per endpoint
//   node quota-guard/certify-live.mjs codex
//
// Credentials come from the environment of the shell that runs this, and from nowhere else. It never
// reads auth.json, settings.json, the keychain, or anything under ~/.pi. See
// docs/quota-guard-compatibility.md.
import { pathToFileURL } from 'node:url';
import { codexUsageUrl, FIRST_PARTY_ORIGINS, QuotaError, readQuota } from '../src/quota-guard/adapters.ts';
import { laneKey } from '../src/quota-guard/coordinator.ts';
import { assess, DEFAULT_POLICY, ReserveEstimator } from '../src/quota-guard/policy.ts';

const CODEX_BASE = 'https://chatgpt.com/backend-api';

/** Today's pin is exactly one first-party origin per provider; more than one means the pin moved. */
function pinnedOrigin(provider) {
	const origins = FIRST_PARTY_ORIGINS[provider];
	if (origins.size !== 1) throw new QuotaError('schema');
	return [...origins][0];
}

/**
 * The certification plan: the identity the guard would use, the variables it needs, and the exact
 * endpoints the adapters are expected to request. The dry run prints these; the live run counts them.
 */
const PROVIDERS = {
	commandcode: {
		identity: { providerId: 'commandcode', scope: 'provider' },
		variables: [['COMMANDCODE_API_KEY', 'the CommandCode API key, sent as a bearer token']],
		endpoints: [
			`${pinnedOrigin('commandcode')}/alpha/billing/credits`,
			`${pinnedOrigin('commandcode')}/alpha/billing/subscriptions`,
		],
	},
	codex: {
		identity: { providerId: 'openai-codex', scope: 'account' },
		variables: [
			['CODEX_ACCESS_TOKEN', 'the Codex access token, sent as a bearer token'],
			['CODEX_ACCOUNT_ID', 'the ChatGPT account id, sent as the chatgpt-account-id header'],
			[
				'CODEX_LIMITS',
				'the verified meter scope, JSON: [{"id":"codex","windows":["primary_window","secondary_window"]}]',
			],
		],
		endpoints: [codexUsageUrl(CODEX_BASE)],
	},
};

const USAGE = [
	'usage: node quota-guard/certify-live.mjs [--dry-run] <commandcode|codex>',
	'  --dry-run  validate the environment and print the pinned origins and paths, sending nothing',
];

/**
 * Shape-checks CODEX_LIMITS before any request. The adapter re-validates the scope after the response,
 * but a typo caught there would already have spent one live request, so the free checks happen first.
 */
function readCodexLimits(raw) {
	let limits;
	try {
		limits = JSON.parse(raw);
	} catch {
		return { problem: 'CODEX_LIMITS is not valid JSON' };
	}
	const shaped =
		Array.isArray(limits) &&
		limits.length > 0 &&
		limits.every(
			(limit) =>
				limit !== null &&
				typeof limit === 'object' &&
				typeof limit.id === 'string' &&
				limit.id.length > 0 &&
				Array.isArray(limit.windows) &&
				limit.windows.length > 0 &&
				limit.windows.every((window) => window === 'primary_window' || window === 'secondary_window'),
		);
	return shaped
		? { limits }
		: {
				problem:
					'CODEX_LIMITS must be a non-empty JSON array of {"id": string, "windows": ["primary_window" | "secondary_window"]}',
			};
}

/** Reads the credential from the environment only, and names exactly what is missing. */
function environment(provider, env) {
	const spec = PROVIDERS[provider];
	const missing = spec.variables.filter(([name]) => !env[name]);
	const problems = [];
	if (missing.length) {
		problems.push(`missing credential(s) for ${provider}: ${missing.map(([name]) => name).join(', ')}`);
		for (const [name, purpose] of missing) problems.push(`  ${name}  ${purpose}`);
	}
	const auth = { ...spec.identity };
	if (provider === 'commandcode') {
		auth.apiKey = env.COMMANDCODE_API_KEY;
	} else {
		auth.apiKey = env.CODEX_ACCESS_TOKEN;
		auth.accountId = env.CODEX_ACCOUNT_ID;
		if (env.CODEX_LIMITS) {
			const parsed = readCodexLimits(env.CODEX_LIMITS);
			if (parsed.problem) problems.push(parsed.problem);
			else auth.codexLimits = parsed.limits;
		}
	}
	return { auth, problems };
}

function refuse(fail, problems) {
	for (const problem of problems) fail(problem);
	return 1;
}

/**
 * Returns the exit code: 0 certified, 1 refused or failed, 2 usage. The exit code is the point - the
 * live run is usable as a check, not just an observation.
 */
export async function main({
	argv = process.argv.slice(2),
	env = process.env,
	fetchImpl = fetch,
	log = console.log,
	fail = console.error,
} = {}) {
	const dryRun = argv.includes('--dry-run');
	const operands = argv.filter((argument) => !argument.startsWith('-'));
	const flags = argv.filter((argument) => argument.startsWith('-') && argument !== '--dry-run');
	const provider = operands.length === 1 && !flags.length ? operands[0] : undefined;
	if (!provider || !Object.hasOwn(PROVIDERS, provider)) {
		const reason = provider
			? `unknown provider "${provider}"`
			: flags.length
				? `unrecognised flag "${flags[0]}"`
				: 'no provider given';
		fail(`refused: ${reason}; refusing to guess which quota to certify`);
		for (const line of USAGE) fail(line);
		return 2;
	}

	const spec = PROVIDERS[provider];
	const { auth, problems } = environment(provider, env);
	log(`Quota guard live certification - ${provider} (read-only, operator-authorised)`);
	log(`identity: provider=${auth.providerId} scope=${auth.scope}${auth.scope === 'account' ? ' account=present' : ''}`);
	log(`${spec.endpoints.length} pinned endpoint(s), one GET each:`);
	for (const endpoint of spec.endpoints) {
		const url = new URL(endpoint);
		log(`  ${url.origin}${url.pathname}`);
	}

	if (dryRun) {
		log('dry run: nothing sent');
		if (problems.length) return refuse(fail, problems);
		log('environment: ready');
		return 0;
	}
	if (problems.length) return refuse(fail, problems);

	// The counting transport uses the adapter's own injection seam - no global is patched, and the
	// adapters still own origins, headers, redirects, deadline and parsing.
	const counts = new Map();
	const counted = (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		counts.set(url, (counts.get(url) ?? 0) + 1);
		return fetchImpl(input, init);
	};

	let snapshot;
	try {
		snapshot = await readQuota(auth, {
			fetchImpl: counted,
			...(provider === 'codex' ? { codexBase: CODEX_BASE } : {}),
		});
	} catch (error) {
		// A QuotaError carries a fixed code and a sanitised message. Anything else is reported by name
		// only, because an unexpected error could still be carrying response text.
		const code = error instanceof QuotaError ? error.code : error instanceof Error ? error.name : 'unknown';
		fail(`certification refused: ${code}`);
		if (error instanceof QuotaError && error.retryAt) fail(`retry at: ${error.retryAt}`);
		fail('A refusal is not certification: the guard stays closed.');
		return 1;
	}

	const reserve = new ReserveEstimator().observe(laneKey({ ...auth, credential: auth.apiKey ?? '' }), snapshot.windows);
	const assessment = assess(snapshot, DEFAULT_POLICY, 'running', reserve, Date.now());
	log(`checked at: ${snapshot.checkedAt}`);
	log('windows:');
	for (const window of snapshot.windows) {
		log(`  ${window.id}  used ${window.used}  cap ${window.cap}  resetAt ${window.resetAt}`);
	}
	log('reserve:');
	for (const window of snapshot.windows) {
		const units = reserve.get(window.id);
		log(
			`  ${window.id}  ${units === null ? 'unknown (one read: the estimator needs two observations with movement)' : units}`,
		);
	}
	log(
		`assessment: ${assessment.state} / ${assessment.reason}${assessment.limitingWindow ? ` (limiting window ${assessment.limitingWindow})` : ''}`,
	);
	log(`thresholds: warn ${DEFAULT_POLICY.warn}% pause ${DEFAULT_POLICY.pause}% resume ${DEFAULT_POLICY.resume}%`);
	const made = [...counts].map(([url, count]) => `${new URL(url).pathname} x${count}`);
	log(`requests made: ${[...counts.values()].reduce((sum, count) => sum + count, 0)} (${made.join(', ')})`);

	const repeated = [...counts].filter(([, count]) => count > 1);
	if (repeated.length) {
		fail(`refused: an endpoint was requested more than once (${repeated.map(([url]) => new URL(url).pathname).join(', ')})`);
		return 1;
	}

	log('certified: yes - the windows and caps above are as the provider reported them');
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main();
}
