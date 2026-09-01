import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `readSync(0, ...)` is the only line-reader install-hooks uses for the
// interactive mode prompt. Mock it surgically (everything else in node:fs
// stays real, so the tmpdir/manifest/settings file I/O below is genuine);
// the default delegates to the real readSync so non-interactive tests are
// untouched, and the interactive test sets its own implementation.
const mockReadSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		readSync: (...args: Parameters<typeof real.readSync>): number => {
			if (mockReadSync.getMockImplementation()) {
				return mockReadSync(...args) as number;
			}
			return real.readSync(...args);
		},
	};
});

import { nonNull } from "../lib/non-null.js";
import { installHooksCommand, parseModeChoice } from "./install-hooks.js";

// ─────────────────────────────────────────────────────────────────
// --preserve-mode / --refresh: the hooks-only contract (2026-08-29)
// ─────────────────────────────────────────────────────────────────
describe("installHooksCommand — preserve-mode and refresh never write enforcement mode", () => {
	// test-contract: bug — the reason plain repairs were unsafe: without the
	// flag, every run rewrites check-policy.json (the --mode default is
	// "balanced"). The pair below pins BOTH directions.
	it("P: a plain non-TTY install writes check-policy.json; --preserve-mode does not", async () => {
		setStdinTTY(false);
		await captureStdout(() =>
			installHooksCommand({ runner: "gemini-cli", binary: "/usr/bin/ih-pm" }),
		);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(true);

		rmSync(join(tmp, ".interlinked", "check-policy.json"));
		await captureStdout(() =>
			installHooksCommand({ runner: "gemini-cli", binary: "/usr/bin/ih-pm", preserveMode: true }),
		);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});

	// test-contract: invariant — --refresh implies mode preservation and, on
	// an empty manifest, refreshes nothing and installs nothing.
	it("P: --refresh writes no mode file and reports the preserved mode", async () => {
		setStdinTTY(false);
		const out = await captureStdout(() =>
			installHooksCommand({ binary: "/usr/bin/ih-refresh", refresh: true }),
		);
		expect(out).toContain("refreshed 0 installed runner(s)");
		expect(out).toContain("mode: preserved");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
	});
});

let tmp = "";
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. installHooksCommand reads
// `process.cwd()` explicitly, so the spy exercises the same path.
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-ih-"));
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
});
afterEach(() => {
	cwdSpy?.mockRestore();
	rmSync(tmp, { recursive: true, force: true });
	mockReadSync.mockReset();
	vi.restoreAllMocks();
});

/** Capture everything written to process.stdout while `fn` runs. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	let captured = "";
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
		buf: string | Uint8Array,
	) => {
		captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
		return true;
	}) as unknown as typeof process.stdout.write);
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return captured;
}

function setStdinTTY(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

/** Result shape `printHuman` consumes; mirror of installer.InstallResult. */
interface StubInstallResult {
	/** False when an adapter's required postInstall threw — the hooks JSON
	 *  landed but the runner will not honor it. */
	ok: boolean;
	post_install_failures: Array<{ runner: string; reason: string }>;
	entries: Array<{ runner: string; settings_path: string; added_paths: string[] }>;
	skipped: Array<{ runner: string; reason: string }>;
	manifest_path: string;
	purged: number;
	foreign: number;
	orphans_cleaned: string[];
}

/**
 * Re-import the command with a stubbed `../harness/installer.js` so the
 * return shape (skipped/purged/foreign/orphans + dry-run write suppression)
 * is fully under test control. `vi.doMock` is not hoisted, so the static
 * `installHooksCommand` import above keeps the real installer; only this
 * dynamic import sees the stub.
 */
async function importWithStubbedInstaller(
	result: StubInstallResult,
): Promise<typeof import("./install-hooks.js")> {
	vi.resetModules();
	vi.doMock("../harness/installer.js", () => ({
		installHooks: (): StubInstallResult => result,
		manifestPath: (cwd: string): string => join(cwd, ".interlinked", "installer-manifest.json"),
	}));
	const mod = await import("./install-hooks.js");
	return mod;
}

