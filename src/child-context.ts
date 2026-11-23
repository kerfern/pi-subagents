import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 *
 * The storage hangs off a `globalThis` symbol because more than one copy of this
 * module can be live in one process: the package the parent session loaded and
 * the copy a separately-installed extension reads. A plain module-level value
 * would give each copy its own empty storage, and `inChildSessionContext()`
 * would answer `false` for work that is demonstrably a child's.
 */
const CHILD_CONTEXT_KEY = Symbol.for("pi-subagents.child-context.v1");

interface ChildContextHost {
  storage?: AsyncLocalStorage<boolean>;
}

const host = globalThis as typeof globalThis & { [CHILD_CONTEXT_KEY]?: ChildContextHost };
if (host[CHILD_CONTEXT_KEY] === undefined) host[CHILD_CONTEXT_KEY] = {};
const slot = host[CHILD_CONTEXT_KEY] as ChildContextHost;
if (slot.storage === undefined) slot.storage = new AsyncLocalStorage<boolean>();
const childSessionContext = slot.storage;

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
