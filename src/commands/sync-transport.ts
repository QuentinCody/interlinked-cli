import { resolveAuthToken } from "../lib/auth.js";
import { resolveConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { isJsonObject } from "../lib/json-types.js";
import { appendSyncError } from "../lib/local-activity.js";
import { nonNull } from "../lib/non-null.js";
import { outputError } from "../lib/output.js";
import {
	type BatchSendArgs,
	type BatchSendOutcome,
	type BoundedResponseBody,
	type BoundedSyncContext,
	readBoundedResponseBody,
} from "./sync-bounded.js";

const MAX_BATCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [250, 750];
const BATCH_SYNC_REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve server, auth, and workspace targeting for one sync run. */
export function resolveSyncContext(
	mode: Parameters<typeof outputError>[0],
): BoundedSyncContext | null {
	const config = resolveConfig();
	const serverUrl = config.server_url;
	const isLocalDev = serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1");
	const payloadDefaults: BoundedSyncContext["payloadDefaults"] = {
		workspaceKey: config.default_workspace_key || "main",
		projectKey: config.default_project || "main",
	};
	const token = resolveAuthToken();
	const workspaceId = config.workspace_id;

	if (isLocalDev && !workspaceId) {
		outputError(
			mode,
			"workspace_id required for local dev sync. Set it in .interlinked/config.local.json under the active server entry.",
		);
		return null;
	}

	return { serverUrl, isLocalDev, payloadDefaults, token, workspaceId };
}

interface BatchDelta {
	accepted: number;
	skipped: number;
	errors: number;
	batchesSent: number;
	retriesUsed: number;
}

interface AttemptContext {
	batchNum: number;
	attempt: number;
	batchSize: number;
	mode: string;
}

type AttemptResult = "retry" | "fail" | "auth_failed";

interface BatchReceipt {
	accepted: number;
	skipped: number;
	errors: 0;
}

type ReceiptResult = { ok: true; receipt: BatchReceipt } | { ok: false; reason: string };

interface BatchHttpResponse {
	ok: boolean;
	status: number;
	body: BoundedResponseBody;
}

function receiptCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readBatchReceipt(body: BoundedResponseBody, batchSize: number): ReceiptResult {
	if (!body.ok) return body;
	let value: unknown;
	try {
		value = JSON.parse(body.text);
	} catch (error) {
		return {
			ok: false,
			reason: `response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!isJsonObject(value)) return { ok: false, reason: "response receipt is not an object" };
	const accepted = receiptCount(value.accepted);
	const skipped = receiptCount(value.skipped);
	const errors = receiptCount(value.errors);
	if (accepted === null || skipped === null || errors === null) {
		return { ok: false, reason: "accepted, skipped, and errors must be non-negative integers" };
	}
	if (errors !== 0) return { ok: false, reason: `response reported ${errors} error(s)` };
	if (accepted + skipped !== batchSize) {
		return {
			ok: false,
			reason: `response accounted for ${accepted + skipped} of ${batchSize} submitted event(s)`,
		};
	}
	return { ok: true, receipt: { accepted, skipped, errors: 0 } };
}

async function fetchBatchResponse(args: BatchSendArgs): Promise<BatchHttpResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), BATCH_SYNC_REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${args.serverUrl}/api/hooks/activity/batch`, {
			method: "POST",
			headers: args.headers,
			body: JSON.stringify(args.body),
			signal: controller.signal,
		});
		let body: BoundedResponseBody;
		try {
			body = await readBoundedResponseBody(response);
		} catch (error) {
			if (controller.signal.aborted) throw error;
			body = {
				ok: false,
				reason: `response body could not be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		return { ok: response.ok, status: response.status, body };
	} finally {
		clearTimeout(timeout);
	}
}

function recordInvalidReceipt(
	reason: string,
	ctx: AttemptContext,
	delta: BatchDelta,
): void {
	delta.errors += ctx.batchSize;
	appendSyncError({
		stage: "manual_sync_receipt",
		message: `Batch ${ctx.batchNum} returned an invalid success receipt: ${reason}`,
		batch: ctx.batchNum,
		attempt: ctx.attempt,
		transient: false,
	});
	if (ctx.mode !== "json") {
		process.stderr.write(
			c.dim(`  Batch ${ctx.batchNum} returned an invalid receipt: ${reason}\n`),
		);
	}
}

async function handleNonOkResponse(
	response: BatchHttpResponse,
	ctx: AttemptContext,
	delta: BatchDelta,
): Promise<AttemptResult> {
	const { batchNum, attempt, batchSize, mode } = ctx;
	const errBody = response.body.ok ? response.body.text : `[${response.body.reason}]`;
	if (response.status === 401) {
		appendSyncError({
			stage: "manual_sync_auth",
			message: "Authentication failed (401) during sync",
			status: 401,
			batch: batchNum,
			attempt,
			transient: false,
		});
		return "auth_failed";
	}

	const transient = response.status === 429 || response.status >= 500;
	appendSyncError({
		stage: "manual_sync_http",
		message: `Batch ${batchNum} failed with status ${response.status}: ${errBody.slice(0, 200)}`,
		status: response.status,
		batch: batchNum,
		attempt,
		transient,
	});

	if (transient && attempt < MAX_BATCH_RETRIES) {
		delta.retriesUsed++;
		await sleep(nonNull(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]));
		return "retry";
	}

	delta.errors += batchSize;
	if (mode !== "json") {
		process.stderr.write(
			c.dim(`  Batch ${batchNum} failed (${response.status}): ${errBody.slice(0, 100)}\n`),
		);
	}
	return "fail";
}

async function handleBatchError(
	err: unknown,
	ctx: AttemptContext,
	delta: BatchDelta,
): Promise<"retry" | "fail"> {
	const { batchNum, attempt, batchSize, mode } = ctx;
	const isTimeout = err instanceof Error && err.name === "AbortError";
	appendSyncError({
		stage: isTimeout ? "manual_sync_timeout" : "manual_sync_network",
		message: err instanceof Error ? err.message : String(err),
		batch: batchNum,
		attempt,
		transient: true,
	});

	if (attempt < MAX_BATCH_RETRIES) {
		delta.retriesUsed++;
		await sleep(nonNull(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]));
		return "retry";
	}

	delta.errors += batchSize;
	if (isTimeout && mode !== "json") {
		process.stderr.write(c.dim("  Batch timed out (10s)\n"));
	}
	return "fail";
}

type BatchAttemptResult = "retry" | "success" | "failure" | "auth_failed";

/** Run one send attempt for a batch, mutating `delta` with its accounting. */
async function runBatchAttempt(
	args: BatchSendArgs,
	ctx: AttemptContext,
	delta: BatchDelta,
): Promise<BatchAttemptResult> {
	try {
		const response = await fetchBatchResponse(args);
		if (response.ok) {
			const receipt = readBatchReceipt(response.body, args.batchSize);
			if (!receipt.ok) {
				recordInvalidReceipt(receipt.reason, ctx, delta);
				return "failure";
			}
			delta.accepted += receipt.receipt.accepted;
			delta.skipped += receipt.receipt.skipped;
			delta.batchesSent++;
			return "success";
		}

		const outcome = await handleNonOkResponse(response, ctx, delta);
		if (outcome === "auth_failed") return "auth_failed";
		if (outcome === "retry") return "retry";
		return "failure";
	} catch (error) {
		const outcome = await handleBatchError(error, ctx, delta);
		if (outcome === "retry") return "retry";
		return "failure";
	}
}

/** Send one batch with bounded retry/backoff and strict receipt accounting. */
export async function sendOneBatch(args: BatchSendArgs): Promise<BatchSendOutcome> {
	const { batchNum, batchSize, mode } = args;
	const delta: BatchDelta = {
		accepted: 0,
		skipped: 0,
		errors: 0,
		batchesSent: 0,
		retriesUsed: 0,
	};
	let batchSucceeded = false;
	let batchFailureCounted = false;

	for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
		const ctx: AttemptContext = { batchNum, attempt, batchSize, mode };
		const result = await runBatchAttempt(args, ctx, delta);
		if (result === "retry") continue;
		if (result === "auth_failed") return { kind: "auth_failed" };
		if (result === "success") batchSucceeded = true;
		else batchFailureCounted = true;
		break;
	}

	if (!batchSucceeded && !batchFailureCounted) delta.errors += batchSize;
	return { kind: "done", ...delta };
}
