import { parseWire, wireString } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const collectCodexSessionsMock = vi.fn<typeof import("../harness/codex-collect.js").collectCodexSessions>();
const codexSessionsDirMock = vi.fn<typeof import("../harness/codex-collect.js").codexSessionsDir>(() => "/mock/codex/sessions");
const parseDurationMock = vi.fn<typeof import("../lib/activity-utils.js").parseDuration>();

vi.mock("../harness/codex-collect.js", () => ({
	collectCodexSessions: (...args: Parameters<typeof collectCodexSessionsMock>) => collectCodexSessionsMock(...args),
	codexSessionsDir: (...args: Parameters<typeof codexSessionsDirMock>) => codexSessionsDirMock(...args),
}));

vi.mock("../lib/activity-utils.js", () => ({
	parseDuration: (...args: Parameters<typeof parseDurationMock>) => parseDurationMock(...args),
}));

import { registerCollectCommand } from "./collect.js";

function buildProgram(): { program: Command; cmd: Command } {
	const program = new Command();
	program.exitOverride();
	registerCollectCommand(program);
	const cmd = program.commands.find((c) => c.name() === "collect");
	if (!cmd) throw new Error("collect command not registered");
	return { program, cmd };
}

async function runCollect(args: string[]): Promise<void> {
	const { program } = buildProgram();
	await program.parseAsync(["node", "test", "collect", ...args]);
}

