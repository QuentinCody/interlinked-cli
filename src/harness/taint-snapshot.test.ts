import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../lib/json-types.js";
import { readTaintSources } from "./session-snapshot-codec.js";
import { OPERATOR_CLEAR_FILE, type TaintClearOutcome } from "./taint-control.js";
import {
	clearTaintInSnapshot,
	listTaintedSnapshotViews,
	readTaintSnapshotView,
} from "./taint-snapshot.js";
import { DEFAULT_TAINT_CONFIG } from "./taint-tracker.js";

const CONFIG = DEFAULT_TAINT_CONFIG;
const LEGACY_ID = "c698b9a9-d8f0-449f-a527-d7c3efd48402";

let cwd: string;

/** A snapshot in the OLD format: the Confidential source carries no
 *  `escalated` flag and no detail — exactly the state that made the real
 *  session's level unreviewable. */
function writeLegacySnapshot(id: string, level = "Confidential"): void {
	const dir = join(cwd, ".interlinked", "sessions");
	mkdirSync(dir, { recursive: true });
	const sources = [
		{ file: "<bash:curl x>", level: "Public", at_step: 272, provenance: "fetched_external" },
		{ file: "<command-output>", level, at_step: 769, provenance: "local_read" },
		{ file: "<bash:rg -n x>", level: "Public", at_step: 900, provenance: "fetched_external" },
	];
	const snapshot = {
		session_id: id,
		agent_name: "lead",
		tool_call_count: 22_549,
		sensitivity_level: level,
		step_limit: 10_000,
		taint_sources: sources,
	};
	writeFileSync(snapshotPath(id), `${JSON.stringify(snapshot)}\n`);
}

function snapshotPath(id: string): string {
	return join(cwd, ".interlinked", "sessions", `${id}.live.json`);
}

/** Clear, narrowing the result union outside any test body: a refusal here is
 *  a defect in the fixture, not a case the positive tests cover. */
function clearOrThrow(id: string, reason: string): { outcome: Omit<TaintClearOutcome, "applied_to"> } {
	const result = clearTaintInSnapshot(cwd, id, CONFIG, reason);
	if (!result.ok) throw new Error(`clear unexpectedly refused: ${result.reason}`);
	return result;
}

function readRaw(id: string): JsonObject {
	// SAFETY: the file was written by writeLegacySnapshot or by
	// writeLiveSnapshot above, both of which serialize a JSON object.
	return JSON.parse(readFileSync(snapshotPath(id), "utf-8")) as JsonObject;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "taint-snap-"));
});

describe("readTaintSnapshotView — positive (must fire)", () => {
	it("P1: names the old-format setter of a Confidential snapshot", () => {
		writeLegacySnapshot(LEGACY_ID);
		const view = readTaintSnapshotView(cwd, LEGACY_ID, CONFIG);
		expect(view?.sensitivity_level).toBe("Confidential");
		expect(view?.step_limit).toBe(10_000);
		expect(view?.network_blocked).toBe(true);
		expect(view?.set_by).toMatchObject({
			file: "<command-output>",
			at_step: 769,
			inferred: true,
		});
		expect(view?.origin).toBe("live-snapshot");
		expect(view?.source_count).toBe(3);
	});

	it("P2: lists only the tainted snapshots", () => {
		writeLegacySnapshot(LEGACY_ID);
		writeLegacySnapshot("00000000-aaaa-bbbb-cccc-000000000000", "Public");
		const listed = listTaintedSnapshotViews(cwd, CONFIG);
		expect(listed.map((view) => view.session_id)).toEqual([LEGACY_ID]);
	});
});

describe("readTaintSnapshotView — negative (must not fire)", () => {
	it("N1: a missing snapshot reads as null and lists as empty", () => {
		expect(readTaintSnapshotView(cwd, LEGACY_ID, CONFIG)).toBeNull();
		expect(listTaintedSnapshotViews(cwd, CONFIG)).toEqual([]);
	});

	it("N2: a traversal-shaped session id reads as null", () => {
		expect(readTaintSnapshotView(cwd, "../../etc/passwd", CONFIG)).toBeNull();
	});
});

describe("clearTaintInSnapshot — positive (must fire)", () => {
	it("P1: reports the previous level and the inferred setter", () => {
		writeLegacySnapshot(LEGACY_ID);
		const result = clearOrThrow(LEGACY_ID, "youtube public key false positive");
		expect(result.outcome).toMatchObject({
			previous_level: "Confidential",
			previous_step_limit: 10_000,
			new_level: "Public",
			new_step_limit: null,
			set_by: "<command-output>",
			set_by_inferred: true,
		});

		const raw = readRaw(LEGACY_ID);
		expect(raw.sensitivity_level).toBe("Public");
		expect(raw.step_limit).toBeNull();
		const sources = readTaintSources(raw.taint_sources);
		expect(sources).toHaveLength(4);
		expect(sources[0]?.file).toBe("<bash:curl x>");
		expect(sources[3]).toEqual({
			file: OPERATOR_CLEAR_FILE,
			level: "Public",
			at_step: 22_549,
			provenance: "local_read",
			detail: "youtube public key false positive",
		});
	});
});

describe("clearTaintInSnapshot — negative (must not fire)", () => {
	it("N1: refuses an unknown session and writes nothing", () => {
		const result = clearTaintInSnapshot(cwd, LEGACY_ID, CONFIG, "r");
		expect(result.ok).toBe(false);
		expect(readTaintSnapshotView(cwd, LEGACY_ID, CONFIG)).toBeNull();
	});

	it("N2: refuses an already-Public snapshot and leaves it byte-identical", () => {
		writeLegacySnapshot(LEGACY_ID, "Public");
		const before = readFileSync(snapshotPath(LEGACY_ID), "utf-8");
		const result = clearTaintInSnapshot(cwd, LEGACY_ID, CONFIG, "r");
		expect(result.ok).toBe(false);
		expect(readFileSync(snapshotPath(LEGACY_ID), "utf-8")).toBe(before);
	});
});
