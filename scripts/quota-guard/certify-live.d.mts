// `certify-live.mjs` stays plain JavaScript on purpose: it is an operator script, not guard code.
// This declares the one export the guard's TypeScript suite drives, so importing it does not silently
// become `any` (and `tsc` stays green without hiding the error).
export interface CertifyLiveOptions {
	argv?: string[];
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	log?: (line: string) => void;
	fail?: (line: string) => void;
}
/** Returns the exit code: 0 certified, 1 refused or failed, 2 usage. See certify-live.mjs. */
export function main(options?: CertifyLiveOptions): Promise<number>;
