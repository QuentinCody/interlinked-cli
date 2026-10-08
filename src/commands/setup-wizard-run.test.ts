// Companion for setup-wizard-run.ts — the prompt/wiring layer. The pure
// decision flow is pinned in setup-wizard.test.ts; here we pin what this
// layer owns: the real-deps wiring shape and the non-interactive env mapping.
// The readline prompt loop itself is exercised manually (it is I/O glue over
// the tested applyWizardChoices path).

import { describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({ question: vi.fn<() => Promise<string>>(), close: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: () => prompts }));
vi.mock("../lib/settings.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/settings.js")>(),
	detectClients: () => [],
}));

vi.mock("./adopt.js", () => ({ adoptCommand: vi.fn(async () => {}) }));
vi.mock("./caps.js", () => ({ capsSetAction: vi.fn(async () => 0) }));
vi.mock("./enable.js", () => ({ enableCommand: vi.fn(async () => {}) }));
vi.mock("./mode.js", () => ({ modeCommand: vi.fn(async () => {}) }));

import { adoptCommand } from "./adopt.js";
import { capsSetAction } from "./caps.js";
import { enableCommand } from "./enable.js";
import { modeCommand } from "./mode.js";
import { EventEmitter } from "node:events";
import {
	realWizardDeps,
	renderedLineCount,
	runSetupWizardInteractive,
	runSetupWizardNonInteractive,
	selectFromList,
} from "./setup-wizard-run.js";

it("closes the interactive prompt and leaves configuration unapplied when the plan is declined", async () => {
	const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.mocked(enableCommand).mockClear();
	prompts.close.mockClear();
	prompts.question.mockResolvedValueOnce("balanced").mockResolvedValueOnce("whole-file")
		.mockResolvedValueOnce("").mockResolvedValueOnce("no").mockResolvedValueOnce("off")
		.mockResolvedValueOnce("no");
	try {
		await runSetupWizardInteractive("/repo");
		expect(prompts.close).toHaveBeenCalledExactlyOnceWith();
		expect(enableCommand).not.toHaveBeenCalled();
		expect(log.mock.calls.flat().join("\n")).toContain("Aborted");
	} finally {
		log.mockRestore();
		if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
		else Reflect.deleteProperty(process.stdin, "isTTY");
	}
});

describe("renderedLineCount — positive (must fire)", () => {
	// test-contract: public-api — a row wider than the terminal occupies ceil(width/columns) screen lines
	it("P1: a 150-char row at 100 columns renders as 2 lines", () => {
		expect(renderedLineCount("x".repeat(150), 100)).toBe(2);
	});

	// test-contract: public-api — ANSI colour codes take no columns, so they never add lines
	it("P2: colour codes are stripped before measuring", () => {
		const row = `\x1b[32m${"x".repeat(100)}\x1b[0m`;
		expect(renderedLineCount(row, 100)).toBe(1);
	});
});

describe("renderedLineCount — negative (must not fire)", () => {
	// test-contract: boundary — a row exactly as wide as the terminal is one line, an empty row is still one line
	it("N1: a row that fits, or is empty, is exactly one line", () => {
		expect(renderedLineCount("x".repeat(100), 100)).toBe(1);
		expect(renderedLineCount("", 100)).toBe(1);
	});

	// test-contract: boundary — an unknown width (non-TTY, zero) falls back to 80 columns instead of dividing by zero
	it("N2: a missing or zero column count falls back to 80", () => {
		expect(renderedLineCount("x".repeat(81), undefined)).toBe(2);
		expect(renderedLineCount("x".repeat(81), 0)).toBe(2);
	});
});