describe("install-hooks command", () => {
	it("installs for the claude-code runner and writes a settings file wiring the hook binary", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-binary" });
		spy.mockRestore();
		const settingsPath = join(tmp, ".claude", "settings.json");
		expect(existsSync(settingsPath)).toBe(true);
		expect(existsSync(join(tmp, ".interlinked", "installer-manifest.json"))).toBe(true);

		// Read the file back and assert the WRITTEN content actually wires the
		// hook — a bare existsSync would pass on an empty `{}`. The claude-code
		// adapter registers a `command`-type hook per native event whose shell
		// line invokes the supplied binary with the runner tag.
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
		};
		const preToolUse = settings.hooks?.PreToolUse;
		expect(Array.isArray(preToolUse)).toBe(true);
		const command = preToolUse?.[0]?.hooks?.[0]?.command ?? "";
		expect(preToolUse?.[0]?.hooks?.[0]?.type).toBe("command");
		expect(command).toContain("/usr/bin/ih-binary");
		expect(command).toContain("--runner 'claude-code'");
		expect(command).toContain("--event 'PreToolUse'");
	});

	it("installs all runners when runner='all'", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({ runner: "all", binary: "/usr/bin/ih-binary" });
		spy.mockRestore();
		const manifest = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "installer-manifest.json"), "utf-8"),
		) as { entries: Array<{ runner: string }> };
		expect(manifest.entries.length).toBe(8);
	});

	it("respects --dry-run", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-binary",
			dryRun: true,
		});
		spy.mockRestore();
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
	});

	it("writes cloud.json when --cloud is provided", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-binary",
			cloud: "guardrails",
			tokenEnv: "MY_TOKEN",
		});
		spy.mockRestore();
		const cloud = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "cloud.json"), "utf-8"),
		) as {
			enabled: boolean;
			product: string;
			token_source: { env: string };
		};
		expect(cloud.enabled).toBe(true);
		expect(cloud.product).toBe("guardrails");
		expect(cloud.token_source.env).toBe("MY_TOKEN");
	});

	it("rejects an unknown runner selection before installing any requested runner", async () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		process.exitCode = 0;
		await installHooksCommand({
			runner: "not-a-runner,claude-code",
			binary: "/usr/bin/ih-binary",
		});
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("unknown runner: not-a-runner; no hooks were installed"),
		);
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "installer-manifest.json"))).toBe(false);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("rejects an explicitly empty runner instead of treating it as all runners", async () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		process.exitCode = 0;
		await installHooksCommand({ runner: "", binary: "/usr/bin/ih-binary" });
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("unknown runner: ; no hooks were installed"),
		);
		expect(existsSync(join(tmp, ".interlinked", "installer-manifest.json"))).toBe(false);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("accepts --mode strict and records it in check-policy.json", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-mode",
			mode: "strict",
		});
		spy.mockRestore();
		const path = join(tmp, ".interlinked", "check-policy.json");
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mode: string };
		expect(parsed.mode).toBe("strict");
	});

	it("rejects an explicit unknown --mode before hooks or policy are written", async () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		process.exitCode = 0;
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-mode-bad",
			mode: "super-strict",
		});
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining('unknown mode "super-strict"'),
		);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("no files were changed"));
		expect(process.exitCode).toBe(1);
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "installer-manifest.json"))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
		process.exitCode = 0;
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("produces JSON output when --json set", async () => {
		let captured = "";
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
			buf: string | Uint8Array,
		) => {
			captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
			return true;
		}) as unknown as typeof process.stdout.write);
		await installHooksCommand({
			runner: "claude-code",
			binary: "/usr/bin/ih-binary",
			json: true,
		});
		spy.mockRestore();
		const payload = JSON.parse(captured) as { ok: boolean; entries: unknown[] };
		expect(payload.ok).toBe(true);
		expect(payload.entries.length).toBe(1);
	});
});

/**
 * `ok` used to be the literal `true` — it reported that the command reached its
 * end, not that the install worked. A Codex `postInstall` throw was caught,
 * logged to stderr and dropped, so a manifest describing an installation whose
 * hooks never fire was emitted as a success.
 *
 * The failure is forced for real, not mocked: `config.toml` is created as a
 * DIRECTORY, so the feature-flag writer throws EISDIR while `.codex/hooks.json`
 * still lands.
 */
