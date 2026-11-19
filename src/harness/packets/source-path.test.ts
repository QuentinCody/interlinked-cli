import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escapesRoot, isGlobalSource, resolveSourcePath } from "./source-path.js";

describe("escapesRoot — a repo-relative name that leaves the repo through a symlink (R6 Y4)", () => {
	it("E1: a name under a symlinked folder that points outside the repo escapes; a plain name does not", () => {
		const root = mkdtempSync(join(tmpdir(), "il-src-root-"));
		const outside = mkdtempSync(join(tmpdir(), "il-src-out-"));
		writeFileSync(join(outside, "AGENTS.md"), "x");
		writeFileSync(join(root, "AGENTS.md"), "y");
		symlinkSync(outside, join(root, "link"));
		expect(escapesRoot(root, "link/AGENTS.md")).toBe(true);
		expect(escapesRoot(root, "link/missing.md")).toBe(true);
		expect(escapesRoot(root, "AGENTS.md")).toBe(false);
		expect(escapesRoot(root, "docs/new.md")).toBe(false);
	});
	it("E2: a dangling symlink escapes (fail closed); a missing root escapes instead of throwing", () => {
		const root = mkdtempSync(join(tmpdir(), "il-src-root-"));
		symlinkSync(join(tmpdir(), "il-src-gone", "AGENTS.md"), join(root, "AGENTS.md"));
		expect(escapesRoot(root, "AGENTS.md")).toBe(true);
		expect(escapesRoot(join(root, "missing-root"), "x.md")).toBe(true);
	});
});

describe("isGlobalSource — a source outside the repo is never released from here", () => {
	it("G1: `~/` names a home file", () => {
		expect(isGlobalSource("~/.claude/CLAUDE.md")).toBe(true);
	});
	it("G2: a `../` name that escapes the repo root is global (budget and release refuse it)", () => {
		expect(isGlobalSource("../sibling/AGENTS.md")).toBe(true);
		expect(isGlobalSource("docs/../../outside.md")).toBe(true);
		expect(isGlobalSource("./../outside.md")).toBe(true);
		expect(isGlobalSource("..")).toBe(true);
	});
	it("G3: an absolute name is global", () => {
		expect(isGlobalSource("/etc/AGENTS.md")).toBe(true);
	});
	it("L1: a name that stays inside the repo is local", () => {
		expect(isGlobalSource("AGENTS.md")).toBe(false);
		expect(isGlobalSource("docs/rules.md")).toBe(false);
		expect(isGlobalSource("docs/../AGENTS.md")).toBe(false);
		expect(isGlobalSource("..notes/x.md")).toBe(false);
		expect(isGlobalSource("~other/x.md")).toBe(false);
	});
});

describe("resolveSourcePath — where an instruction file named in a packet lives", () => {
	it("P1: a repo-relative name resolves under cwd", () => {
		expect(resolveSourcePath("/repo", "AGENTS.md")).toBe(join("/repo", "AGENTS.md"));
		expect(resolveSourcePath("/repo", "docs/rules.md")).toBe(join("/repo", "docs/rules.md"));
	});
	it("P2: `~/` names the user's home directory (the global CLAUDE.md is an instruction file too)", () => {
		expect(resolveSourcePath("/repo", "~/.claude/CLAUDE.md")).toBe(join(homedir(), ".claude", "CLAUDE.md"));
	});
	it("P3: an absolute name resolves to itself, not under cwd", () => {
		expect(resolveSourcePath("/repo", "/etc/AGENTS.md")).toBe("/etc/AGENTS.md");
	});
	it("N1: a bare `~` or `~user` form is not expanded (only `~/`)", () => {
		expect(resolveSourcePath("/repo", "~other/x.md")).toBe(join("/repo", "~other/x.md"));
	});
});
