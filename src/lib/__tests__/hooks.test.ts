import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteConfigDir,
	deleteHookScript,
	ensureGitignore,
	findProjectRoot,
	getHookScriptPath,
	HOOK_SCRIPT_VERSION,
	installAllHooks,
	installStatusLine,
	resolveHookBinaryPath,
	writeHookScript,
} from "../hooks.js";

describe("HOOK_SCRIPT_VERSION", () => {
	it("is a non-empty string", () => {
		expect(typeof HOOK_SCRIPT_VERSION).toBe("string");
		expect(HOOK_SCRIPT_VERSION.length).toBeGreaterThan(0);
	});
});

// `hooks.ts` computes its own `HOOK_SCRIPT_VERSION` at module load via a
// private `readPackageVersion(parsed)` helper. It isn't exported, so the
// only way to exercise its "parsed value isn't usable" branches is to feed
// a fake `package.json` body through a mocked `node:fs` and re-import the
// module fresh.
describe("HOOK_SCRIPT_VERSION — readPackageVersion fallback branches", () => {
	afterEach(() => {
		vi.doUnmock("node:fs");
		vi.resetModules();
	});

	it("falls back to 0.0.0 when the resolved package.json does not parse to a plain object", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
					const path = args[0];
					if (String(path).endsWith("package.json")) {
						return JSON.stringify(["not", "an", "object"]);
					}
					return actual.readFileSync(...args);
				}),
			};
		});
		const mod = await import("../hooks.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
	});

	it("falls back to 0.0.0 when package.json is a plain object but `version` is not a string", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
					const path = args[0];
					if (String(path).endsWith("package.json")) {
						return JSON.stringify({ name: "interlinked-cli", version: 42 });
					}
					return actual.readFileSync(...args);
				}),
			};
		});
		const mod = await import("../hooks.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
	});
});

describe("findProjectRoot", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("walks up to find a `.git/` ancestor", () => {
		mkdirSync(join(tmp, ".git"), { recursive: true });
		mkdirSync(join(tmp, "a", "b"), { recursive: true });
		expect(findProjectRoot(join(tmp, "a", "b"))).toBe(tmp);
	});

	it("returns null (or an ancestor of tmp) when no .git/ is at tmp", () => {
		// On dev machines /Users/* is often inside a git repo — `findProjectRoot`
		// may walk up to that ancestor. We assert the behavior is a string or
		// null; if non-null, it is NOT tmp itself.
		const got = findProjectRoot(tmp);
		expect(got === null || (typeof got === "string" && got !== tmp)).toBe(true);
	});
});

describe("getHookScriptPath / writeHookScript / deleteHookScript", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("getHookScriptPath lives under .interlinked/hooks/", () => {
		const p = getHookScriptPath(tmp);
		expect(p.startsWith(join(tmp, ".interlinked", "hooks"))).toBe(true);
		expect(p.endsWith(".mjs")).toBe(true);
	});

	it("writeHookScript creates a .mjs file with the current version marker", () => {
		const p = writeHookScript(tmp);
		expect(existsSync(p)).toBe(true);
		const content = readFileSync(p, "utf-8");
		expect(content).toContain(HOOK_SCRIPT_VERSION);
	});

	it("writeHookScript is safe to call twice (hookDir already exists on the second call)", () => {
		const first = writeHookScript(tmp);
		expect(existsSync(first)).toBe(true);
		const second = writeHookScript(tmp);
		expect(second).toBe(first);
		expect(existsSync(second)).toBe(true);
	});

	it("resolves the mode preset from an installed manifest + config.json `mode` field", () => {
		// Sets up an installer-manifest.json (via a real install) so
		// resolveHarnessModePreset's `existsSync(mfPath)` branch is true and it
		// reads a non-empty entries list, and writes config.json's `mode` as a
		// string so the `typeof shared?.mode === "string"` branch is true too.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "config.json"), JSON.stringify({ mode: "quality" }));
		installAllHooks(tmp, ["gemini"]);
		expect(existsSync(join(tmp, ".interlinked", "installer-manifest.json"))).toBe(true);

		const p = writeHookScript(tmp);
		expect(existsSync(p)).toBe(true);
	});

	it("resolves the mode preset when the manifest exists but has zero entries", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "installer-manifest.json"),
			JSON.stringify({ schema_version: "1", entries: [] }),
		);
		const p = writeHookScript(tmp);
		expect(existsSync(p)).toBe(true);
	});

	it("deleteHookScript removes a previously-written script", () => {
		const p = writeHookScript(tmp);
		expect(existsSync(p)).toBe(true);
		expect(deleteHookScript(tmp)).toBe(true);
		expect(existsSync(p)).toBe(false);
	});

	it("deleteHookScript is a no-op when no script exists", () => {
		expect(deleteHookScript(tmp)).toBe(false);
	});
});

describe("installStatusLine", () => {
	const ORIGINAL_HOME = process.env.HOME;
	const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

	afterEach(() => {
		if (ORIGINAL_HOME === undefined) delete process.env.HOME;
		else process.env.HOME = ORIGINAL_HOME;
		if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
	});

	it("is a thin pass-through to the hook-installers implementation (returns null with no home dir)", () => {
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		expect(installStatusLine(["claude"])).toBeNull();
	});
});

