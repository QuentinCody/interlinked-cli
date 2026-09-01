// Bounded paging/checkpoint support for `interlinked sync`.

import type { JsonObject } from "../lib/json-types.js";
import type {
	ActivitySyncBasis,
	LastSyncSummary,
	LocalActivityEvent,
} from "../lib/local-activity.js";
import { checkpointSyncState, getUnsyncedEvents } from "../lib/local-activity.js";
import { loadScrubConfig, recordScrub, scrubEgressPayload } from "../lib/secrets.js";
import type { BatchSummary } from "./sync-format.js";
import {
	buildBatchBody,
	buildBatchHeaders,
	buildEventPayload,
	type PayloadDefaults,
} from "./sync-payload.js";

const BATCH_SIZE = 100;
const MAX_SYNC_RESPONSE_BODY_BYTES = 262_144;
export const SYNC_SUMMARY_RETAINED_KEY_LIMIT = 256;
const MAX_SYNC_SUMMARY_KEY_LENGTH = 512;
const retainedSummaryKeyCounts = new WeakMap<Record<string, number>, number>();

export interface SummaryOmissions {
	byTypeOccurrences: number;
	byAgentOccurrences: number;
	byToolOccurrences: number;
	sessionOccurrences: number;
}

function emptySummaryOmissions(): SummaryOmissions {
	return {
		byTypeOccurrences: 0,
		byAgentOccurrences: 0,
		byToolOccurrences: 0,
		sessionOccurrences: 0,
	};
}

export function summaryIsComplete(omissions: SummaryOmissions): boolean {
	return (
		omissions.byTypeOccurrences === 0 &&
		omissions.byAgentOccurrences === 0 &&
		omissions.byToolOccurrences === 0 &&
		omissions.sessionOccurrences === 0
	);
}

export type BoundedResponseBody =
	| { ok: true; text: string }
	| { ok: false; reason: string };