describe("install-hooks — a failed postInstall is not reported as success", () => {
	function breakCodexConfigToml(): void {
		mkdirSync(join(tmp, ".codex", "config.toml"), { recursive: true });
	}

	it("P1: --json reports ok:false and names the failure", async () => {
		breakCodexConfigToml();
		const out = await captureStdout(() =>
			installHooksCommand({ runner: "codex", binary: "/usr/bin/ih-broken", json: true }),
		);
		const payload = JSON.parse(out) as {
			ok: boolean;
			post_install_failures: Array<{ runner: string; reason: string }>;
			entries: Array<{ post_install: string }>;
		};
		expect(payload.ok).toBe(false);
		expect(nonNullRow(payload.post_install_failures[0]).runner).toBe("codex");
		expect(nonNullRow(payload.entries[0]).post_install).toBe("failed");
	});

	it("P2: the process exit code is non-zero so a script or CI step sees it", async () => {
		breakCodexConfigToml();
		process.exitCode = 0;
		await captureStdout(() =>
			installHooksCommand({ runner: "codex", binary: "/usr/bin/ih-broken2", json: true }),
		);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it("P3: the human output says the hooks are inactive", async () => {
		breakCodexConfigToml();
		const out = await captureStdout(() =>
			installHooksCommand({ runner: "codex", binary: "/usr/bin/ih-broken3", mode: "balanced" }),
		);
		process.exitCode = 0;
		expect(out).toContain("INCOMPLETE — hooks inactive");
	});

	it("N1: a healthy Codex install still reports ok:true and leaves the exit code alone", async () => {
		process.exitCode = 0;
		const out = await captureStdout(() =>
			installHooksCommand({ runner: "codex", binary: "/usr/bin/ih-healthy", json: true }),
		);
		const payload = JSON.parse(out) as {
			ok: boolean;
			post_install_failures: unknown[];
		};
		expect(payload.ok).toBe(true);
		expect(payload.post_install_failures).toEqual([]);
		expect(process.exitCode).toBe(0);
	});
});

describe("install-hooks — a failed mode write is not reported as success", () => {
	it("reports ok:false and leaves the requested mode unapplied", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		const guardPath = join(tmp, ".interlinked", "guard-rules.json");
		writeFileSync(guardPath, "{ corrupt guard rules");
		process.exitCode = 0;

		const out = await captureStdout(() =>
			installHooksCommand({ runner: "gemini-cli", binary: "/usr/bin/ih-mode-fail", json: true }),
		);
		const payload = JSON.parse(out) as { ok: boolean; mode: string };

		expect(payload.ok).toBe(false);
		expect(payload.mode).toBe("balanced");
		expect(process.exitCode).toBe(1);
		expect(readFileSync(guardPath, "utf-8")).toBe("{ corrupt guard rules");
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
		process.exitCode = 0;
	});
});

/** Narrow an indexed row without `!` — the tests above always produce one. */
function nonNullRow<T>(row: T | undefined): T {
	if (row === undefined) throw new Error("expected a row");
	return row;
}

describe("parseModeChoice", () => {
	it("returns balanced for empty input", () => {
		expect(parseModeChoice("")).toBe("balanced");
		expect(parseModeChoice("  ")).toBe("balanced");
	});
	it("accepts numeric index (1-based)", () => {
		expect(parseModeChoice("1")).toBe("strict");
		expect(parseModeChoice("2")).toBe("lenient");
		expect(parseModeChoice("3")).toBe("balanced");
	});
	it("accepts the mode name directly", () => {
		expect(parseModeChoice("strict")).toBe("strict");
		expect(parseModeChoice("LENIENT")).toBe("lenient");
	});
	it("falls back to balanced on unknown input", () => {
		expect(parseModeChoice("bogus")).toBe("balanced");
		expect(parseModeChoice("99")).toBe("balanced");
	});
});

describe("install-hooks — interactive mode prompt", () => {
	it("prompts for mode in a TTY when no --mode flag, reads numeric choice", async () => {
		setStdinTTY(true);
		// "2" → second preset (lenient) per the ALL_PRESETS ordering.
		mockReadSync.mockImplementation((_fd: number, buf: Buffer): number => {
			const s = "2\n";
			buf.write(s, 0, "utf-8");
			return Buffer.byteLength(s);
		});
		const out = await captureStdout(() =>
			installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-prompt" }),
		);
		setStdinTTY(false);
		// The menu was rendered and the chosen mode was persisted + echoed.
		expect(out).toContain("Pick an enforcement mode");
		expect(out).toContain("balanced (default)");
		expect(mockReadSync).toHaveBeenCalled();
		const policy = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		) as { mode: string };
		expect(policy.mode).toBe("lenient");
		expect(out).toContain("mode: lenient");
	});

	it("prompts and accepts a mode name typed at the prompt", async () => {
		setStdinTTY(true);
		mockReadSync.mockImplementation((_fd: number, buf: Buffer): number => {
			const s = "lenient\n";
			buf.write(s, 0, "utf-8");
			return Buffer.byteLength(s);
		});
		await captureStdout(() =>
			installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-prompt2" }),
		);
		setStdinTTY(false);
		const policy = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		) as { mode: string };
		expect(policy.mode).toBe("lenient");
	});

	it("prompt with empty input (just Enter) resolves to balanced", async () => {
		setStdinTTY(true);
		mockReadSync.mockImplementation((_fd: number, buf: Buffer): number => {
			const s = "\n";
			buf.write(s, 0, "utf-8");
			return Buffer.byteLength(s);
		});
		await captureStdout(() =>
			installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-prompt3" }),
		);
		setStdinTTY(false);
		const policy = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		) as { mode: string };
		expect(policy.mode).toBe("balanced");
	});

	it("treats a readSync failure at the prompt as empty input → balanced", async () => {
		setStdinTTY(true);
		// readStdinLine swallows the throw and returns "" → parseModeChoice → balanced.
		mockReadSync.mockImplementation((): number => {
			throw new Error("no tty fd available");
		});
		await captureStdout(() =>
			installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-prompt4" }),
		);
		setStdinTTY(false);
		const policy = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "check-policy.json"), "utf-8"),
		) as { mode: string };
		expect(policy.mode).toBe("balanced");
	});

	it("does NOT prompt when --json is set even in a TTY (defaults balanced)", async () => {
		setStdinTTY(true);
		const out = await captureStdout(() =>
			installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-nojson", json: true }),
		);
		setStdinTTY(false);
		expect(out).not.toContain("Pick an enforcement mode");
		expect(mockReadSync).not.toHaveBeenCalled();
		const payload = JSON.parse(out) as { mode: string };
		expect(payload.mode).toBe("balanced");
	});
});