describe("resolveHookBinaryPath — packagedHookEntryPath catch branch", () => {
	let tmp: string;
	const ORIGINAL_ARGV1 = process.argv[1];

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		process.argv[1] = ORIGINAL_ARGV1;
	});

	it("P: an unresolvable argv[1] still finds the PACKAGED hook when a build exists", () => {
		// This case previously asserted the opposite — that a bad argv[1] means
		// the generated `.mjs`. argv[1] answers "how was the CLI invoked", not
		// "is a packaged hook available", and conflating them installed the
		// LEGACY runtime whenever a built checkout was driven through tsx
		// (observable afterwards as a framed event count stuck at zero, since
		// the .mjs talks to the raw socket). The module-relative probe answers
		// the question that matters, so with `dist/` present the packaged
		// binary wins regardless of argv[1].
		process.argv[1] = join(tmp, "does-not-exist", "cli.js");
		const result = resolveHookBinaryPath(tmp);
		expect(result.endsWith("dist/hook-entry.js")).toBe(true);
		expect(existsSync(result)).toBe(true);
	});
});

// The "genuinely unbuilt checkout" case. It cannot be staged with real files —
// a test running inside this repo always has `dist/hook-entry.js` two levels up
// from `src/lib/hooks.ts` — so `existsSync` is stubbed to deny exactly that
// filename through the same `vi.doMock` + fresh-import pattern the
// readPackageVersion cases above use. Every other fs call stays real.
describe("packagedHookEntryPath — nothing packaged anywhere", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-unbuilt-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		vi.doUnmock("node:fs");
		vi.resetModules();
	});

	it("returns null when no probe finds a hook-entry.js, so resolution falls back to the generated .mjs", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => {
					if (String(path).endsWith("hook-entry.js")) return false;
					return actual.existsSync(path);
				}),
			};
		});
		const mod = await import("../hooks.js");

		// Observed directly: `resolveHookBinaryPath` re-checks the returned path
		// with existsSync, so a probe that answered with a bogus path would be
		// invisible in the resolved binary below.
		expect(mod.packagedHookEntryPath()).toBeNull();
		expect(mod.resolveHookBinaryPath(tmp, { writeFallback: false })).toBe(
			join(tmp, ".interlinked", "hooks", "interlinked-activity.mjs"),
		);
	});
});

describe("resolveHookBinaryPath — resolution order", () => {
	let tmp: string;
	const ORIGINAL_ARGV1 = process.argv[1];

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-resolve-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		process.argv[1] = ORIGINAL_ARGV1;
	});

	it("prefers a project-local compiled override when present", () => {
		const hooksDir = join(tmp, ".interlinked", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const compiled = join(hooksDir, "interlinked-hook");
		writeFileSync(compiled, "#!/usr/bin/env node\n");
		expect(resolveHookBinaryPath(tmp)).toBe(compiled);
	});

	it("prefers the packaged hook-entry.js next to the invoked binary when no compiled override exists", () => {
		const scriptFile = join(tmp, "some-bin.js");
		writeFileSync(scriptFile, "// dummy invoked script\n");
		// `packagedHookEntryPath` resolves via `realpathSync`, which on macOS
		// canonicalizes `/tmp` to `/private/tmp` — compare against the same
		// realpath-derived location rather than the raw `tmp` join.
		const hookEntry = join(dirname(realpathSync(scriptFile)), "hook-entry.js");
		writeFileSync(hookEntry, "// dummy packaged hook entry\n");
		process.argv[1] = scriptFile;
		expect(resolveHookBinaryPath(tmp)).toBe(hookEntry);
	});

	// "No packaged binary" is now stated explicitly rather than simulated by
	// blanking argv[1]: the probe is module-relative, so a test running inside
	// this repo cannot make `dist/` disappear. Blanking argv used to stand in
	// for an unbuilt checkout, which is exactly the conflation that installed
	// the legacy runtime into built ones.
	it("falls back to an already-written legacy .mjs when no compiled/packaged binary exists", () => {
		const legacy = writeHookScript(tmp);
		expect(resolveHookBinaryPath(tmp, { packagedPath: () => null })).toBe(legacy);
	});

	it("returns the unwritten legacy path without writing it when writeFallback is false", () => {
		const result = resolveHookBinaryPath(tmp, { writeFallback: false, packagedPath: () => null });
		expect(result).toBe(getHookScriptPath(tmp));
		expect(existsSync(result)).toBe(false);
	});
});

describe("deleteConfigDir", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("removes .interlinked/ when it exists", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		expect(deleteConfigDir(tmp)).toBe(true);
		expect(existsSync(join(tmp, ".interlinked"))).toBe(false);
	});

	it("returns false when .interlinked/ does not exist", () => {
		expect(deleteConfigDir(tmp)).toBe(false);
	});
});

describe("ensureGitignore", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes Interlinked entries to the project `.gitignore`", () => {
		const changed = ensureGitignore(tmp);
		expect(changed).toBe(true);
		const gi = readFileSync(join(tmp, ".gitignore"), "utf-8");
		expect(gi).toMatch(/config\.local\.json/);
	});

	it("is a no-op when the gitignore already matches", () => {
		ensureGitignore(tmp);
		expect(ensureGitignore(tmp)).toBe(false);
	});
});
