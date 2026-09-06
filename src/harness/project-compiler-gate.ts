// ===========================================
// Per-project compiler admission control
// ===========================================
// A bounded in-process queue composes with the cross-process lease in
// project-compiler-lock.ts. Ownership covers the actual compiler child
// lifetime, including the time between SIGTERM and OS process exit.

import {
	acquireCrossProcessCompilerLease,
	canonicalProjectRoot,
	type CrossProcessCompilerLease,
	tryAcquireCrossProcessCompilerLease,
} from "./project-compiler-lock.js";

const DEFAULT_MAX_QUEUED = 8;
const DEFAULT_ADMISSION_TIMEOUT_MS = 2_000;

export type ProjectCompilerUnavailableReason = "aborted" | "busy" | "queue_full";

export class ProjectCompilerUnavailableError extends Error {
	readonly reason: ProjectCompilerUnavailableReason;

	constructor(reason: ProjectCompilerUnavailableReason, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProjectCompilerUnavailableError";
		this.reason = reason;
	}
}

export interface ProjectCompilerLeaseOptions {
	/** Cancellation applies while queued / waiting for cross-process admission. */
	signal?: AbortSignal;
	/** Maximum queue + cross-process admission wait. Default: 2 seconds. */
	admissionTimeoutMs?: number;
	/** Maximum queued callers behind the active compiler. Default: 8. */
	maxQueued?: number;
}

interface WarmCompilerRegistration {
	token: symbol;
	evict: () => void | Promise<void>;
	eviction: Promise<void> | null;
	crossProcessLease: CrossProcessCompilerLease;
}

interface QueueEntry {
	task: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	deadline: number;
	signal: AbortSignal | undefined;
	cancelled: boolean;
	cleanup: () => void;
}

interface ProjectCompilerState {
	key: string;
	active: boolean;
	draining: boolean;
	queue: QueueEntry[];
	warm: WarmCompilerRegistration | null;
}

const projectStates = new Map<string, ProjectCompilerState>();

function getState(projectRoot: string): ProjectCompilerState {
	const key = canonicalProjectRoot(projectRoot);
	const existing = projectStates.get(key);
	if (existing) return existing;
	const created: ProjectCompilerState = {
		key,
		active: false,
		draining: false,
		queue: [],
		warm: null,
	};
	projectStates.set(key, created);
	return created;
}

function deleteIdleState(state: ProjectCompilerState): void {
	if (!state.active && !state.draining && state.queue.length === 0 && state.warm === null) {
		projectStates.delete(state.key);
	}
}

function requestWarmEviction(state: ProjectCompilerState): Promise<void> | null {
	const warm = state.warm;
	if (!warm) return null;
	if (!warm.eviction) {
		warm.eviction = Promise.resolve()
			.then(() => warm.evict())
			.then(() => undefined);
	}
	return warm.eviction;
}

function admissionError(
	state: ProjectCompilerState,
	options: ProjectCompilerLeaseOptions,
): ProjectCompilerUnavailableError | null {
	const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
	if (state.queue.length >= maxQueued) {
		return new ProjectCompilerUnavailableError(
			"queue_full",
			`compiler queue is full (${maxQueued} waiting)`,
		);
	}
	if (options.signal?.aborted) {
		return new ProjectCompilerUnavailableError("aborted", "compiler admission aborted");
	}
	return null;
}

function removeQueuedEntry(state: ProjectCompilerState, entry: QueueEntry): boolean {
	const index = state.queue.indexOf(entry);
	if (index < 0) return false;
	state.queue.splice(index, 1);
	return true;
}

function cancelQueuedEntry(
	state: ProjectCompilerState,
	entry: QueueEntry,
	reason: ProjectCompilerUnavailableReason,
	message: string,
): void {
	if (!removeQueuedEntry(state, entry)) return;
	entry.cancelled = true;
	entry.cleanup();
	entry.reject(new ProjectCompilerUnavailableError(reason, message));
	deleteIdleState(state);
}

function enqueue<T>(
	state: ProjectCompilerState,
	task: () => Promise<T>,
	options: ProjectCompilerLeaseOptions,
): Promise<T> {
	return new Promise<T>((resolveTask, rejectTask) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let abortListener: (() => void) | null = null;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			timer = null;
			if (abortListener && options.signal) {
				options.signal.removeEventListener("abort", abortListener);
			}
			abortListener = null;
		};
		const entry: QueueEntry = {
			task,
			// SAFETY: QueueEntry erases T only inside this coordinator; the same
			// promise closure receives the task's T value without transformation.
			resolve: (value) => resolveTask(value as T),
			reject: rejectTask,
			deadline: Date.now() + (options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS),
			signal: options.signal,
			cancelled: false,
			cleanup,
		};
		const timeout = (): void => {
			cancelQueuedEntry(state, entry, "busy", "compiler admission timed out while queued");
		};
		abortListener = (): void => {
			cancelQueuedEntry(state, entry, "aborted", "compiler admission aborted while queued");
		};
		timer = setTimeout(timeout, options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS);
		options.signal?.addEventListener("abort", abortListener, { once: true });
		state.queue.push(entry);
		void drain(state);
	});
}

interface WarmEvictionAdmissionEnd {
	promise: Promise<never>;
	cleanup: () => void;
}