describe("install-hooks — binary path resolution fallback", () => {
	it("resolves a hook binary path when --binary is omitted (non-dry-run writes a fallback)", async () => {
		const out = await captureStdout(() =>
			installHooksCommand({ runner: "claude-code", json: true }),
		);
		const payload = JSON.parse(out) as { ok: boolean; entries: unknown[] };
		expect(payload.ok).toBe(true);
		expect(payload.entries.length).toBe(1);
		// In a BUILT checkout the install now resolves the packaged
		// `dist/hook-entry.js` — the canonical runtime — instead of writing the
		// legacy `.mjs`. The previous assertion (that a hooks/ dir appeared)
		// silently encoded "the legacy fallback ran", which is the defect: it
		// passed precisely when the wrong binary was installed. The .mjs
		// fallback itself is still covered, by name, in hooks.test.ts.
		expect(existsSync(join(tmp, ".interlinked", "hooks"))).toBe(false);
	});

	it("resolves a hook binary path when --binary omitted under --dry-run (no fallback write)", async () => {
		const out = await captureStdout(() =>
			installHooksCommand({ runner: "claude-code", dryRun: true, json: true }),
		);
		const payload = JSON.parse(out) as { ok: boolean; dry_run: boolean };
		expect(payload.ok).toBe(true);
		expect(payload.dry_run).toBe(true);
		// dry-run path passes writeFallback:false → no settings file written.
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
	});
});

describe("install-hooks — scope parsing", () => {
	// MUST stay `dryRun: true`. `tmp` sandboxes process.cwd(), but NOT the home
	// directory, and user scope resolves through `homedir()` — so a non-dry run
	// here writes into the developer's REAL ~/.claude/settings.json. It did:
	// this test appended 14 hook blocks per run to a live machine's global
	// settings until the file hit 2.1MB / 8,092 entries and Claude Code refused
	// to read it ("File exceeds maxBytes limit"), disabling every setting in it.
	// The assertion below only needs the REPORTED path, which dry-run produces.
	it("accepts an explicit non-default scope (user) and reports it in JSON", async () => {
		const out = await captureStdout(() =>
			installHooksCommand({
				runner: "claude-code",
				binary: "/usr/bin/ih-scope",
				scope: "user",
				dryRun: true,
				json: true,
			}),
		);
		const payload = JSON.parse(out) as { ok: boolean; entries: Array<{ settings_path: string }> };
		expect(payload.ok).toBe(true);
		// user scope targets ~/.claude/settings.json, not the project tmp dir.
		expect(nonNull(payload.entries[0]).settings_path).not.toContain(tmp);
	});

	it("rejects an explicit unknown scope without falling back or writing", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		process.exitCode = 0;
		const out = await captureStdout(() =>
			installHooksCommand({
				runner: "claude-code",
				binary: "/usr/bin/ih-badscope",
				scope: "galaxy",
				json: true,
			}),
		);
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining('unknown scope "galaxy"'),
		);
		const payload = JSON.parse(out) as { ok: boolean; error: string };
		expect(payload.ok).toBe(false);
		expect(payload.error).toContain("expected user, project, or local");
		expect(process.exitCode).toBe(1);
		expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "installer-manifest.json"))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
		process.exitCode = 0;
		stderrSpy.mockRestore();
	});
});

