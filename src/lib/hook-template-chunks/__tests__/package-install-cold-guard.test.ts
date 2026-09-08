// Corpus + codegen test for the shared cold-fallback package-install gate
// (`src/lib/hook-template-chunks/package-install-cold-guard.ts`).
//
// This gate is the .mjs hook's conservative fallback: when the daemon is
// unreachable the allowlist cannot be consulted, so every install verb is
// refused. It used to live only inside the generated-hook template string,
// where it could be exercised only through `new Function(GUARDS_INLINE_CHUNK)`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ColdWriteVerdict } from "../cold-write-guards.js";
import {
	checkPackageInstallCold,
	looksLikePackageInstall,
	PACKAGE_INSTALL_COLD_GUARD_SOURCE,
} from "../package-install-cold-guard.js";

type InstallFn = (toolName: string, toolInput: Record<string, unknown>) => ColdWriteVerdict | null;

let saved: string | undefined;

beforeEach(() => {
	saved = process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
	delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
});

afterEach(() => {
	if (saved === undefined) delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
	else process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = saved;
});

function run(command: string): ColdWriteVerdict | null {
	return checkPackageInstallCold("Bash", { command });
}

describe("checkPackageInstallCold — positive (must fire)", () => {
	const blocked = [
		"npm install lodash",
		"npm ci",
		"pnpm add left-pad",
		"yarn",
		"bun i",
		"pip install requests",
		"pip3 install requests",
		"pipx install black",
		"poetry add httpx",
		"uv pip install ruff",
		"cargo install ripgrep",
		"gem install rails",
		"bundle install",
		"go get github.com/x/y",
	];

	for (const cmd of blocked) {
		it(`P blocks: ${cmd}`, () => {
			const v = run(cmd);
			expect(v?.decision, cmd).toBe("block");
			expect(v?.rule_id, cmd).toBe("supply-chain-inline-fail-closed");
			expect(v?.reason, cmd).toContain("[interlinked:supply-chain]");
		});
	}
});

describe("checkPackageInstallCold — negative (must not fire)", () => {
	const allowed = [
		"npm run build",
		"npm test",
		"npm uninstall lodash",
		"pnpm remove left-pad",
		"pip uninstall requests",
		"pipx uninstall black",
		"poetry remove httpx",
		"uv remove ruff",
		"cargo uninstall ripgrep",
		"gem uninstall rails",
		"bundle remove rails",
		"ls -la",
		"git status",
	];

	for (const cmd of allowed) {
		it(`N allows: ${cmd}`, () => {
			expect(run(cmd), cmd).toBeNull();
		});
	}

	it("N: allows non-Bash tools", () => {
		expect(checkPackageInstallCold("Edit", { command: "npm install lodash" })).toBeNull();
	});

	it("N: honors INTERLINKED_DISABLE_PACKAGE_GUARD=1", () => {
		process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = "1";
		expect(run("npm install lodash")).toBeNull();
	});
});

describe("looksLikePackageInstall — detection only", () => {
	it("P: recognizes an install verb", () => {
		expect(looksLikePackageInstall("npm install lodash")).toBe(true);
	});

	it("N: does not recognize a script runner", () => {
		expect(looksLikePackageInstall("npm run build")).toBe(false);
	});
});

describe("PACKAGE_INSTALL_COLD_GUARD_SOURCE — embeddable into the .mjs", () => {
	it("reconstructs and agrees with the imported function", () => {
		// SAFETY: the source serializes checkPackageInstallCold and its dependencies; this named export is compared directly with the imported guard for each command below.
		const rebuilt = new Function(
			`"use strict"; ${PACKAGE_INSTALL_COLD_GUARD_SOURCE}; return checkPackageInstallCold;`,
		)() as InstallFn;
		for (const cmd of ["npm install lodash", "yarn", "npm run build", "pip uninstall x", "ls"]) {
			expect(rebuilt("Bash", { command: cmd }), cmd).toEqual(
				checkPackageInstallCold("Bash", { command: cmd }),
			);
		}
	});

	it("contains no backtick or `${` so it splices into any string context", () => {
		expect(PACKAGE_INSTALL_COLD_GUARD_SOURCE).not.toContain("`");
		expect(PACKAGE_INSTALL_COLD_GUARD_SOURCE).not.toContain("${");
	});
});
