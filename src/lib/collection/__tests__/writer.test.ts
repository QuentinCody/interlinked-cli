import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "../types.js";
import { appendCollection, getCollectionPath } from "../writer.js";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);

// vitest 4: restoreAllMocks un-mocks automocked module exports (node:fs here),
// so a later test's mockReturnValue would target the real fn. resetAllMocks
// keeps the automock in place while clearing call history + implementations.
afterEach(() => vi.resetAllMocks());

function stubRecord(overrides: Partial<CollectionRecord> = {}): CollectionRecord {
	return {
		schema: "collection.v1",
		kind: "tool_event",
		ts: "2026-05-19T12:00:00.000Z",
		session_id: "sess-1",
		agent_name: null,
		turn_id: null,
		tool_use_id: "tu-1",
		provider: "claude-code",
		phase: "post",
		tool_class: "shell_exec",
		provider_tool: "Bash",
		cwd: "/repo",
		git: null,
		action: { command: "echo hi", cwd: "/repo" },
		observation: { stdout: "hi", stderr: null, exit_code: 0, duration_ms: null },
		fidelity: { record: { source: "provider_hook", completeness: "complete" }, fields: {} },
		privacy: {
			redaction_status: "unscanned",
			redaction_passes: [],
			sensitivity: "unknown",
			contains_sensitive: "unknown",
			allowed_for_training: false,
			allowed_for_cloud_upload: false,
		},
		provider_raw: {
			tool_input_ref: null,
			tool_response_ref: null,
			tool_input_sha256: null,
			tool_response_sha256: null,
		},
		...overrides,
	};
}

describe("getCollectionPath", () => {
	it("returns .interlinked/collection.jsonl under cwd", () => {
		expect(getCollectionPath("/my/repo")).toBe(
			path.join("/my/repo", ".interlinked", "collection.jsonl"),
		);
	});
});

describe("appendCollection", () => {
	it("creates directory and appends JSON line", () => {
		mockFs.existsSync.mockReturnValue(false);
		mockFs.mkdirSync.mockReturnValue(undefined);
		mockFs.appendFileSync.mockReturnValue(undefined);

		const rec = stubRecord();
		appendCollection(rec, "/my/repo");

		expect(mockFs.mkdirSync).toHaveBeenCalledWith(
			path.join("/my/repo", ".interlinked"),
			{ recursive: true },
		);
		expect(mockFs.appendFileSync).toHaveBeenCalledTimes(2);

		const written = mockFs.appendFileSync.mock.calls[0]?.[1];
		if (typeof written !== "string") throw new Error("Expected a serialized collection record");
		expect(written.endsWith("\n")).toBe(true);

		const parsed = JSON.parse(written.trim());
		expect(parsed.schema).toBe("collection.v1");
		expect(parsed.tool_class).toBe("shell_exec");
		expect(parsed.capture).toMatchObject({ version: 1, producer: "lib/collection/writer" });
		const receipt = JSON.parse(String(mockFs.appendFileSync.mock.calls[1]?.[1]).trim());
		expect(receipt).toMatchObject({ source: "collection", status: "written", records: 1 });
	});

	it("skips mkdir when directory exists", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.appendFileSync.mockReturnValue(undefined);

		appendCollection(stubRecord(), "/my/repo");
		expect(mockFs.mkdirSync).not.toHaveBeenCalledWith(
			path.join("/my/repo", ".interlinked"),
			{ recursive: true },
		);
		// The shared append/rotation protocol still acquires its lock directory.
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(
			`${getCollectionPath("/my/repo")}.interlinked-mutation.lock`,
		);
	});

	it("swallows write errors silently", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.appendFileSync.mockImplementation(() => {
			throw new Error("disk full");
		});

		expect(() => appendCollection(stubRecord(), "/my/repo")).not.toThrow();
	});
});