describe("install-hooks — cloud config branches", () => {
	it("warns and skips when --cloud names an unknown product (no cloud.json written)", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await captureStdout(() =>
			installHooksCommand({
				runner: "claude-code",
				binary: "/usr/bin/ih-badcloud",
				cloud: "telemetry",
			}),
		);
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining("unknown cloud product telemetry"),
		);
		stderrSpy.mockRestore();
		expect(existsSync(join(tmp, ".interlinked", "cloud.json"))).toBe(false);
	});

	it("writes the agent-ci portal url and a null token_source when --token-env omitted", async () => {
		await captureStdout(() =>
			installHooksCommand({
				runner: "claude-code",
				binary: "/usr/bin/ih-agentci",
				cloud: "agent-ci",
			}),
		);
		const cloud = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "cloud.json"), "utf-8"),
		) as { product: string; portal_url: string; token_source: unknown };
		expect(cloud.product).toBe("agent-ci");
		expect(cloud.portal_url).toContain("agent-ci");
		expect(cloud.token_source).toBeNull();
	});

	it("does not write cloud.json under --dry-run even with a valid product", async () => {
		await captureStdout(() =>
			installHooksCommand({
				runner: "claude-code",
				binary: "/usr/bin/ih-drycloud",
				cloud: "guardrails",
				dryRun: true,
			}),
		);
		expect(existsSync(join(tmp, ".interlinked", "cloud.json"))).toBe(false);
	});

	it("creates the .interlinked dir before writing cloud.json when absent (stubbed installer)", async () => {
		// Stub installHooks so the .interlinked dir is NOT pre-created by the
		// manifest write — forcing writeCloudConfig down the mkdirSync branch.
		const mod = await importWithStubbedInstaller({
			ok: true,
			post_install_failures: [],
			entries: [],
			skipped: [],
			manifest_path: join(tmp, ".interlinked", "installer-manifest.json"),
			purged: 0,
			foreign: 0,
			orphans_cleaned: [],
		});
		await captureStdout(() =>
			mod.installHooksCommand({
				runner: "claude-code",
				binary: "/usr/bin/ih-mkdir",
				cloud: "guardrails",
			}),
		);
		vi.doUnmock("../harness/installer.js");
		vi.resetModules();
		expect(existsSync(join(tmp, ".interlinked", "cloud.json"))).toBe(true);
		const cloud = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "cloud.json"), "utf-8"),
		) as { product: string; portal_url: string };
		expect(cloud.product).toBe("guardrails");
		expect(cloud.portal_url).toContain("interlinked.dev/mcp");
	});

	it("writeCloudConfig itself mkdirs .interlinked when no prior step created it", async () => {
		// The mkdir-when-absent branch in writeCloudConfig is shadowed in the
		// normal flow: writeMode() runs between installHooks() and
		// writeCloudConfig() and unconditionally creates .interlinked, so by
		// the time writeCloudConfig checks, the dir already exists. To exercise
		// the branch behaviorally we stub BOTH collaborators that would
		// otherwise pre-create the dir: the installer (manifest write) AND
		// writeMode (check-policy write). With neither having run, the dir is
		// genuinely absent and writeCloudConfig must create it itself.
		vi.resetModules();
		vi.doMock("../harness/installer.js", () => ({
			installHooks: (): StubInstallResult => ({
				ok: true,
				post_install_failures: [],
				entries: [],
				skipped: [],
				manifest_path: join(tmp, ".interlinked", "installer-manifest.json"),
				purged: 0,
				foreign: 0,
				orphans_cleaned: [],
			}),
			manifestPath: (cwd: string): string =>
				join(cwd, ".interlinked", "installer-manifest.json"),
		}));
		const writeModeSpy = vi.fn(() => true);
		vi.doMock("./mode.js", () => ({ writeMode: writeModeSpy }));
		const mod = await import("./install-hooks.js");

		// Sanity: the dir must not exist before the command runs, otherwise
		// the branch under test would be entered on its `false` arm.
		expect(existsSync(join(tmp, ".interlinked"))).toBe(false);

		await captureStdout(() =>
			mod.installHooksCommand({
				runner: "claude-code",
				binary: "/usr/bin/ih-mkdir-self",
				cloud: "agent-ci",
				tokenEnv: "CI_TOKEN",
			}),
		);
		vi.doUnmock("../harness/installer.js");
		vi.doUnmock("./mode.js");
		vi.resetModules();

		// writeMode was stubbed (so it did NOT create .interlinked) yet was
		// still invoked by the command — proves the dir came from
		// writeCloudConfig's own mkdir, not from the mode write.
		expect(writeModeSpy).toHaveBeenCalledTimes(1);
		// The stub left check-policy.json unwritten; only writeCloudConfig
		// touched .interlinked. cloud.json proves the mkdir branch ran.
		expect(existsSync(join(tmp, ".interlinked", "check-policy.json"))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "cloud.json"))).toBe(true);
		const cloud = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "cloud.json"), "utf-8"),
		) as { product: string; portal_url: string; token_source: { env: string } };
		expect(cloud.product).toBe("agent-ci");
		expect(cloud.portal_url).toContain("interlinked.dev/agent-ci");
		expect(cloud.token_source.env).toBe("CI_TOKEN");
	});
});

