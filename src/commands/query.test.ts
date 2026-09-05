import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type QueryParams, queryCommand, runQuery } from "./query.js";

let dir: string;
let logs: string[];
let errors: string[];

function baseParams(overrides: Partial<QueryParams> = {}): QueryParams {
	return {
		clauses: [],
		budget: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
		limit: 20,
		...overrides,
	};
}

function writeFixtures(root: string): string {
	const dataDir = join(root, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
	const activity = [
		{ ts: "2026-07-24T10:00:00Z", type: "tool_use", tool: "Bash", summary: "ls" },
		{
			ts: "2026-07-24T10:01:00Z",
			type: "guard_block",
			tool: "Bash",
			guard_rule_id: "builtin-rm-rf",
			summary: "rm -rf blocked",
		},
		{
			ts: "2026-07-24T10:02:00Z",
			type: "guard_warn",
			tool: "Write",
			guard_rule_id: "w1",
			summary: "warned",
		},
		{
			ts: "2026-07-24T10:03:00Z",
			type: "guard_block",
			tool: "Write",
			guard_rule_id: "builtin-protected",
			summary: "protected file",
		},
	];
	writeFileSync(
		join(dataDir, "activity.jsonl"),
		`${activity.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	const checks = [
		{ ts: "2026-07-24T09:00:00Z", checks: [{ id: "a" }, { id: "b" }] },
		{ ts: "2026-07-24T09:01:00Z", checks: [{ id: "a" }] },
	];
	writeFileSync(
		join(dataDir, "check-results.jsonl"),
		`${checks.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	const costs = [
		{ ts: "2026-07-24T08:00:00Z", session_id: "s1", output_tokens: 100 },
		{ ts: "2026-07-24T08:01:00Z", session_id: "s2", output_tokens: 900 },
		{ ts: "2026-07-24T08:02:00Z", session_id: "s1", output_tokens: 50 },
	];
	writeFileSync(
		join(dataDir, "costs.jsonl"),
		`${costs.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return dataDir;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "il-query-cmd-"));
	writeFixtures(dir);
	logs = [];
	errors = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("runQuery", () => {
	it("filters rows and returns them in chronological order", () => {
		const result = runQuery(join(dir, ".interlinked", "activity.jsonl"), {
			...baseParams(),
			clauses: [{ path: "type", op: "=", value: "guard_block" }],
		});
		expect(result.rows.map((r) => r.guard_rule_id)).toEqual([
			"builtin-rm-rf",
			"builtin-protected",
		]);
		expect(result.stats.truncated).toBe(false);
		// A full scan that never hit the limit must not be reported as limit-stopped.
		expect(result.limitStopped).toBe(false);
	});

	it("aggregates with --by across array fan-out", () => {
		const result = runQuery(join(dir, ".interlinked", "check-results.jsonl"), {
			...baseParams({ by: "checks.id" }),
		});
		expect(result.aggregate).toEqual([
			{ key: "a", count: 2 },
			{ key: "b", count: 1 },
		]);
	});

	it("sums with --by --sum", () => {
		const result = runQuery(join(dir, ".interlinked", "costs.jsonl"), {
			...baseParams({ by: "session_id", sum: "output_tokens" }),
		});
		expect(result.aggregate).toEqual([
			{ key: "s2", count: 1, sum: 900 },
			{ key: "s1", count: 2, sum: 150 },
		]);
	});

	it("filters by event time while scanning the complete bounded append history", () => {
		const result = runQuery(join(dir, ".interlinked", "activity.jsonl"), {
			...baseParams({ sinceMs: Date.parse("2026-07-24T10:02:00Z") }),
		});
		expect(result.rows.map((r) => r.ts)).toEqual([
			"2026-07-24T10:02:00Z",
			"2026-07-24T10:03:00Z",
		]);
		expect(result.sinceStopped).toBe(false);
		expect(result.stats.recordsParsed).toBe(4);
		// Historical timestamps do not prove that earlier appends are older.
		expect(result.limitStopped).toBe(false);
	});

	it("stops early once --limit rows match", () => {
		const result = runQuery(join(dir, ".interlinked", "activity.jsonl"), {
			...baseParams({ limit: 1 }),
			clauses: [{ path: "type", op: "=", value: "guard_block" }],
		});
		expect(result.rows.map((r) => r.guard_rule_id)).toEqual(["builtin-protected"]);
		expect(result.limitStopped).toBe(true);
	});
});

describe("queryCommand", () => {
	it("prints the source catalog when no target is given", async () => {
		await queryCommand(undefined, { cwd: dir });
		const joined = logs.join("\n");
		expect(joined).toContain("blocks");
		expect(joined).toContain("Examples");
	});

	it("prints the full catalog body: header, per-source hints, examples, and scan note", async () => {
		await queryCommand(undefined, { cwd: dir });
		const joined = logs.join("\n");
		expect(joined).toContain("interlinked query <source>");
		// Only rendered by the per-source loop body — proves the loop actually ran.
		expect(joined).toContain("what the guard refused, with rule ids");
		expect(joined).toContain("interlinked query blocks --limit 10");
		expect(joined).toContain("interlinked query checks --by checks.id --since 7d");
		expect(joined).toContain("interlinked query costs --by session_id --sum output_tokens");
		expect(joined).toContain("interlinked query recurrences --by check_id --last 50000");
		expect(joined).toContain("interlinked query .interlinked/tests.jsonl --where kind=vitest");
		expect(joined).toContain(
			"Scans are bounded (default: newest 20k records / 64 MB tail); the footer always says how much was scanned.",
		);
		expect(joined).not.toContain("Stryker was here");
		// Real multi-line output, not everything joined onto one line.
		expect(joined.split("\n").length).toBeGreaterThan(10);
	});

	it("right-pads catalog name/file columns to the widest entry (Math.max, not Math.min)", async () => {
		await queryCommand(undefined, { cwd: dir });
		// Stripping ANSI color codes.
		const stripped = logs.join("\n").replace(/\x1b\[[0-9]+m/g, "");
		// The shared catalog can grow; its file and description columns must
		// stay aligned for short and long names rather than pinning old widths.
		const costRow = stripped.split("\n").find((line) => /^ {2}costs +/.test(line)) ?? "";
		const reservationRow = stripped.split("\n").find((line) => /^ {2}reservations +/.test(line)) ?? "";
		expect(costRow.indexOf("costs.jsonl")).toBe(reservationRow.indexOf("reservation-events.jsonl"));
		expect(costRow.indexOf("token spend")).toBe(reservationRow.indexOf("multi-agent file leases"));
		expect(costRow.indexOf("costs.jsonl")).toBeGreaterThan("  reservations  ".length);
	});

	it("errors with the known-source list on an unknown source", async () => {
		await queryCommand("nonsense", { cwd: dir });
		expect(errors.join("\n")).toContain('Unknown source "nonsense"');
		expect(process.exitCode).toBe(1);
	});

	it("errors helpfully when the source log does not exist", async () => {
		await queryCommand("recurrences", { cwd: dir });
		expect(errors.join("\n")).toContain("No recurrences log");
		expect(process.exitCode).toBe(1);
	});

	it("rejects --sum without --by", async () => {
		await queryCommand("costs", { cwd: dir, sum: "output_tokens" });
		expect(errors.join("\n")).toContain("--sum requires --by");
		expect(process.exitCode).toBe(1);
	});

	it("emits a JSON envelope with rows and scan stats", async () => {
		await queryCommand("blocks", { cwd: dir, json: true });
		const payload = JSON.parse(logs.join("\n")) as {
			source: string;
			rows: Array<{ guard_rule_id: string }>;
			stats: { recordsParsed: number };
		};
		expect(payload.source).toBe("blocks");
		expect(payload.rows).toHaveLength(2);
		expect(payload.stats.recordsParsed).toBe(4);
	});

	it("emits an aggregate envelope under --by", async () => {
		await queryCommand("costs", { cwd: dir, json: true, by: "session_id", sum: "output_tokens" });
		const payload = JSON.parse(logs.join("\n")) as {
			by: string;
			sum: string;
			aggregate: Array<{ key: string; sum: number }>;
		};
		expect(payload.by).toBe("session_id");
		expect(payload.sum).toBe("output_tokens");
		expect(payload.aggregate[0]).toEqual({ key: "s2", count: 1, sum: 900 });
	});

	it("renders rows plus an honest scan footer in normal mode", async () => {
		await queryCommand("blocks", { cwd: dir });
		const joined = logs.join("\n");
		expect(joined).toContain("builtin-rm-rf");
		expect(joined).toContain("scanned all");
	});

	it("applies user --where on top of the source identity filter", async () => {
		await queryCommand("blocks", { cwd: dir, json: true, where: ["tool=Write"] });
		const payload = JSON.parse(logs.join("\n")) as { rows: Array<{ guard_rule_id: string }> };
		expect(payload.rows.map((r) => r.guard_rule_id)).toEqual(["builtin-protected"]);
	});

	it("queries an explicit .jsonl path with inferred fields", async () => {
		await queryCommand(join(dir, ".interlinked", "costs.jsonl"), { cwd: dir, json: true });
		const payload = JSON.parse(logs.join("\n")) as { rows: unknown[] };
		expect(payload.rows).toHaveLength(3);
	});

	it("rejects an invalid --limit", async () => {
		await queryCommand("blocks", { cwd: dir, limit: "zero" });
		expect(errors.join("\n")).toContain("Invalid --limit");
		expect(process.exitCode).toBe(1);
	});

	it("rejects an invalid --last with the --last flag name in the message", async () => {
		await queryCommand("blocks", { cwd: dir, last: "zero" });
		expect(errors.join("\n")).toContain("Invalid --last");
		expect(process.exitCode).toBe(1);
	});

	it("rejects an invalid --max-mb with the --max-mb flag name in the message", async () => {
		await queryCommand("blocks", { cwd: dir, maxMb: "zero" });
		expect(errors.join("\n")).toContain("Invalid --max-mb");
		expect(process.exitCode).toBe(1);
	});

	it("threads --last into the record scan budget", async () => {
		await queryCommand("blocks", { cwd: dir, json: true, last: "1" });
		const payload = JSON.parse(logs.join("\n")) as {
			stats: { recordsParsed: number; truncated: boolean };
		};
		expect(payload.stats.recordsParsed).toBe(1);
		expect(payload.stats.truncated).toBe(true);
	});

	it("threads --max-mb into the byte scan budget", async () => {
		await queryCommand("blocks", { cwd: dir, json: true, maxMb: "0.0001" });
		const payload = JSON.parse(logs.join("\n")) as {
			rows: unknown[];
			stats: { truncated: boolean };
		};
		// 0.0001 MB * (1024*1024) rounds to 105 bytes — nonzero, so the tiny
		// fixture file (a few hundred bytes) still reads through in one shot
		// and is not truncated. An incorrect MB→byte multiplier (e.g. 1 instead
		// of 1024*1024) rounds 0.0001 down to a 0-byte budget, which stops the
		// scan before it reads anything.
		expect(payload.rows).toHaveLength(2);
		expect(payload.stats.truncated).toBe(false);
	});

	it("accepts a valid numeric --limit", async () => {
		await queryCommand("blocks", { cwd: dir, json: true, limit: "1" });
		const payload = JSON.parse(logs.join("\n")) as { rows: unknown[] };
		expect(payload.rows).toHaveLength(1);
	});

	it("applies an explicit --fields list over the source default", async () => {
		await queryCommand("blocks", { cwd: dir, fields: " tool , summary " });
		const joined = logs.join("\n");
		expect(joined).toContain("Bash");
		expect(joined).not.toContain("builtin-rm-rf");
	});

	it("infers display fields from the first row on an explicit path with no source", async () => {
		await queryCommand(join(dir, ".interlinked", "costs.jsonl"), { cwd: dir });
		const joined = logs.join("\n");
		expect(joined).toContain("s1");
		expect(joined).toContain("100");
	});

	it("uses the source's declared fields (not first-row inference) for a known source", async () => {
		await queryCommand("blocks", { cwd: dir });
		const joined = logs.join("\n");
		// "blocks" declares fields ["tool","guard_rule_id","summary"] — "type" is
		// not among them, so the literal type value must never render even
		// though every matched row's `type` is "guard_block".
		expect(joined).not.toContain("guard_block");
		expect(joined).toContain("builtin-rm-rf");
	});

	it("skips the reserved inferred-field keys (ts/timestamp/schema/schema_version/uuid/seq)", async () => {
		const explicitPath = join(dir, ".interlinked", "skip-fields.jsonl");
		const record = {
			ts: "2031-01-01T00:00:00Z",
			timestamp: "TIMESTAMP_MARK",
			schema: "SCHEMA_MARK",
			schema_version: "SCHEMAVERSION_MARK",
			uuid: "UUID_MARK",
			seq: "SEQ_MARK",
			widget: "WIDGET_MARK",
		};
		writeFileSync(explicitPath, `${JSON.stringify(record)}\n`);
		await queryCommand(explicitPath, { cwd: dir });
		const joined = logs.join("\n");
		expect(joined).toContain("WIDGET_MARK");
		expect(joined).not.toContain("2031-01-01T00:00:00Z");
		expect(joined).not.toContain("TIMESTAMP_MARK");
		expect(joined).not.toContain("SCHEMA_MARK");
		expect(joined).not.toContain("SCHEMAVERSION_MARK");
		expect(joined).not.toContain("UUID_MARK");
		expect(joined).not.toContain("SEQ_MARK");
	});

	it("renders 'no matching records' for an explicit path with zero rows matched", async () => {
		await queryCommand(join(dir, ".interlinked", "costs.jsonl"), {
			cwd: dir,
			where: ["session_id=nonexistent"],
		});
		expect(logs.join("\n")).toContain("no matching records");
	});

	it("threads --since through queryCommand", async () => {
		await queryCommand("blocks", {
			cwd: dir,
			json: true,
			since: "2026-07-24T10:02:30Z",
		});
		const payload = JSON.parse(logs.join("\n")) as { rows: Array<{ ts: string }> };
		expect(payload.rows.map((r) => r.ts)).toEqual(["2026-07-24T10:03:00Z"]);
	});

	it("emits an aggregate envelope with --by and no --sum (no sum key)", async () => {
		await queryCommand("costs", { cwd: dir, json: true, by: "session_id" });
		const payload = JSON.parse(logs.join("\n")) as {
			by: string;
			sum?: string;
			aggregate: Array<{ key: string; count: number }>;
		};
		expect(payload.by).toBe("session_id");
		expect(payload.sum).toBeUndefined();
		expect(payload.aggregate).toEqual([
			{ key: "s1", count: 2 },
			{ key: "s2", count: 1 },
		]);
	});

	it("renders an aggregate table in normal mode", async () => {
		await queryCommand("costs", { cwd: dir, by: "session_id", sum: "output_tokens" });
		const joined = logs.join("\n");
		expect(joined).toContain("s2");
		expect(joined).toContain("900");
	});

	it("shows the limit-stopped footer text when --limit truncates matches", async () => {
		await queryCommand("blocks", { cwd: dir, limit: "1" });
		const joined = logs.join("\n");
		expect(joined).toContain("more may match (raise --limit)");
	});

	it("truncates long cell values in normal mode but shows them in full mode", async () => {
		const longSummary = "y".repeat(200);
		appendFileSync(
			join(dir, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({
				ts: "2026-07-24T10:04:00Z",
				type: "guard_block",
				tool: "Bash",
				guard_rule_id: "long-rule",
				summary: longSummary,
			})}\n`,
		);
		await queryCommand("blocks", { cwd: dir });
		const normalJoined = logs.join("\n");
		expect(normalJoined).toContain("…");
		expect(normalJoined).not.toContain(longSummary);

		logs = [];
		await queryCommand("blocks", { cwd: dir, full: true });
		const fullJoined = logs.join("\n");
		expect(fullJoined).toContain(longSummary);
	});

	it("renders in short mode (body only, no footer)", async () => {
		await queryCommand("blocks", { cwd: dir, short: true });
		const joined = logs.join("\n");
		expect(joined).toContain("builtin-rm-rf");
		expect(joined).not.toContain("scanned all");
	});

	it("renders in full mode (body plus footer, untruncated cells)", async () => {
		await queryCommand("blocks", { cwd: dir, full: true });
		const joined = logs.join("\n");
		expect(joined).toContain("builtin-rm-rf");
		expect(joined).toContain("scanned all");
	});

	it("prints the catalog as JSON when --json is passed with no target", async () => {
		await queryCommand(undefined, { cwd: dir, json: true });
		const payload = JSON.parse(logs.join("\n")) as { sources: Array<{ name: string }> };
		expect(payload.sources.map((s) => s.name)).toContain("blocks");
	});

	it("falls back to process.cwd() when no --cwd is given", async () => {
		await queryCommand("nonsense-source-xyz", {});
		expect(errors.join("\n")).toContain('Unknown source "nonsense-source-xyz"');
		expect(process.exitCode).toBe(1);
	});
});
