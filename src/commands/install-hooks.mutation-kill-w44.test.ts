import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks for every module install-hooks.ts touches, so calling
// installHooksCommand never performs real filesystem/process side effects. ----

const installHooksMock: any = vi.fn();
const manifestPathMock: any = vi.fn(() => "/fake/manifest.json");
vi.mock("../harness/installer.js", () => ({
	installHooks: (...args: any[]) => (installHooksMock as any)(...args),
	manifestPath: (...args: any[]) => (manifestPathMock as any)(...args),
}));

const resolveHookBinaryPathMock: any = vi.fn(() => "/fake/binary");
vi.mock("../lib/hooks.js", () => ({
	resolveHookBinaryPath: (...args: any[]) => (resolveHookBinaryPathMock as any)(...args),
}));

const writeModeMock: any = vi.fn(() => true);
vi.mock("./mode.js", () => ({
	writeMode: (...args: any[]) => (writeModeMock as any)(...args),
}));

const existsSyncMock: any = vi.fn(() => false);
const mkdirSyncMock: any = vi.fn();
const writeFileSyncMock: any = vi.fn();
const readSyncMock: any = vi.fn(() => {
	throw new Error("no stdin in test");
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (...args: any[]) => (existsSyncMock as any)(...args),
		mkdirSync: (...args: any[]) => (mkdirSyncMock as any)(...args),
		writeFileSync: (...args: any[]) => (writeFileSyncMock as any)(...args),
		readSync: (...args: any[]) => (readSyncMock as any)(...args),
	};
});

const { installHooksCommand, parseModeChoice } = await import("./install-hooks.js");
const { ALL_PRESETS } = await import("../harness/modes.js");

function defaultInstallResult() {
	return {
		ok: true,
		post_install_failures: [],
		entries: [],
		skipped: [],
		manifest_path: "/fake/manifest.json",
		purged: 0,
		foreign: 0,
		orphans_cleaned: [],
	};
}

let stdoutSpy: any;
let stderrSpy: any;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
	installHooksMock.mockReturnValue(defaultInstallResult());
	manifestPathMock.mockReturnValue("/fake/manifest.json");
	resolveHookBinaryPathMock.mockReturnValue("/fake/binary");
	existsSyncMock.mockReturnValue(false);
	readSyncMock.mockImplementation(() => {
		throw new Error("no stdin in test");
	});
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
	process.exitCode = undefined;
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	Object.defineProperty(process.stdin, "isTTY", {
		value: originalIsTTY,
		configurable: true,
	});
});

function stderrText(): string {
	return stderrSpy.mock.calls.map((c: any[]) => String(c[0])).join("");
}

function stdoutText(): string {
	return stdoutSpy.mock.calls.map((c: any[]) => String(c[0])).join("");
}

describe("installHooksCommand — writeFallback / cloud payload (mutant 443f179686121f46, 761fef2b4e64df52)", () => {
	it("passes writeFallback: true to resolveHookBinaryPath when not a dry run", async () => {
		await installHooksCommand({ mode: "balanced", json: true, dryRun: false });
		expect(resolveHookBinaryPathMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ writeFallback: true }),
		);
	});

	it("passes writeFallback: false to resolveHookBinaryPath during a dry run", async () => {
		await installHooksCommand({ mode: "balanced", json: true, dryRun: true });
		expect(resolveHookBinaryPathMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ writeFallback: false }),
		);
	});

	it("emits cloud: null (not omitted) in JSON output when no cloud option given", async () => {
		await installHooksCommand({ mode: "balanced", json: true, dryRun: true });
		const printed = stdoutText();
		const payload = JSON.parse(printed);
		expect(Object.prototype.hasOwnProperty.call(payload, "cloud")).toBe(true);
		expect(payload.cloud).toBeNull();
	});
});

describe("resolveMode — explicit invalid mode refusal (mutant ef2ef587423771f3)", () => {
	it("rejects before binary fallback or installation when --mode is unrecognized", async () => {
		await installHooksCommand({ mode: "not-a-real-mode", json: true, dryRun: true });
		expect(stderrText()).toContain('unknown mode "not-a-real-mode"');
		expect(stdoutText()).toContain('"ok":false');
		expect(resolveHookBinaryPathMock).not.toHaveBeenCalled();
		expect(installHooksMock).not.toHaveBeenCalled();
	});
});

describe("parseModeChoice (exported, mutants c06f4a921478cc9b..a504b795264f8a3e)", () => {
	it("defaults to balanced for an empty/whitespace string", () => {
		expect(parseModeChoice("")).toBe("balanced");
		expect(parseModeChoice("   ")).toBe("balanced");
	});

	it("does not accept 0 as a valid preset index (kills isFinite/>=1 mutants)", () => {
		expect(parseModeChoice("0")).toBe("balanced");
	});

	it("does not accept a negative number as a valid preset index", () => {
		expect(parseModeChoice("-5")).toBe("balanced");
	});

	it("accepts the exact upper bound n === ALL_PRESETS.length (kills <= -> < mutant)", () => {
		const last = ALL_PRESETS[ALL_PRESETS.length - 1];
		expect(parseModeChoice(String(ALL_PRESETS.length))).toBe(last?.name);
	});

	it("rejects n one past the upper bound", () => {
		expect(parseModeChoice(String(ALL_PRESETS.length + 1))).toBe("balanced");
	});
});