describe("install-hooks — human-readable accounting (printHuman)", () => {
	it("renders dry-run verb, skipped, purged, orphans and foreign lines", async () => {
		const mod = await importWithStubbedInstaller({
			ok: true,
			post_install_failures: [],
			entries: [
				{
					runner: "claude-code",
					settings_path: join(tmp, ".claude", "settings.json"),
					added_paths: ["hooks.PreToolUse", "hooks.PostToolUse"],
				},
			],
			skipped: [{ runner: "codex", reason: "malformed JSON at .codex/config.toml" }],
			manifest_path: join(tmp, ".interlinked", "installer-manifest.json"),
			purged: 3,
			foreign: 2,
			orphans_cleaned: [join(tmp, "old", "settings.json"), join(tmp, "older", "settings.json")],
		});
		const out = await captureStdout(() =>
			mod.installHooksCommand({ runner: "all", binary: "/usr/bin/ih-human", dryRun: true }),
		);
		vi.doUnmock("../harness/installer.js");
		vi.resetModules();

		expect(out).toContain("would install hooks for 1 runner(s)");
		expect(out).toContain("claude-code");
		expect(out).toContain("(2 path(s))");
		expect(out).toContain("codex");
		expect(out).toContain("skipped: malformed JSON");
		expect(out).toContain("purged 3 stale hook registration(s)");
		expect(out).toContain("cleaned a prior install in 2 other file(s)");
		expect(out).toContain("left 2 hook registration(s) owned by other projects");
		expect(out).toContain("manifest:");
		// dry-run suppresses the mode footer line.
		expect(out).not.toContain("mode: ");
	});

	it("renders the installed verb and mode footer on a real (non-dry) install with clean accounting", async () => {
		const mod = await importWithStubbedInstaller({
			ok: true,
			post_install_failures: [],
			entries: [
				{
					runner: "claude-code",
					settings_path: join(tmp, ".claude", "settings.json"),
					added_paths: ["hooks.PreToolUse"],
				},
			],
			skipped: [],
			manifest_path: join(tmp, ".interlinked", "installer-manifest.json"),
			purged: 0,
			foreign: 0,
			orphans_cleaned: [],
		});
		const out = await captureStdout(() =>
			mod.installHooksCommand({ runner: "claude-code", binary: "/usr/bin/ih-clean" }),
		);
		vi.doUnmock("../harness/installer.js");
		vi.resetModules();

		expect(out).toContain("installed hooks for 1 runner(s)");
		expect(out).toContain("(1 path(s))");
		// Zero counts: none of the accounting lines fire.
		expect(out).not.toContain("purged");
		expect(out).not.toContain("cleaned a prior install");
		expect(out).not.toContain("owned by other projects");
		// Non-dry install emits the mode footer.
		expect(out).toContain("mode: balanced  (change anytime: interlinked mode <name>)");
	});
});
