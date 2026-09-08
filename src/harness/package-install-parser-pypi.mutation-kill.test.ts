import { describe, expect, it } from "vitest";
import { classifyPipSpec, parsePip, parsePoetry, parseUv } from "./package-install-parser-pypi.js";

// Mutation-kill companion targeting surviving mutants in
// package-install-parser-pypi.ts: the PIP_FLAG_TAKES_VALUE literal table,
// classifyPipSpec's anchored regexes, consumePipToken's glued/anchored
// branches, pipFlagConsumesValue's leading-char guard, the empty-string
// guard inside scanPipEditable, scanPipFlags' fromConstraints default, and
// the parsePip/parsePoetry/parseUv subcommand-routing guards. Mutant-id ->
// test mapping lives in
// scratch/fleet-r3/receipts/src_harness_package-install-parser-pypi.ts.jsonl.
// 17 additional survivors were confirmed genuinely equivalent via a 730-case
// fuzz pass (scratch/fleet-r3/src_harness_package-install-parser-pypi.ts-fuzz-equivalence.mts)
// and are NOT re-tested here — see the receipts file for their reasoning.

describe("PIP_FLAG_TAKES_VALUE — every listed flag literal is individually load-bearing", () => {
	const flags = [
		"-t",
		"--prefix",
		"--root",
		"--src",
		"--build",
		"--cache-dir",
		"--log",
		"--proxy",
		"--retries",
		"--timeout",
		"--exists-action",
		"--trusted-host",
		"--client-cert",
		"--cert",
		"--python",
		"--find-links",
		"-f",
		"--platform",
		"--python-version",
		"--implementation",
		"--abi",
	];
	it.each(flags)("%s consumes its following non-flag token as a value, not a positional", (flag) => {
		const cmd = parsePip("pip", ["pip", "install", flag, "somevalue", "foo"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});
});

describe("classifyPipSpec — anchor and character-class boundaries in the tarball/git/name regexes", () => {
	it("tarball regex leading-^ anchor: a tarball-shaped tail that is NOT at string start must not classify as tarball_url", () => {
		expect(classifyPipSpec("git+https://example.com/pkg-1.0.tar.gz")).toEqual({
			kind: "git_url",
			url: "git+https://example.com/pkg-1.0.tar.gz",
		});
	});

	it("tarball regex `https?`: plain http (no trailing s) is still accepted", () => {
		expect(classifyPipSpec("http://example.com/pkg-1.0.tar.gz")).toEqual({
			kind: "tarball_url",
			url: "http://example.com/pkg-1.0.tar.gz",
		});
	});

	it("tarball regex trailing-$ anchor: junk after the extension that is not a ?/# suffix must reject the match", () => {
		expect(classifyPipSpec("https://example.com/pkg-1.0.tar.gz.backup")).toEqual({
			kind: "registry",
			name: "https",
			version: undefined,
		});
	});

	it("tarball regex optional suffix group: a ?query tail of more than one char is fully consumed by `.*`, not just one char", () => {
		expect(classifyPipSpec("https://example.com/pkg-1.0.tar.gz?ab")).toEqual({
			kind: "tarball_url",
			url: "https://example.com/pkg-1.0.tar.gz?ab",
		});
	});

	it("tarball regex optional suffix group's char class is [?#] (positive), not [^?#] — trailing junk with neither char must reject the match", () => {
		expect(classifyPipSpec("https://example.com/pkg-1.0.tar.gzXsomeversion")).toEqual({
			kind: "registry",
			name: "https",
			version: undefined,
		});
	});

	it("git+ regex leading-^ anchor: `git+` appearing mid-string must not classify as git_url", () => {
		expect(classifyPipSpec("pkgnamegit+xyz")).toEqual({
			kind: "registry",
			name: "pkgnamegit",
			version: undefined,
		});
	});

	it("name regex leading-^ anchor: a spec starting with a disallowed char falls back to the WHOLE spec as the name, not a mid-string match", () => {
		expect(classifyPipSpec("@invalid/pkgname")).toEqual({
			kind: "registry",
			name: "@invalid/pkgname",
			version: undefined,
		});
	});
});

describe("consumePipToken — glued/anchored regex boundaries and the --constraint literal", () => {
	it("--index-url= glued regex leading-^ anchor: the pattern appearing mid-token must not be consumed as customRegistry", () => {
		const cmd = parsePip("pip", ["pip", "install", "x--index-url=value", "foo"], {});
		expect(cmd?.customRegistry).toBeUndefined();
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "x--index-url", version: undefined },
			{ kind: "registry", name: "foo", version: undefined },
		]);
	});

	it("--index-url= glued regex trailing-$ anchor: an embedded newline before the true end of the token must block the match", () => {
		const cmd = parsePip("pip", ["pip", "install", "--index-url=val\nue", "foo"], {});
		expect(cmd?.customRegistry).toBeUndefined();
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("--requirement= glued regex leading-^ anchor: the pattern appearing mid-token must not be consumed as manifestFile", () => {
		const cmd = parsePip("pip", ["pip", "install", "x--requirement=reqs.txt", "foo"], {});
		expect(cmd?.manifestFile).toBeUndefined();
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "x--requirement", version: undefined },
			{ kind: "registry", name: "foo", version: undefined },
		]);
	});

	it("--requirement= glued regex trailing-$ anchor: an embedded newline before the true end of the token must block the match", () => {
		const cmd = parsePip("pip", ["pip", "install", "--requirement=re\nqs.txt"], {});
		expect(cmd?.manifestFile).toBeUndefined();
		expect(cmd?.fromManifest).toBe(true); // no positionals implies sync-from-manifest either way
	});

	it("--constraint (long form) literal sets fromConstraints and consumes its value token", () => {
		const cmd = parsePip("pip", ["pip", "install", "--constraint", "constraints.txt", "foo"], {});
		// fromConstraints only surfaces indirectly, but the CONSUMPTION is directly
		// observable: constraints.txt must not leak into packages.
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("-e followed by a --constraint-shaped next token: --constraint's own meaning must still fire (not silently swallowed)", () => {
		const cmd = parsePip("pip", ["pip", "install", "-e", "--constraint", "X", "foo"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("--editable= glued regex leading-^ anchor: the pattern appearing mid-token must not be consumed as an editable spec", () => {
		const cmd = parsePip("pip", ["pip", "install", "x--editable=./local-pkg"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "x--editable", version: undefined }]);
	});

	it("--editable= glued regex trailing-$ anchor: an embedded newline before the true end of the token must block the match", () => {
		const cmd = parsePip("pip", ["pip", "install", "--editable=lo\ncal-pkg"], {});
		expect(cmd?.packages).toEqual([]);
		expect(cmd?.fromManifest).toBe(true);
	});

	it("attached short-option glued regex leading-^ anchor: the pattern appearing mid-token must not be consumed", () => {
		const cmd = parsePip("pip", ["pip", "install", "x-ryz", "foo"], {});
		expect(cmd?.manifestFile).toBeUndefined();
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "x-ryz", version: undefined },
			{ kind: "registry", name: "foo", version: undefined },
		]);
	});

	it("attached short-option glued regex trailing-$ anchor: an embedded newline before the true end of the token must block the match", () => {
		const cmd = parsePip("pip", ["pip", "install", "-re\nfoo"], {});
		expect(cmd?.manifestFile).toBeUndefined();
		expect(cmd?.packages).toEqual([]);
	});

	it("attached short-option -c<constraint> (glued) sets fromConstraints, suppressing the no-positionals fromManifest default", () => {
		const cmd = parsePip("pip", ["pip", "install", "-cconstraints.txt"], {});
		expect(cmd?.packages).toEqual([]);
		expect(cmd?.fromManifest).toBe(false);
	});
});

