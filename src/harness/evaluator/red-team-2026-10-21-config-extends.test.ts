// Red team 2026-10-21 — "extends-chain redirection": the config-loosening gate
// read only the edited tsconfig's own compilerOptions, so repointing
// `extends`, creating a new untracked base, or loosening an extends target
// lowered the EFFECTIVE strictness with every per-file diff green. These
// cases pin the effective-chain comparison (`config-loosening-extends.ts`).
// Every fixture is a throwaway mkdtemp git repo; the repository's own
// tsconfig files are never touched.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../types.js";
import { evaluateConfigLooseningForEvent } from "./config-loosening-gate.js";

const STRICT_BASE = JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } });
const LOOSE_BASE = JSON.stringify({ compilerOptions: { strict: false, noUncheckedIndexedAccess: false } });
const ROOT_TSCONFIG = JSON.stringify({
	extends: "./tsconfig.base.json",
	compilerOptions: { outDir: "dist", noEmit: true },
});

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** A throwaway repo with `files` committed at HEAD; returns git's toplevel. */
function makeRepo(files: Record<string, string>): string {
	const raw = mkdtempSync(join(tmpdir(), "clg-extends-"));
	git(raw, "init", "-q", "-b", "main");
	git(raw, "config", "user.email", "test@example.com");
	git(raw, "config", "user.name", "test");
	for (const [rel, text] of Object.entries(files)) writeFileSync(join(raw, rel), text);
	git(raw, "add", "-A");
	git(raw, "commit", "-q", "-m", "fixture");
	const root = git(raw, "rev-parse", "--show-toplevel").trim();
	roots.push(raw);
	return root;
}

function editEvent(root: string, rel: string, oldString: string, newString: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "rt-extends",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: join(root, rel), old_string: oldString, new_string: newString },
		cwd: root,
		timestamp: "2026-10-21T00:00:00Z",
	};
}

function writeEvent(root: string, rel: string, content: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "rt-extends",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: join(root, rel), content },
		cwd: root,
		timestamp: "2026-10-21T00:00:00Z",
	};
}

beforeEach(() => {
	vi.stubEnv("INTERLINKED_DISABLE_BASELINE_GUARD", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("config extends — positive (must block)", () => {
	it("P1: repoint extends to a looser base", () => {
		const root = makeRepo({
			"tsconfig.json": ROOT_TSCONFIG,
			"tsconfig.base.json": STRICT_BASE,
			"tsconfig.loose.json": LOOSE_BASE,
		});
		const warnings: string[] = [];
		const d = evaluateConfigLooseningForEvent(
			editEvent(root, "tsconfig.json", "./tsconfig.base.json", "./tsconfig.loose.json"),
			warnings,
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("config_loosening_gate");
		expect(d?.reason).toContain("[strict]");
		expect(d?.reason).toContain("[noUncheckedIndexedAccess]");
		expect(d?.reason).toContain("effective config of tsconfig.json");
		expect(d?.reason).toContain("tsconfig.json → tsconfig.loose.json");
	});

	it("P2: loosen the extends target itself", () => {
		// The target's OWN effective noImplicitAny is false before and after,
		// so the per-file comparison is green; the referencer carries
		// `strict: true` and loses noImplicitAny through the merge.
		const root = makeRepo({
			"tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { strict: true } }),
			"tsconfig.base.json": JSON.stringify({ compilerOptions: { target: "ES2022" } }),
		});
		const d = evaluateConfigLooseningForEvent(
			editEvent(root, "tsconfig.base.json", '"target":"ES2022"', '"target":"ES2022","noImplicitAny":false'),
			[],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("[noImplicitAny]");
		expect(d?.reason).toContain("effective config of tsconfig.json");
		expect(d?.reason).not.toContain("[strict]");
	});

	it("P3: new tsconfig with strict false referenced by the project", () => {
		const root = makeRepo({ "tsconfig.json": ROOT_TSCONFIG, "tsconfig.base.json": STRICT_BASE });
		// Step 1: repoint at a file that does not exist yet — undecidable, so
		// it is allowed with a warning that names the missing target.
		const step1Warnings: string[] = [];
		const step1 = evaluateConfigLooseningForEvent(
			editEvent(root, "tsconfig.json", "./tsconfig.base.json", "./tsconfig.app.json"),
			step1Warnings,
		);
		expect(step1).toBeNull();
		expect(step1Warnings.join("\n")).toContain('extends "./tsconfig.app.json", which does not exist');
		writeFileSync(join(root, "tsconfig.json"), ROOT_TSCONFIG.replace("./tsconfig.base.json", "./tsconfig.app.json"));
		// Step 2: create the new, untracked base with strict false.
		const d = evaluateConfigLooseningForEvent(writeEvent(root, "tsconfig.app.json", LOOSE_BASE), []);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("[strict]");
		expect(d?.reason).toContain("effective config of tsconfig.json");
		expect(d?.reason).toContain("tsconfig.app.json");
	});
});

describe("config extends — negative (must not fire)", () => {
	it("N1: honest extends repoint to an equally strict base", () => {
		const root = makeRepo({
			"tsconfig.json": ROOT_TSCONFIG,
			"tsconfig.base.json": STRICT_BASE,
			"tsconfig.strict2.json": JSON.stringify({
				compilerOptions: { noUncheckedIndexedAccess: true, strict: true, noUnusedLocals: true },
			}),
		});
		const warnings: string[] = [];
		const d = evaluateConfigLooseningForEvent(
			editEvent(root, "tsconfig.json", "./tsconfig.base.json", "./tsconfig.strict2.json"),
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("N2: unresolvable package extends warns and allows", () => {
		const root = makeRepo({ "tsconfig.json": ROOT_TSCONFIG, "tsconfig.base.json": STRICT_BASE });
		const warnings: string[] = [];
		const d = evaluateConfigLooseningForEvent(
			editEvent(root, "tsconfig.json", "./tsconfig.base.json", "@tsconfig/strictest/tsconfig.json"),
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("NOT DECIDED");
		expect(warnings[0]).toContain('"@tsconfig/strictest/tsconfig.json", a package specifier');
	});

	it("N3: earlier on-disk drift in the base is not blamed on an unrelated tightening", () => {
		const root = makeRepo({ "tsconfig.json": ROOT_TSCONFIG, "tsconfig.base.json": STRICT_BASE });
		writeFileSync(join(root, "tsconfig.base.json"), LOOSE_BASE);
		const d = evaluateConfigLooseningForEvent(
			editEvent(root, "tsconfig.json", '"noEmit":true', '"noEmit":true,"noUnusedLocals":true'),
			[],
		);
		expect(d).toBeNull();
	});

	it("N4: a new tsconfig nothing extends is allowed without a warning", () => {
		const root = makeRepo({ "tsconfig.json": ROOT_TSCONFIG, "tsconfig.base.json": STRICT_BASE });
		const warnings: string[] = [];
		const d = evaluateConfigLooseningForEvent(writeEvent(root, "tsconfig.scratch.json", LOOSE_BASE), warnings);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});
});