function warmEvictionAdmissionEnd(entry: QueueEntry): WarmEvictionAdmissionEnd {
	let rejectAdmission: (error: ProjectCompilerUnavailableError) => void;
	const promise = new Promise<never>((_resolve, reject) => {
		rejectAdmission = reject;
	});
	const timer = setTimeout(() => {
		rejectAdmission(
			new ProjectCompilerUnavailableError(
				"busy",
				"warm compiler eviction exceeded the admission deadline",
			),
		);
	}, Math.max(0, entry.deadline - Date.now()));
	const onAbort = (): void => {
		rejectAdmission(
			new ProjectCompilerUnavailableError(
				"aborted",
				"compiler admission aborted while evicting the warm compiler",
			),
		);
	};
	if (entry.signal?.aborted) queueMicrotask(onAbort);
	else entry.signal?.addEventListener("abort", onAbort, { once: true });
	return {
		promise,
		cleanup: () => {
			clearTimeout(timer);
			entry.signal?.removeEventListener("abort", onAbort);
		},
	};
}

async function awaitWarmEviction(
	state: ProjectCompilerState,
	eviction: Promise<void>,
	entry: QueueEntry,
): Promise<void> {
	const admissionEnd = warmEvictionAdmissionEnd(entry);
	try {
		await Promise.race([eviction, admissionEnd.promise]);
	} finally {
		admissionEnd.cleanup();
	}
	if (state.warm) {
		throw new ProjectCompilerUnavailableError(
			"busy",
			"warm compiler did not release its project lease after eviction",
		);
	}
}

async function executeEntry(state: ProjectCompilerState, entry: QueueEntry): Promise<unknown> {
	const eviction = requestWarmEviction(state);
	if (eviction) await awaitWarmEviction(state, eviction, entry);
	let lease = tryAcquireCrossProcessCompilerLease(state.key);
	if (!lease) {
		try {
			lease = await acquireCrossProcessCompilerLease(state.key, entry.deadline, entry.signal);
		} catch (error) {
			if (entry.signal?.aborted) {
				throw new ProjectCompilerUnavailableError(
					"aborted",
					"compiler admission aborted while waiting for another process",
					{ cause: error },
				);
			}
			throw error;
		}
	}
	if (!lease) {
		throw new ProjectCompilerUnavailableError(
			"busy",
			"another process is already compiling this project",
		);
	}
	entry.cleanup();
	try {
		return await entry.task();
	} finally {
		lease.release();
	}
}

async function settleEntry(state: ProjectCompilerState, entry: QueueEntry): Promise<void> {
	try {
		const value = await executeEntry(state, entry);
		state.active = false;
		entry.resolve(value);
	} catch (error) {
		entry.cleanup();
		state.active = false;
		entry.reject(error);
	}
}

async function drain(state: ProjectCompilerState): Promise<void> {
	if (state.draining || state.active) return;
	state.draining = true;
	try {
		let entry = state.queue.shift();
		while (entry) {
			if (!entry.cancelled) {
				state.active = true;
				await settleEntry(state, entry);
			}
			entry = state.queue.shift();
		}
	} finally {
		state.draining = false;
		deleteIdleState(state);
	}
}

/**
 * Queue one cold compiler. Every caller runs separately after its edit is on
 * disk; results are never coalesced across edit generations. The queue is
 * bounded and cancellable while waiting.
 */
export function runWithProjectCompilerLease<T>(
	projectRoot: string,
	task: () => Promise<T>,
	options: ProjectCompilerLeaseOptions = {},
): Promise<T> {
	const state = getState(projectRoot);
	const error = admissionError(state, options);
	return error ? Promise.reject(error) : enqueue(state, task, options);
}

function startSynchronousLease(state: ProjectCompilerState): (() => void) | null {
	if (state.active || state.draining || state.queue.length > 0) return null;
	const lease = tryAcquireCrossProcessCompilerLease(state.key);
	if (!lease) return null;
	state.active = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		lease.release();
		state.active = false;
		deleteIdleState(state);
		if (state.queue.length > 0) void drain(state);
	};
}

/**
 * Synchronous acquisition never waits. A warm child is asked to stop and the
 * caller receives null until its exit callback releases the lease.
 */
export function tryAcquireProjectCompilerLease(projectRoot: string): (() => void) | null {
	const state = getState(projectRoot);
	if (!state.warm) return startSynchronousLease(state);
	void requestWarmEviction(state);
	return null;
}

function canRegisterWarmCompiler(state: ProjectCompilerState): boolean {
	return !state.warm && !state.active && !state.draining && state.queue.length === 0;
}

function registerWarmCompiler(
	state: ProjectCompilerState,
	evict: () => void | Promise<void>,
	lease: CrossProcessCompilerLease,
): () => void {
	const token = Symbol("warm-project-compiler");
	state.warm = { token, evict, eviction: null, crossProcessLease: lease };
	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		if (state.warm?.token !== token) return;
		state.warm = null;
		lease.release();
		deleteIdleState(state);
		if (state.queue.length > 0) void drain(state);
	};
}

/** Register a warm child until its post-exit unregister callback runs. */
export function tryRegisterWarmProjectCompiler(
	projectRoot: string,
	evict: () => void | Promise<void>,
): (() => void) | null {
	const state = getState(projectRoot);
	if (!canRegisterWarmCompiler(state)) return null;
	const lease = tryAcquireCrossProcessCompilerLease(state.key);
	return lease ? registerWarmCompiler(state, evict, lease) : null;
}