describe("pipFlagConsumesValue — the leading-char guard and its empty-fallback", () => {
	it("a dash-prefixed value must never be treated as a real flag value, even when a later char is not a dash", () => {
		const cmd = parsePip("pip", ["pip", "install", "--prefix", "-c", "realvalue", "foo"], {});
		// --prefix must NOT swallow -c: -c's own constraint handling then
		// consumes realvalue as its (unsurfaced) constraints-file value, so only
		// foo remains a positional. If --prefix wrongly swallowed -c instead,
		// realvalue would fall through and become a SECOND positional.
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("an empty-string next token must stay non-consuming (falls back to the empty-string branch, not a truthy default)", () => {
		const cmd = parsePip("pip", ["pip", "install", "--target", "", "foo"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "", version: undefined },
			{ kind: "registry", name: "foo", version: undefined },
		]);
	});
});

describe("scanPipEditable — the empty-string token must never alias -e/--editable", () => {
	it("an empty-string arg is pushed as its own positional, not swallowed as an editable flag's value", () => {
		const cmd = parsePip("pip", ["pip", "install", "", "somepkg", "foo"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "", version: undefined },
			{ kind: "registry", name: "somepkg", version: undefined },
			{ kind: "registry", name: "foo", version: undefined },
		]);
	});
});

describe("scanPipFlags — fromConstraints must default to false, not true", () => {
	it("pip install with no args at all: fromManifest reflects fromConstraints starting false", () => {
		const cmd = parsePip("pip", ["pip", "install"], {});
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromManifest).toBe(true);
	});
});

