import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "../harness/rules-loader.js";
import type { TaintControlReport, TaintControlRequest } from "../harness/taint-control.js";
import {
	type TaintClientDeps,
	resolveTaintClear,
	resolveTaintStatus,
} from "./harness-taint-client.js";

const LEGACY_ID = "c698b9a9-d8f0-449f-a527-d7c3efd48402";

let cwd: string;

function depsWith(
	query: (request: TaintControlRequest) => Promise<TaintControlReport | null>,
): TaintClientDeps {
	return { cwd, query, config: () => getDefaultConfig().taint_tracking };
}

const noDaemon = (): Promise<TaintControlReport | null> => Promise.resolve(null);

function writeLegacySnapshot(id: string): void {
	const dir = join(cwd, ".interlinked", "sessions");
	mkdirSync(dir, { recursive: true });
	const snapshot = {
		session_id: id,
		agent_name: "lead",
		tool_call_count: 769,
		sensitivity_level: "Confidential",
		step_limit: 10_000,
		taint_sources: [
			{ file: "<command-output>", level: "Confidential", at_step: 769, provenance: "local_read" },
		],
	};
	writeFileSync(join(dir, `${id}.live.json`), `${JSON.stringify(snapshot)}\n`);
}

function storedLevel(id: string): unknown {
	const raw = readFileSync(join(cwd, ".interlinked", "sessions", `${id}.live.json`), "utf-8");
	// SAFETY: this fixture and writeLiveSnapshot both serialize a JSON object.
	return (JSON.parse(raw) as { sensitivity_level?: unknown }).sensitivity_level;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "taint-client-"));
});

describe("resolveTaintStatus — positive (must fire)", () => {
	it("P1: prefers the live daemon report", async () => {
		const query = vi.fn(() =>
			Promise.resolve<TaintControlReport>({
				ok: true,
				session: {
					session_id: LEGACY_ID,
					agent_name: "lead",
					sensitivity_level: "Internal",
					step_limit: 50_000,
					network_block_at: "Confidential",
					network_blocked: false,
					set_by: null,
					source_count: 0,
					recent_sources: [],
					origin: "daemon-memory",
				},
			}),
		);
		const resolved = await resolveTaintStatus(depsWith(query), LEGACY_ID);
		expect(resolved.via).toBe("daemon");
		expect(resolved.report.session?.sensitivity_level).toBe("Internal");
		expect(query).toHaveBeenCalledWith({ operation: "status", session_id: LEGACY_ID });
	});

	it("P2: falls back to the live snapshot and names the old-format setter", async () => {
		writeLegacySnapshot(LEGACY_ID);
		const resolved = await resolveTaintStatus(depsWith(noDaemon), LEGACY_ID);
		expect(resolved.via).toBe("snapshot");
		expect(resolved.report.session?.set_by).toMatchObject({
			file: "<command-output>",
			inferred: true,
		});
	});

	it("P3: with no session id, the snapshot fallback lists the tainted sessions", async () => {
		writeLegacySnapshot(LEGACY_ID);
		const resolved = await resolveTaintStatus(depsWith(noDaemon), undefined);
		expect(resolved.report.sessions?.map((view) => view.session_id)).toEqual([LEGACY_ID]);
	});
});

describe("resolveTaintStatus — negative (must not fire)", () => {
	it("N1: an unknown session with no daemon is refused, not invented", async () => {
		const resolved = await resolveTaintStatus(depsWith(noDaemon), "nope");
		expect(resolved.report.ok).toBe(false);
		expect(resolved.report.session).toBeUndefined();
	});
});

describe("resolveTaintClear — positive (must fire)", () => {
	it("P1: the daemon report is used verbatim and nothing is written locally", async () => {
		writeLegacySnapshot(LEGACY_ID);
		const query = vi.fn(() =>
			Promise.resolve<TaintControlReport>({
				ok: true,
				cleared: {
					session_id: LEGACY_ID,
					previous_level: "Confidential",
					previous_step_limit: 10_000,
					new_level: "Public",
					new_step_limit: null,
					set_by: "<command-output>",
					set_by_inferred: true,
					reason: "fp",
					applied_to: ["daemon-memory", "live-snapshot"],
				},
			}),
		);
		const resolved = await resolveTaintClear(depsWith(query), {
			sessionId: LEGACY_ID,
			reason: "fp",
		});
		expect(resolved.via).toBe("daemon");
		expect(resolved.report.cleared?.applied_to).toEqual(["daemon-memory", "live-snapshot"]);
		// The CLI must not double-write: the daemon already persisted.
		expect(storedLevel(LEGACY_ID)).toBe("Confidential");
	});

	it("P2: with no daemon, the snapshot is cleared atomically", async () => {
		writeLegacySnapshot(LEGACY_ID);
		const resolved = await resolveTaintClear(depsWith(noDaemon), {
			sessionId: LEGACY_ID,
			reason: "operator review",
		});
		expect(resolved.via).toBe("snapshot");
		expect(resolved.report.cleared).toMatchObject({
			previous_level: "Confidential",
			applied_to: ["live-snapshot"],
			set_by: "<command-output>",
		});
		expect(storedLevel(LEGACY_ID)).toBe("Public");
	});
});

describe("resolveTaintClear — negative (must not fire)", () => {
	it("N1: an unknown session is refused with nothing written", async () => {
		const resolved = await resolveTaintClear(depsWith(noDaemon), {
			sessionId: "nope",
			reason: "r",
		});
		expect(resolved.report.ok).toBe(false);
		expect(resolved.report.cleared).toBeUndefined();
	});
});