function declaredBodyBytes(response: Response): number | null {
	const raw = response.headers.get("content-length");
	if (raw === null || !/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

async function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	try {
		await reader.cancel("sync response body exceeded the byte limit");
	} catch {
		// The limit verdict is already known. Cancellation is best-effort cleanup.
	}
}

/**
 * Read a fetch response without allowing a server-controlled body to grow
 * without bound. Fetch exposes decoded bytes through the response stream, so
 * the counter also bounds compressed responses after decompression.
 */
export async function readBoundedResponseBody(response: Response): Promise<BoundedResponseBody> {
	const declared = declaredBodyBytes(response);
	if (declared !== null && declared > MAX_SYNC_RESPONSE_BODY_BYTES) {
		await response.body?.cancel("sync response Content-Length exceeded the byte limit");
		return {
			ok: false,
			reason: `response body exceeded ${MAX_SYNC_RESPONSE_BODY_BYTES} bytes`,
		};
	}
	if (!response.body) return { ok: true, text: "" };

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > MAX_SYNC_RESPONSE_BODY_BYTES) {
			await cancelBody(reader);
			return {
				ok: false,
				reason: `response body exceeded ${MAX_SYNC_RESPONSE_BODY_BYTES} bytes`,
			};
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	text += decoder.decode();
	return { ok: true, text };
}

export interface BoundedSyncContext {
	serverUrl: string;
	isLocalDev: boolean;
	payloadDefaults: PayloadDefaults;
	token: string | null;
	workspaceId: string | undefined;
}

export interface BatchSendArgs {
	serverUrl: string;
	headers: Record<string, string>;
	body: JsonObject;
	batchNum: number;
	batchSize: number;
	mode: string;
}

interface BatchSendDelta {
	accepted: number;
	skipped: number;
	errors: number;
	batchesSent: number;
	retriesUsed: number;
}

export type BatchSendOutcome =
	| ({ kind: "done" } & BatchSendDelta)
	| { kind: "auth_failed" };

interface SyncProgress {
	accepted: number;
	skipped: number;
	errors: number;
	scrubbed: number;
	batchesSent: number;
	retriesUsed: number;
	eventsTotal: number;
	cursor: number;
	summary: BatchSummary;
	summaryOmissions: SummaryOmissions;
}

function emptyCountMap(): Record<string, number> {
	// SAFETY: Object.create(null) produces a dictionary with no inherited keys;
	// every value written through addBoundedCount is a finite number.
	const counts = Object.create(null) as Record<string, number>;
	retainedSummaryKeyCounts.set(counts, 0);
	return counts;
}

function emptySummary(): BatchSummary {
	return {
		byType: emptyCountMap(),
		byAgent: emptyCountMap(),
		byTool: emptyCountMap(),
		topTools: [],
		sessions: new Set<string>(),
		earliest: "",
		latest: "",
	};
}

interface BoundedCountArgs {
	target: Record<string, number>;
	key: string;
	omissions: SummaryOmissions;
	omissionField: keyof SummaryOmissions;
}

function addBoundedCount(args: BoundedCountArgs): void {
	const { target, key, omissions, omissionField } = args;
	if (Object.hasOwn(target, key)) {
		target[key] = (target[key] ?? 0) + 1;
		return;
	}
	if (
		key.length > MAX_SYNC_SUMMARY_KEY_LENGTH ||
		(retainedSummaryKeyCounts.get(target) ?? 0) >= SYNC_SUMMARY_RETAINED_KEY_LIMIT
	) {
		omissions[omissionField]++;
		return;
	}
	Object.defineProperty(target, key, {
		value: 1,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	retainedSummaryKeyCounts.set(target, (retainedSummaryKeyCounts.get(target) ?? 0) + 1);
}

function addBoundedSession(
	target: Set<string>,
	session: string,
	omissions: SummaryOmissions,
): void {
	if (target.has(session)) return;
	if (
		session.length > MAX_SYNC_SUMMARY_KEY_LENGTH ||
		target.size >= SYNC_SUMMARY_RETAINED_KEY_LIMIT
	) {
		omissions.sessionOccurrences++;
		return;
	}
	target.add(session);
}

function addEventSummary(
	target: BatchSummary,
	omissions: SummaryOmissions,
	event: LocalActivityEvent,
): void {
	addBoundedCount({
		target: target.byType,
		key: event.type,
		omissions,
		omissionField: "byTypeOccurrences",
	});
	if (event.agent && event.agent !== "unknown") {
		addBoundedCount({
			target: target.byAgent,
			key: event.agent,
			omissions,
			omissionField: "byAgentOccurrences",
		});
	}
	if (event.tool) {
		addBoundedCount({
			target: target.byTool,
			key: event.tool,
			omissions,
			omissionField: "byToolOccurrences",
		});
	}
	if (event.session) addBoundedSession(target.sessions, event.session, omissions);
}

function addEventTimeRange(target: BatchSummary, event: LocalActivityEvent): void {
	if (!target.earliest || event.ts < target.earliest) target.earliest = event.ts;
	if (!target.latest || event.ts > target.latest) target.latest = event.ts;
}

function addBatchSummary(
	target: BatchSummary,
	omissions: SummaryOmissions,
	events: LocalActivityEvent[],
): void {
	for (const event of events) {
		addEventSummary(target, omissions, event);
		addEventTimeRange(target, event);
	}
}

export function topTools(summary: BatchSummary): [string, number][] {
	return Object.entries(summary.byTool)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5);
}

function lastSyncSummary(
	progress: SyncProgress,
	ctx: BoundedSyncContext,
): LastSyncSummary | undefined {
	if (!summaryIsComplete(progress.summaryOmissions)) return undefined;
	return {
		server_url: ctx.serverUrl,
		workspace_id: ctx.workspaceId || null,
		events_total: progress.eventsTotal,
		accepted: progress.accepted,
		skipped: progress.skipped,
		scrubbed: progress.scrubbed,
		batches: progress.batchesSent,
		by_type: progress.summary.byType,
		by_agent: progress.summary.byAgent,
		top_tools: topTools(progress.summary),
		sessions: progress.summary.sessions.size,
		time_range: { earliest: progress.summary.earliest, latest: progress.summary.latest },
	};
}

interface SyncPreviewArgs {
	limit: number | undefined;
	start: number;
	basis: ActivitySyncBasis;
}

interface SyncPreview {
	events: number;
	newOffset: number;
}

export function readSyncPreview(args: SyncPreviewArgs): SyncPreview {
	let remaining = args.limit && args.limit > 0 ? args.limit : Number.POSITIVE_INFINITY;
	let cursor = args.start;
	let events = 0;
	while (cursor < args.basis.endExclusive && remaining > 0) {
		const page = getUnsyncedEvents(Math.min(BATCH_SIZE, remaining), undefined, {
			startOffset: cursor,
			endExclusive: args.basis.endExclusive,
			expectedIdentity: args.basis.identity,
		});
		if (page.newOffset <= cursor) break;
		cursor = page.newOffset;
		events += page.events.length;
		remaining -= page.events.length;
	}
	return { events, newOffset: cursor };
}

interface RunSyncArgs {
	ctx: BoundedSyncContext;
	mode: string;
	limit: number | undefined;
	start: number;
	basis: ActivitySyncBasis;
	previousSummary: LastSyncSummary | undefined;
	sendBatch: (args: BatchSendArgs) => Promise<BatchSendOutcome>;
}

type SyncRunOutcome =
	| { kind: "done"; progress: SyncProgress }
	| { kind: "auth_failed" };

function emptyProgress(start: number): SyncProgress {
	return {
		accepted: 0,
		skipped: 0,
		errors: 0,
		scrubbed: 0,
		batchesSent: 0,
		retriesUsed: 0,
		eventsTotal: 0,
		cursor: start,
		summary: emptySummary(),
		summaryOmissions: emptySummaryOmissions(),
	};
}

interface PageCheckpoint {
	basis: ActivitySyncBasis;
	expectedCursor: number;
	nextCursor: number;
	summary: LastSyncSummary | undefined;
}

function checkpointPage(checkpoint: PageCheckpoint): void {
	checkpointSyncState({
		basis: checkpoint.basis,
		expectedCursor: checkpoint.expectedCursor,
		nextCursor: checkpoint.nextCursor,
		...(checkpoint.summary === undefined ? {} : { summary: checkpoint.summary }),
	});
}

export async function runBoundedSync(args: RunSyncArgs): Promise<SyncRunOutcome> {
	const progress = emptyProgress(args.start);
	const scrubConfig = loadScrubConfig();
	let remaining = args.limit && args.limit > 0 ? args.limit : Number.POSITIVE_INFINITY;
	let batchNum = 1;
	while (progress.cursor < args.basis.endExclusive && remaining > 0) {
		const pageStart = progress.cursor;
		const page = getUnsyncedEvents(Math.min(BATCH_SIZE, remaining), undefined, {
			startOffset: pageStart,
			endExclusive: args.basis.endExclusive,
			expectedIdentity: args.basis.identity,
		});
		if (page.newOffset <= progress.cursor) break;
		if (page.events.length === 0) {
			checkpointPage({
				basis: args.basis,
				expectedCursor: pageStart,
				nextCursor: page.newOffset,
				summary:
					progress.eventsTotal > 0 ? lastSyncSummary(progress, args.ctx) : args.previousSummary,
			});
			progress.cursor = page.newOffset;
			continue;
		}
		addBatchSummary(progress.summary, progress.summaryOmissions, page.events);
		progress.eventsTotal += page.events.length;
		const batchPayload = page.events.map((event) => {
			const payload = buildEventPayload(event, args.ctx.payloadDefaults);
			const scrub = scrubEgressPayload(payload, scrubConfig);
			if (scrub.found > 0) {
				progress.scrubbed += scrub.found;
				recordScrub(scrub.types);
			}
			return payload;
		});
		const outcome = await args.sendBatch({
			serverUrl: args.ctx.serverUrl,
			headers: buildBatchHeaders(args.ctx.token, args.ctx.isLocalDev),
			body: buildBatchBody(args.ctx.payloadDefaults, batchPayload, args.ctx.workspaceId),
			batchNum,
			batchSize: page.events.length,
			mode: args.mode,
		});
		if (outcome.kind === "auth_failed") return { kind: "auth_failed" };
		progress.accepted += outcome.accepted;
		progress.skipped += outcome.skipped;
		progress.errors += outcome.errors;
		progress.batchesSent += outcome.batchesSent;
		progress.retriesUsed += outcome.retriesUsed;
		if (outcome.errors > 0) break;
		checkpointPage({
			basis: args.basis,
			expectedCursor: pageStart,
			nextCursor: page.newOffset,
			summary: lastSyncSummary(progress, args.ctx),
		});
		progress.cursor = page.newOffset;
		remaining -= page.events.length;
		batchNum++;
	}
	return { kind: "done", progress };
}