describe("selectFromList redraw — wrapped rows (F-B1)", () => {
	interface FakeStdin extends EventEmitter {
		isTTY: boolean;
		isRaw: boolean;
		setRawMode: (mode: boolean) => FakeStdin;
		resume: () => FakeStdin;
	}

	function fakeStdin(): FakeStdin {
		// SAFETY: every FakeStdin member is assigned on the next lines before the
		// emitter is handed out; the cast only names the shape selectFromList reads.
		const em = new EventEmitter() as FakeStdin;
		em.isTTY = true;
		em.isRaw = false;
		em.setRawMode = (mode) => {
			em.isRaw = mode;
			return em;
		};
		em.resume = () => em;
		return em;
	}

	async function driveSelect(columns: number, rowWidth: number): Promise<string> {
		const stdin = fakeStdin();
		const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
		const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
		const out: string[] = [];
		// SAFETY: selectFromList only ever calls write(string); the recorder
		// ignores the encoding/callback overloads, so widening it to the full
		// Writable.write signature cannot be observed.
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);
		try {
			const picked = selectFromList({
				labels: ["a", "b", "c"],
				renderLine: (i, sel) => `${sel ? "› " : "  "}${String(i).repeat(rowWidth - 2)}`,
				initial: 0,
			});
			stdin.emit("data", Buffer.from("\x1b[B"));
			stdin.emit("data", Buffer.from("\r"));
			expect(await picked).toBe(1);
			return out.join("");
		} finally {
			write.mockRestore();
			if (stdinDesc) Object.defineProperty(process, "stdin", stdinDesc);
			if (colsDesc) Object.defineProperty(process.stdout, "columns", colsDesc);
			else Reflect.deleteProperty(process.stdout, "columns");
		}
	}

	// test-contract: regression — three 150-char rows at 100 columns occupy 6 lines plus the 1-line hint; the redraw must climb all 7, not 3
	it("P1: climbs over every wrapped screen line before redrawing", async () => {
		const out = await driveSelect(100, 150);
		expect(out).toContain("\x1b[7A");
		expect(out).not.toContain("\x1b[3A");
	});

	// test-contract: boundary — rows that fit keep the one-line-per-row climb (3 rows + hint = 4)
	it("N1: rows narrower than the terminal climb one line each", async () => {
		const out = await driveSelect(100, 40);
		expect(out).toContain("\x1b[4A");
		expect(out).not.toContain("\x1b[7A");
	});
});

describe("realWizardDeps — positive (must wire to the owning commands)", () => {
	// test-contract: public-api — each wizard step routes to the command that owns that decision, with the wizard's no-double-confirm mode flag
	it("P1: applyMode forwards to modeCommand with force (plan already confirmed once)", async () => {
		await realWizardDeps().applyMode("strict");
		expect(vi.mocked(modeCommand).mock.calls[0]?.[0]).toBe("strict");
		expect(vi.mocked(modeCommand).mock.calls[0]?.[1]).toMatchObject({ force: true });
	});

	// test-contract: public-api — setCap stringifies through the caps command (its CLI signature), not a private writer
	it("P2: setCap routes through capsSetAction with a string value", async () => {
		await realWizardDeps().setCap("cyclomatic", 15);
		expect(vi.mocked(capsSetAction).mock.calls[0]?.[0]).toBe("cyclomatic");
		expect(vi.mocked(capsSetAction).mock.calls[0]?.[1]).toBe("15");
	});
});

describe("runSetupWizardNonInteractive — positive/negative", () => {
	// test-contract: public-api — env vars drive the bootstrap: clients + sync mode reach enable, adopt honors its flag
	it("P3: INTERLINKED_* env maps into the applied choices", async () => {
		vi.mocked(enableCommand).mockClear();
		vi.mocked(adoptCommand).mockClear();
		await runSetupWizardNonInteractive(
			{ INTERLINKED_CLIENTS: "claude,codex", INTERLINKED_ADOPT: "false" },
			"/repo",
		);
		expect(vi.mocked(enableCommand).mock.calls[0]?.[0]).toMatchObject({
			clients: "claude,codex",
			syncMode: "local",
		});
		expect(vi.mocked(adoptCommand)).not.toHaveBeenCalled();
	});

	// test-contract: boundary — an empty environment still bootstraps with the local-first defaults and never throws
	it("N1: empty env bootstraps with defaults (local sync, adopt on)", async () => {
		vi.mocked(enableCommand).mockClear();
		vi.mocked(adoptCommand).mockClear();
		await runSetupWizardNonInteractive({}, "/repo");
		expect(vi.mocked(enableCommand).mock.calls[0]?.[0]).toMatchObject({ syncMode: "local" });
		expect(vi.mocked(adoptCommand)).toHaveBeenCalledTimes(1);
	});
});
