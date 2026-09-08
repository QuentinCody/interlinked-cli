import { readJsonRecord } from "./__tests__/json.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	beginPostToolWarningSpool,
	completePostToolWarningSpool,
	QUALITY_WARNING_SPOOL_DIR,
} from "./post-tool-warning-spool.js";

const roots: string[] = [];

function tempInterlinkedDir(): string {
	const root = mkdtempSync(join(tmpdir(), "il-warning-spool-"));
	roots.push(root);
	return join(root, ".interlinked");
}

function event(token?: string, sessionId = "session-a"): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: sessionId,
		agent_source: "codex",
		timestamp: "2026-08-31T12:00:00.000Z",
		post_delivery_token: token,
		post_delivery_pid: process.pid,
	};
}

function readyWarnings(path: string): string[] {
	const value = readJsonRecord(readFileSync(path, "utf-8"));
	if (!Array.isArray(value.warnings) || !value.warnings.every((item): item is string => typeof item === "string")) throw new Error("Expected warning strings");
	return value.warnings;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("request-owned PostTool warning spool", () => {
	it("keeps overlapping requests isolated when one finishes clean", () => {
		const dataDir = tempInterlinkedDir();
		const first = beginPostToolWarningSpool(dataDir, event("request-token-0001"));
		const second = beginPostToolWarningSpool(dataDir, event("request-token-0002"));

		expect(first.ownsMarker).toBe(true);
		expect(second.ownsMarker).toBe(true);
		expect(JSON.parse(readFileSync(first.markerPath, "utf-8"))).toMatchObject({
			token: "request-token-0001",
			session_id: "session-a",
			client_pid: process.pid,
		});
		completePostToolWarningSpool(second, []);
		expect(existsSync(first.markerPath)).toBe(true);
		expect(existsSync(second.markerPath)).toBe(false);
		expect(existsSync(second.readyPath)).toBe(false);

		completePostToolWarningSpool(first, ["first warning"]);
		// Warning completion keeps the client-liveness marker until the
		// synchronous hook acknowledges or a late drain claims both files.
		expect(existsSync(first.markerPath)).toBe(true);
		expect(readyWarnings(first.readyPath)).toEqual(["first warning"]);
	});

	it("does not let a duplicate token unlink or overwrite the live owner's request", () => {
		const dataDir = tempInterlinkedDir();
		const owner = beginPostToolWarningSpool(dataDir, event("duplicate-token-01"));
		const duplicate = beginPostToolWarningSpool(dataDir, event("duplicate-token-01"));

		expect(owner.ownsMarker).toBe(true);
		expect(duplicate.ownsMarker).toBe(false);
		completePostToolWarningSpool(duplicate, ["wrong warning"]);
		expect(existsSync(owner.markerPath)).toBe(true);
		expect(existsSync(owner.readyPath)).toBe(false);

		completePostToolWarningSpool(owner, ["owner warning"]);
		expect(readyWarnings(owner.readyPath)).toEqual(["owner warning"]);
	});

	it("publishes one immutable ready record when completion is retried", () => {
		const dataDir = tempInterlinkedDir();
		const handle = beginPostToolWarningSpool(dataDir, event("idempotent-token1", "session-b"));
		completePostToolWarningSpool(handle, ["only once"]);
		completePostToolWarningSpool(handle, ["must not replace"]);

		expect(readyWarnings(handle.readyPath)).toEqual(["only once"]);
		expect(existsSync(join(dataDir, QUALITY_WARNING_SPOOL_DIR))).toBe(true);
	});

	it("deletes the unpublished temp record when the atomic rename fails", () => {
		const dataDir = tempInterlinkedDir();
		const handle = beginPostToolWarningSpool(dataDir, event("rename-failure-tok"));
		// A directory sitting on the ready path lets the temp write succeed and
		// makes only the rename fail — the one state in which a temp file exists
		// with nothing to publish it.
		mkdirSync(handle.readyPath, { recursive: true });

		expect(() => completePostToolWarningSpool(handle, ["undeliverable warning"])).toThrow(
			/rename/,
		);

		const spoolDir = join(dataDir, QUALITY_WARNING_SPOOL_DIR);
		expect(readdirSync(spoolDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(existsSync(handle.markerPath)).toBe(false);
	});

	it("does not persist an unowned record for an older hook with no delivery token", () => {
		const dataDir = tempInterlinkedDir();
		const handle = beginPostToolWarningSpool(dataDir, event(undefined, "legacy-session"));
		expect(handle.requested).toBe(false);
		expect(handle.ownsMarker).toBe(false);
		completePostToolWarningSpool(handle, ["direct-only warning"]);
		expect(existsSync(handle.markerPath)).toBe(false);
		expect(existsSync(handle.readyPath)).toBe(false);
	});
});