describe("parsePip — subcommand-routing guard, positionals.length===0 branch, and returned literal fields", () => {
	it("a non-pipx bin with an inject/run-shaped subcommand must still return null (isPipxSubcommand requires bin===pipx)", () => {
		expect(parsePip("pip", ["pip", "inject", "foo"], {})).toBeNull();
	});

	it("a pipx bin with an unrecognized subcommand (not install/inject/run) must return null", () => {
		expect(parsePip("pipx", ["pipx", "list", "foo"], {})).toBeNull();
	});

	// test-contract: boundary — isPipxSubcommand's `sub === "install"` disjunct
	// must compare against the literal "install", not an empty-string fallback:
	// bare `pipx` with no subcommand token yields sub="" (tokens[1]||""), which
	// must NOT satisfy the disjunct and must NOT unlock the guard.
	it("a bare pipx invocation with no subcommand token (sub defaults to \"\") must return null, not be treated as a valid pipx subcommand", () => {
		expect(parsePip("pipx", ["pipx"], {})).toBeNull();
	});

	it("basic install with one positional: action is add, ecosystem/fromLockfile/notes carry their literal values", () => {
		const cmd = parsePip("pip", ["pip", "install", "foo"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "pip",
			action: "add",
			packages: [{ kind: "registry", name: "foo", version: undefined }],
			fromLockfile: false,
			fromManifest: false,
			manifestFile: undefined,
			customRegistry: undefined,
			notes: [],
		});
	});

	it("install with no positionals: action is sync with no packages and fromManifest is true (OR-short-circuit, not forced)", () => {
		const cmd = parsePip("pip", ["pip", "install"], {});
		expect(cmd?.action).toBe("sync");
		expect(cmd?.fromManifest).toBe(true);
		expect(cmd?.packages).toEqual([]);
	});

	it("a manifest file present alongside a real positional: fromManifest stays true (the OR, not an AND with noPositionals)", () => {
		const cmd = parsePip("pip", ["pip", "install", "-r", "reqs.txt", "foo"], {});
		expect(cmd?.fromManifest).toBe(true);
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo", version: undefined }]);
	});

	it("pipx run is a recognized pipx subcommand, routed to action install_global", () => {
		expect(parsePip("pipx", ["pipx", "run", "black"], {})?.action).toBe("install_global");
	});

	it("the inject-only positionals.slice(1) must fire ONLY when sub is literally inject, not for any pipx bin (install/run keep every positional)", () => {
		const cmd = parsePip("pipx", ["pipx", "install", "black", "requests"], {});
		expect(cmd?.packages).toEqual([
			{ kind: "registry", name: "black", version: undefined },
			{ kind: "registry", name: "requests", version: undefined },
		]);
	});
});

describe("parsePoetry — install branch's literal fields", () => {
	it("install with no lockfile flag: fromLockfile false, fromManifest/manifestFile/action carry their literals", () => {
		const cmd = parsePoetry(["poetry", "install"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "poetry",
			action: "sync",
			packages: [],
			fromLockfile: false,
			fromManifest: true,
			manifestFile: "pyproject.toml",
			customRegistry: undefined,
			notes: [],
		});
	});

	it("add with one package: ecosystem/manager/action literals and the classified package", () => {
		const cmd = parsePoetry(["poetry", "add", "requests"], {});
		expect(cmd?.ecosystem).toBe("pypi");
		expect(cmd?.manager).toBe("poetry");
		expect(cmd?.action).toBe("add");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "requests", version: undefined }]);
	});
});

describe("parseUv — sync/pip/tool/add branch literals and the positional filters", () => {
	it("sync with no flags: the full object shape, including the pyproject.toml manifestFile literal", () => {
		const cmd = parseUv(["uv", "sync"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "uv",
			action: "sync",
			packages: [],
			fromLockfile: false,
			fromManifest: true,
			manifestFile: "pyproject.toml",
			customRegistry: undefined,
			notes: [],
		});
	});

	it("`uv pip install` really does delegate to parsePip (manager reflects pip, not a fallthrough null)", () => {
		const cmd = parseUv(["uv", "pip", "install", "requests"], {});
		expect(cmd?.manager).toBe("pip");
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "requests", version: undefined }]);
	});

	it("an unrecognized subcommand must not be treated as the tool branch even when its args look tool-install-shaped", () => {
		expect(parseUv(["uv", "venv", "install", "black"], {})).toBeNull();
	});

	it("tool install must FILTER flags out of positionals, not just slice(1) blindly", () => {
		const cmd = parseUv(["uv", "tool", "install", "black", "--dev"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "black", version: undefined }]);
	});

	it("the add-branch positional filter is startsWith('-'), not endsWith — a trailing-hyphen token is a real positional", () => {
		const cmd = parseUv(["uv", "add", "foo-", "--dev"], {});
		expect(cmd?.packages).toEqual([{ kind: "registry", name: "foo-", version: undefined }]);
	});

	it("add with a version-pinned package: full object shape", () => {
		const cmd = parseUv(["uv", "add", "requests==2.31.0"], {});
		expect(cmd).toEqual({
			ecosystem: "pypi",
			manager: "uv",
			action: "add",
			packages: [{ kind: "registry", name: "requests", version: "==2.31.0" }],
			fromLockfile: false,
			fromManifest: false,
			customRegistry: undefined,
			notes: [],
		});
	});

	it("tool branch with a non-install inner subcommand falls through to null, not an install_global with empty packages", () => {
		expect(parseUv(["uv", "tool", "list"], {})).toBeNull();
	});
});