describe("collect command", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: string | number | undefined | null;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
		collectCodexSessionsMock.mockReset();
		collectCodexSessionsMock.mockReturnValue({ files: 3, sessions: 2, added: 5, parsed: 5 });
		codexSessionsDirMock.mockClear();
		parseDurationMock.mockReset();
		parseDurationMock.mockReturnValue(1000);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
		process.exitCode = savedExitCode ?? undefined;
	});

	// bfe9898de7931d7b: reportCollectError's `ok: false` -> `ok: true`
	it("emits ok:false in the json error envelope for an unsupported provider", async () => {
		await runCollect(["--provider", "bogus", "--json"]);
		const parsed = JSON.parse(parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value"));
		expect(parsed.ok).toBe(false);
		expect(typeof parsed.error).toBe("string");
	});

	it("reports a destination-timeline refusal instead of claiming collection succeeded", async () => {
		collectCodexSessionsMock.mockImplementation(() => {
			throw new Error("timeline contains a malformed row");
		});

		await runCollect(["--json"]);

		const parsed = JSON.parse(parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value"));
		expect(parsed).toEqual({ ok: false, error: "timeline contains a malformed row" });
		expect(process.exitCode).toBe(2);
	});

	// StringLiteral mutants on the command/description/option metadata
	it("registers the exact description and option help text", () => {
		const { cmd } = buildProgram();
		expect(cmd.description()).toBe("Sync external model sessions (Codex) into .interlinked/timeline.jsonl");
		const descriptions = cmd.options.map((o) => o.description);
		expect(descriptions).toContain("model provider to collect");
		expect(descriptions).toContain("only sessions modified within this window (e.g. 24h, 7d)");
		expect(descriptions).toContain("override the source sessions directory");
		expect(descriptions).toContain("report counts without writing");
		expect(descriptions).toContain("machine-readable output");
		expect(descriptions).toContain("working directory whose .interlinked/timeline.jsonl receives the records");
	});

	// 7c042b165641cafd: `provider === "claude" || provider === "claude-code"` -> true
	it("gives a generic unknown-provider message for a non-claude, non-codex provider", async () => {
		await runCollect(["--provider", "foo", "--json"]);
		const parsed = JSON.parse(parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value"));
		expect(parsed.error).toBe('Unknown provider "foo". Supported: codex.');
	});

	it("gives the claude-specific message only for claude/claude-code providers", async () => {
		await runCollect(["--provider", "claude", "--json"]);
		const parsed = JSON.parse(parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value"));
		expect(parsed.error).toMatch(/Claude sessions are already captured/);
	});

	// b950bcc693774eb0: Date.now() - parseDuration(...) -> Date.now() + parseDuration(...)
	it("computes sinceMs by subtracting the parsed duration from now", async () => {
		const fixedNow = 1_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		parseDurationMock.mockReturnValue(12345);
		await runCollect(["--since", "24h"]);
		const callArg = collectCodexSessionsMock.mock.calls[0]![0];
		expect(callArg.sinceMs).toBe(fixedNow - 12345);
		vi.restoreAllMocks();
	});

	// 1178d3f428fae27e / d1e72faa9a5dd056 / 945b0a54f54c3dfd: sinceMs !== undefined guard around the spread
	it("omits sinceMs entirely when --since is not passed", async () => {
		await runCollect([]);
		const callArg = collectCodexSessionsMock.mock.calls[0]![0];
		expect(Object.prototype.hasOwnProperty.call(callArg, "sinceMs")).toBe(false);
	});

	it("includes sinceMs when --since is passed", async () => {
		parseDurationMock.mockReturnValue(500);
		await runCollect(["--since", "1h"]);
		const callArg = collectCodexSessionsMock.mock.calls[0]![0];
		expect(Object.prototype.hasOwnProperty.call(callArg, "sinceMs")).toBe(true);
		expect(typeof callArg.sinceMs).toBe("number");
	});

	// 0b11a0443c28169b: `if (opts.json)` -> true
	it("prints human-readable text, not json, when --json is not passed", async () => {
		await runCollect([]);
		const output = parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value");
		expect(output.startsWith("{")).toBe(false);
		expect(output).toContain("codex: scanned");
	});

	// b7888f3068b120e4 / 5cad4d781165d345 / 55fcf277d9c91901 / 5732831b8fbd21f5: opts.dryRun === true
	it("passes dryRun:true through to collectCodexSessions when --dry-run is set", async () => {
		await runCollect(["--dry-run"]);
		const callArg = collectCodexSessionsMock.mock.calls[0]![0];
		expect(callArg.dryRun).toBe(true);
	});

	it("passes dryRun:false through to collectCodexSessions when --dry-run is not set", async () => {
		await runCollect([]);
		const callArg = collectCodexSessionsMock.mock.calls[0]![0];
		expect(callArg.dryRun).toBe(false);
	});

	it("reports dryRun:true in the json envelope when --dry-run --json are set", async () => {
		await runCollect(["--dry-run", "--json"]);
		const parsed = JSON.parse(parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value"));
		expect(parsed.dryRun).toBe(true);
	});

	// 1f325f86e5e18244: "added" -> ""
	it("uses the word 'added' (not 'would add') when --dry-run is not set", async () => {
		collectCodexSessionsMock.mockReturnValue({ files: 1, sessions: 1, added: 3, parsed: 3 });
		await runCollect([]);
		const output = parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value");
		expect(output).toContain("added 3 new record(s)");
		expect(output).not.toContain("would add");
	});

	it("uses the phrase 'would add' when --dry-run is set", async () => {
		collectCodexSessionsMock.mockReturnValue({ files: 1, sessions: 1, added: 3, parsed: 3 });
		await runCollect(["--dry-run"]);
		const output = parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value");
		expect(output).toContain("would add 3 new record(s)");
	});

	// e1a7234a2a50639d / 98625588acf18463: the scanned/verb template literals -> ``
	it("prints the full scanned-files summary sentence", async () => {
		collectCodexSessionsMock.mockReturnValue({ files: 7, sessions: 4, added: 2, parsed: 9 });
		await runCollect([]);
		const output = parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value");
		expect(output).toBe(
			"codex: scanned 7 rollout file(s) across 4 session(s); added 2 new record(s) to .interlinked/timeline.jsonl (parsed 9).",
		);
	});

	// a8293187ba7e7b0f / 1b94a563a502b3a8 / 8907a798afd2e076 / cfd880b8212687bf / f0fc0c3bb84c9459:
	// `result.added === 0 && !opts.dryRun`
	it("prints 'timeline already up to date' when added is 0 and not a dry run", async () => {
		collectCodexSessionsMock.mockReturnValue({ files: 1, sessions: 1, added: 0, parsed: 1 });
		await runCollect([]);
		const messages = logSpy.mock.calls.map((c: unknown[]) => c[0]);
		expect(messages).toContain("timeline already up to date.");
	});

	it("does not print 'already up to date' when added is 0 but it IS a dry run", async () => {
		collectCodexSessionsMock.mockReturnValue({ files: 1, sessions: 1, added: 0, parsed: 1 });
		await runCollect(["--dry-run"]);
		const messages = logSpy.mock.calls.map((c: unknown[]) => c[0]);
		expect(messages).not.toContain("timeline already up to date.");
	});

	it("does not print 'already up to date' when added is nonzero and not a dry run", async () => {
		collectCodexSessionsMock.mockReturnValue({ files: 1, sessions: 1, added: 4, parsed: 4 });
		await runCollect([]);
		const messages = logSpy.mock.calls.map((c: unknown[]) => c[0]);
		expect(messages).not.toContain("timeline already up to date.");
	});
});
