// ===========================================
// metrics-stale-readme tests — pure classification + the live command
// against real throwaway git repos
// ===========================================
// The count is "commits that touched the README's directory since the
// README's own last commit, excluding the README". Mocking git would prove
// nothing about the `git log -1` / `git rev-list --count … :(exclude)` contract
// the command relies on, so the command tests build real repos in a tmpdir.
// Calibration (this tree, 2026-09-21, 18 tracked READMEs): 116, 59, 32, 16, 7,
// 3, 3, 1, 1, 0×9 — the default threshold of 10 sits in the 7→16 gap.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyReadmes,
	DEFAULT_STALE_README_THRESHOLD,
	isAuditableReadme,
	metricsStaleReadmeCommand,
	type ReadmeCount,
} from "./metrics-stale-readme.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
}

/** A repo with `src/README.md`, `src/a.ts`, and `other/b.ts`, one commit each. */
function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "il-stale-readme-"));
	roots.push(root);
	git(root, "init", "--quiet", "-b", "main");
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "other"));
	writeFileSync(join(root, "src/README.md"), "# src\n");
	writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "other/b.ts"), "export const b = 1;\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "init");
	return root;
}

function commitEdit(root: string, rel: string, content: string, message: string): void {
	writeFileSync(join(root, rel), content);
	git(root, "add", rel);
	git(root, "commit", "--quiet", "-m", message);
}

/** `output()` prints through console.log, which vitest intercepts before process.stdout — spy there. */
function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		chunks.push(args.map(String).join(" "));
	});
	return fn().then(() => {
		spy.mockRestore();
		return chunks.join("\n");
	});
}

describe("isAuditableReadme", () => {
	it("P1: a README under product or docs directories is auditable", () => {
		expect(isAuditableReadme("README.md")).toBe(true);
		expect(isAuditableReadme("src/harness/adapters/README.md")).toBe(true);
		expect(isAuditableReadme("docs/README.md")).toBe(true);
	});

	it("N1: fixture, test-fixture and dependency READMEs are not — nobody keeps those current on purpose", () => {
		expect(isAuditableReadme("evals/fixtures/python/README.md")).toBe(false);
		expect(isAuditableReadme("src/harness/structure/__tests__/fixtures/x/README.md")).toBe(false);
		expect(isAuditableReadme("node_modules/left-pad/README.md")).toBe(false);
		expect(isAuditableReadme("src/notes.md")).toBe(false);
	});
});

describe("classifyReadmes", () => {
	const rows: ReadmeCount[] = [
		{ readme: "README.md", dir: ".", since_sha: "aaa", commits_since: 116 },
		{ readme: "src/x/README.md", dir: "src/x", since_sha: "bbb", commits_since: 7 },
		{ readme: "src/y/README.md", dir: "src/y", since_sha: "ccc", commits_since: 16 },
		{ readme: "new/README.md", dir: "new", since_sha: null, commits_since: 0 },
	];

	it("P1: marks rows strictly over the threshold stale and sorts by count desc", () => {
		const out = classifyReadmes(rows, 10);
		expect(out.map((r) => [r.readme, r.stale])).toEqual([
			["README.md", true],
			["src/y/README.md", true],
			["src/x/README.md", false],
			["new/README.md", false],
		]);
	});

	it("P2: the default threshold is the calibrated 10, so a count of exactly 10 is not stale", () => {
		expect(DEFAULT_STALE_README_THRESHOLD).toBe(10);
		const [row] = classifyReadmes([{ readme: "r/README.md", dir: "r", since_sha: "d", commits_since: 10 }], DEFAULT_STALE_README_THRESHOLD);
		expect(row?.stale).toBe(false);
	});

	it("N1: an uncommitted README (no since_sha) is never stale, whatever the count", () => {
		const [row] = classifyReadmes([{ readme: "u/README.md", dir: "u", since_sha: null, commits_since: 99 }], 1);
		expect(row?.stale).toBe(false);
	});
});

describe("metricsStaleReadmeCommand (real git)", () => {
	it("P1: counts commits touching the README's directory since the README's last commit, excluding the README", async () => {
		const root = repo();
		commitEdit(root, "src/a.ts", "export const a = 2;\n", "a2");
		commitEdit(root, "src/a.ts", "export const a = 3;\n", "a3");
		commitEdit(root, "other/b.ts", "export const b = 2;\n", "b2 — different dir, must not count");
		const out = await captureStdout(() => metricsStaleReadmeCommand({ cwd: root, json: true, threshold: "1" }));
		const parsed = JSON.parse(out);
		expect(parsed.threshold).toBe(1);
		expect(parsed.readmes).toEqual([
			{ readme: "src/README.md", dir: "src", since_sha: expect.stringMatching(/^[0-9a-f]{40}$/), commits_since: 2, stale: true },
		]);
		expect(parsed.stale).toBe(1);
	});

	it("P4: with no --threshold the calibrated default applies — an absent flag is not zero", async () => {
		const root = repo();
		commitEdit(root, "src/a.ts", "export const a = 2;\n", "a2");
		const out = await captureStdout(() => metricsStaleReadmeCommand({ cwd: root, json: true }));
		const parsed = JSON.parse(out);
		expect(parsed.threshold).toBe(DEFAULT_STALE_README_THRESHOLD);
		expect(parsed.readmes[0]).toMatchObject({ commits_since: 1, stale: false });
	});

	it("P2: editing the README resets its count to zero", async () => {
		const root = repo();
		commitEdit(root, "src/a.ts", "export const a = 2;\n", "a2");
		commitEdit(root, "src/README.md", "# src (updated)\n", "readme refresh");
		const out = await captureStdout(() => metricsStaleReadmeCommand({ cwd: root, json: true }));
		expect(JSON.parse(out).readmes[0]).toMatchObject({ readme: "src/README.md", commits_since: 0, stale: false });
	});

	it("P3: the normal rendering lists count, README path and the stale marker, threshold in the header", async () => {
		const root = repo();
		commitEdit(root, "src/a.ts", "export const a = 2;\n", "a2");
		const out = await captureStdout(() => metricsStaleReadmeCommand({ cwd: root, threshold: "0" }));
		expect(out).toContain("Stale READMEs — 1 tracked, 1 over 0 commits");
		// two-space indent + count right-aligned in 5 columns → six spaces before "1"
		expect(out).toMatch(/\n {6}1 {2}STALE {2}src\/README\.md\n/);
	});

	it("N1: a fixture README is skipped even though git tracks it", async () => {
		const root = repo();
		mkdirSync(join(root, "evals/fixtures/x"), { recursive: true });
		commitEdit(root, "evals/fixtures/x/README.md", "# fixture\n", "fixture");
		const out = await captureStdout(() => metricsStaleReadmeCommand({ cwd: root, json: true }));
		expect(JSON.parse(out).readmes.map((r: { readme: string }) => r.readme)).toEqual(["src/README.md"]);
	});

	it("N2: outside a git repository the command exits 1 with a one-line reason and prints no report", async () => {
		const root = mkdtempSync(join(tmpdir(), "il-stale-readme-nogit-"));
		roots.push(root);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const out = await captureStdout(() => metricsStaleReadmeCommand({ cwd: root, json: true }));
		expect(out).toBe("");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/^git ls-files failed: /);
	});
});
