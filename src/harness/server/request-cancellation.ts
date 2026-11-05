import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One hook request's client-disconnect signal.
 *
 * A hook client (Claude Code, Codex) gives up on a PreToolUse decision after its own timeout (240 s in the
 * installed settings) and cold-allows the tool call. Any heavyweight check the daemon is still running for
 * that request then has no consumer: its verdict reaches nobody, and the host slot it holds delays the Git
 * hook the client has meanwhile started (observed 2026-11-04: the pre-tool test gate kept the slot until its
 * own 300 s deadline while the pinned pre-push hook waited ~100 s for capacity).
 *
 * Both socket transports run each request's evaluation under this store and abort it when the socket closes.
 * Only request-scoped work with no deliverable after the client leaves may consult it (the pre-tool git
 * gate); durable obligations the request opened (background test drains, ledger writes) must not, which is
 * why this is separate from `check-engine/process-cancellation.ts`, whose signal every spawner honours.
 */
const requests = new AsyncLocalStorage<AbortSignal>();

/** Run one request's evaluation under its client-disconnect signal. */
export function withRequestCancellation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return requests.run(signal, work);
}

/** The current request's client-disconnect signal; undefined outside a transport-owned request. */
export function currentRequestSignal(): AbortSignal | undefined {
    return requests.getStore();
}