describe("promptForMode listing (mutants daf7b924aa2353e9, 3113d907946ce121, 6467c14539ca9dc2, readStdinLine mutant c6b62db8a8111aa7)", () => {
	it("numbers presets starting at 1, marks only 'balanced' as default, and prints the prompt text", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		readSyncMock.mockImplementation(() => {
			throw new Error("simulated stdin failure");
		});

		await expect(installHooksCommand({ json: false, dryRun: false })).resolves.not.toThrow();

		const out = stdoutText();
		expect(out).toContain("  1. ");
		expect(out).not.toContain("-1.");
		expect(out).toContain("\nEnter a number, a name, or press Enter for the default.\n> ");

		const defaultCount = (out.match(/\(default\)/g) ?? []).length;
		const balancedPresetCount = ALL_PRESETS.filter((p) => p.name === "balanced").length;
		expect(defaultCount).toBe(balancedPresetCount);

		// readStdinLine's catch branch returning "" (not undefined / a crash) is what
		// lets resolution finish cleanly and print the final mode line.
		expect(out).toContain("mode: balanced");
	});
});

describe("parseRunners (mutants f0c1edd2a57e52e0, 91195e68e2570134, 8cd077e5ef936fe2, 29e5e7d9af7c457f, 8f530ad089abd99d)", () => {
	it("treats 'all' as the empty runner list with no warning", async () => {
		await installHooksCommand({ runner: "all", mode: "balanced", json: true, dryRun: true });
		expect(installHooksMock).toHaveBeenCalledWith(expect.objectContaining({ runners: [] }));
		expect(stderrText()).not.toContain("unknown runner");
	});

	it("trims whitespace around runner names before matching", async () => {
		await installHooksCommand({
			runner: " claude-code , codex ",
			mode: "balanced",
			json: true,
			dryRun: true,
		});
		expect(installHooksMock).toHaveBeenCalledWith(
			expect.objectContaining({ runners: ["claude-code", "codex"] }),
		);
		expect(stderrText()).not.toContain("unknown runner");
	});

	it("rejects an unknown runner before calling the installer", async () => {
		await installHooksCommand({
			runner: "bogus,claude-code",
			mode: "balanced",
			json: true,
			dryRun: true,
		});
		expect(stderrText()).toContain(
			"[interlinked] unknown runner: bogus; no hooks were installed",
		);
		expect(installHooksMock).not.toHaveBeenCalled();
	});
});

describe("VALID_RUNNERS / VALID_SCOPES literals (mutant symbol 41d0eb8f71fbd934)", () => {
	it("recognizes cursor, gemini-cli, codex, OpenCode, and Pi as valid runners", async () => {
		await installHooksCommand({
			runner: "cursor,gemini-cli,codex,opencode,opencode2,pi",
			mode: "balanced",
			json: true,
			dryRun: true,
		});
		expect(installHooksMock).toHaveBeenCalledWith(
			expect.objectContaining({
				runners: ["cursor", "gemini-cli", "codex", "opencode", "opencode2", "pi"],
			}),
		);
		expect(stderrText()).not.toContain("unknown runner");
	});

	it("recognizes 'local' as a valid scope with no warning", async () => {
		await installHooksCommand({ scope: "local", mode: "balanced", json: true, dryRun: true });
		expect(installHooksMock).toHaveBeenCalledWith(expect.objectContaining({ scope: "local" }));
		expect(stderrText()).not.toContain("unknown scope");
	});

	it("recognizes 'project' as a valid scope with no warning (even though it's also the fallback)", async () => {
		await installHooksCommand({ scope: "project", mode: "balanced", json: true, dryRun: true });
		expect(installHooksMock).toHaveBeenCalledWith(expect.objectContaining({ scope: "project" }));
		expect(stderrText()).not.toContain("unknown scope");
	});
});

describe("parseScope (mutant 1c6d4eed46cfd531)", () => {
	it("defaults an omitted scope to project silently, without an unknown-scope warning", async () => {
		await installHooksCommand({ mode: "balanced", json: true, dryRun: true });
		expect(installHooksMock).toHaveBeenCalledWith(expect.objectContaining({ scope: "project" }));
		expect(stderrText()).not.toContain("unknown scope");
	});
});

describe("writeCloudConfig (mutant symbol 174bbee5c512ce9a)", () => {
	const cfgDir = join(process.cwd(), ".interlinked");

	it("does not mkdir when the config dir already exists", async () => {
		existsSyncMock.mockReturnValue(true);
		await installHooksCommand({
			cloud: "guardrails",
			mode: "balanced",
			json: true,
			dryRun: false,
		});
		expect(mkdirSyncMock).not.toHaveBeenCalled();
	});

	it("mkdirs the config dir recursively when it does not exist", async () => {
		existsSyncMock.mockReturnValue(false);
		await installHooksCommand({
			cloud: "guardrails",
			mode: "balanced",
			json: true,
			dryRun: false,
		});
		expect(mkdirSyncMock).toHaveBeenCalledWith(cfgDir, { recursive: true });
	});

	it("writes redactors_before_send as exactly ['secrets', 'paths']", async () => {
		existsSyncMock.mockReturnValue(true);
		await installHooksCommand({
			cloud: "guardrails",
			mode: "balanced",
			json: true,
			dryRun: false,
		});
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		const written = writeFileSyncMock.mock.calls[0]?.[1] as string;
		const payload = JSON.parse(written);
		expect(payload.redactors_before_send).toEqual(["secrets", "paths"]);
	});
});
