import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUERY_SOURCES, resolveTarget } from "./sources.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "il-query-src-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("QUERY_SOURCES", () => {
	it("declares a file, fields, and hint for every source", () => {
		expect(QUERY_SOURCES.length).toBeGreaterThanOrEqual(10);
		for (const source of QUERY_SOURCES) {
			expect(source.name).toMatch(/^[a-z][a-z0-9-]*$/);
			expect(source.file).toMatch(/\.jsonl$/);
			expect(source.fields.length).toBeGreaterThan(0);
			expect(source.hint.length).toBeGreaterThan(0);
		}
	});

	it("keeps source names unique", () => {
		const names = QUERY_SOURCES.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
	});

	// test-contract: mutation-kill — pins every name/file/where/fields/hint literal in the
	// catalog by full deep-equal, so any StringLiteral (→"") or ArrayDeclaration (→[] /
	// →["Stryker was here"]) mutation anywhere inside QUERY_SOURCES changes this value.
	it("matches the exact catalog values for every source, in order", () => {
		expect(QUERY_SOURCES.slice(0, 12)).toEqual([
			{
				name: "blocks",
				file: "activity.jsonl",
				where: ["type=guard_block"],
				fields: ["tool", "guard_rule_id", "summary"],
				hint: "what the guard refused, with rule ids",
			},
			{
				name: "guards",
				file: "activity.jsonl",
				where: ["type~=guard_"],
				fields: ["type", "tool", "guard_rule_id", "summary"],
				hint: "every guard verdict (block/warn/allow)",
			},
			{
				name: "checks",
				file: "check-results.jsonl",
				where: [],
				fields: ["tool", "decision", "checks.id"],
				hint: "per-edit check outcomes (try --by checks.id)",
			},
			{
				name: "recurrences",
				file: "recurrences.jsonl",
				where: [],
				fields: ["kind", "check_id", "file"],
				hint: "repeating catches (try --by check_id)",
			},
			{
				name: "costs",
				file: "costs.jsonl",
				where: [],
				fields: ["session_id", "model", "output_tokens"],
				hint: "token spend (try --by session_id --sum output_tokens)",
			},
			{
				name: "events",
				file: "collection.jsonl",
				where: ["kind=tool_event"],
				fields: ["phase", "provider", "provider_tool"],
				hint: "canonical cross-runner tool events",
			},
			{
				name: "agents",
				file: "collection.jsonl",
				where: ["kind=agent_event"],
				fields: ["agent_name", "action"],
				hint: "subagent lifecycle + captured results",
			},
			{
				name: "thinking",
				file: "timeline.jsonl",
				where: ["category=agent_thinking"],
				fields: ["text"],
				hint: "captured agent reasoning",
			},
			{
				name: "messages",
				file: "timeline.jsonl",
				where: ["category=agent_message"],
				fields: ["text"],
				hint: "agent-emitted messages",
			},
			{
				name: "tests",
				file: "tests.jsonl",
				where: [],
				fields: ["kind", "outcome", "command"],
				hint: "verification runs (vitest/tsc/lint/build)",
			},
			{
				name: "reservations",
				file: "reservation-events.jsonl",
				where: [],
				fields: ["action", "file", "agent_name"],
				hint: "multi-agent file leases (grant/release/conflict)",
			},
			{
				name: "suggestions",
				file: "suggestion-telemetry.jsonl",
				where: [],
				fields: ["check", "file", "score", "shown"],
				hint: "scored advisory findings",
			},
		]);
	});
});

describe("resolveTarget", () => {
	it("resolves a known source name to its data-dir file", () => {
		const resolved = resolveTarget("blocks", undefined, dir);
		expect(resolved?.file).toBe(join(dir, ".interlinked", "activity.jsonl"));
		expect(resolved?.source?.where).toEqual(["type=guard_block"]);
	});

	it("returns undefined with no target (catalog mode)", () => {
		expect(resolveTarget(undefined, undefined, dir)).toBeUndefined();
	});

	it("prefers an explicit --file over the positional source", () => {
		const explicit = join(dir, "some.jsonl");
		writeFileSync(explicit, "{}\n");
		const resolved = resolveTarget("blocks", explicit, dir);
		expect(resolved?.file).toBe(explicit);
		expect(resolved?.source).toBeUndefined();
	});

	it("resolves a bare .jsonl basename against the data dir", () => {
		writeFileSync(join(dir, ".interlinked", "custom.jsonl"), "{}\n");
		const resolved = resolveTarget("custom.jsonl", undefined, dir);
		expect(resolved?.file).toBe(join(dir, ".interlinked", "custom.jsonl"));
	});

	it("resolves a relative .jsonl path against cwd first", () => {
		writeFileSync(join(dir, "local.jsonl"), "{}\n");
		const resolved = resolveTarget("local.jsonl", undefined, dir);
		expect(resolved?.file).toBe(join(dir, "local.jsonl"));
	});

	it("throws with the catalog when the source name is unknown", () => {
		expect(() => resolveTarget("nonsense", undefined, dir)).toThrow(/Unknown source "nonsense"/);
		expect(() => resolveTarget("nonsense", undefined, dir)).toThrow(/blocks/);
	});

	it("throws when a .jsonl path exists nowhere", () => {
		expect(() => resolveTarget("ghost.jsonl", undefined, dir)).toThrow(/No such file/);
	});

	// test-contract: mutation-kill — an empty-string --file must be treated the same as
	// "not provided" (falls through to the target check below), not as a truthy path.
	// Kills the `fileOpt !== ""` sub-expression mutant (→true) and its "" StringLiteral
	// mutant: both would make fileOpt="" take the --file branch and return a defined
	// ResolvedTarget instead of falling through to undefined (target is also absent here).
	it("treats an empty --file as not provided, not as a real path", () => {
		expect(resolveTarget(undefined, "", dir)).toBeUndefined();
	});

	// test-contract: mutation-kill — an empty-string target must be treated the same as
	// "no target" (catalog mode), not as a real source name to look up. Kills the
	// `target === ""` sub-expression mutant (→false) and its "" StringLiteral mutant:
	// both would skip the early return and fall through to the unknown-source throw
	// instead of returning undefined.
	it("treats an empty target as catalog mode, not an unknown source", () => {
		expect(resolveTarget("", undefined, dir)).toBeUndefined();
	});

	// test-contract: mutation-kill — the known-sources list in the error message must be
	// joined with ", " (comma + space). Kills the `.join(", ")` separator StringLiteral
	// mutant (→""): a plain /blocks/ substring check still matches the mutant's
	// concatenated "blocksguardschecks..." run, so the separator itself must be asserted.
	it("joins the known-sources list with a comma and space", () => {
		expect(() => resolveTarget("totally-unknown-xyz", undefined, dir)).toThrow(
			/blocks, guards, checks, recurrences, costs, events, agents, thinking, messages, tests, reservations, suggestions/,
		);
	});
});
