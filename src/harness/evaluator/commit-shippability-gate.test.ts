// Real temp git repos: the gate's whole job is to compare the index, the
// tracked set and the working tree, so a mock would only restate the code.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { runCommitShippabilityGate } from "./commit-shippability-gate.js";

// Real git everywhere; these two switches only simulate an environment the
// temp repos cannot produce (no typescript parser, a blob git cannot show).
const sim = vi.hoisted(() => ({ noParser: false, noBlob: false }));
vi.mock("../checks/cyclomatic-ast.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../checks/cyclomatic-ast.js")>();
	type Args = Parameters<typeof real.parseTsSource>;
	return { ...real, parseTsSource: (...args: Args) => (sim.noParser ? null : real.parseTsSource(...args)) };
});
vi.mock("./commit-git-io.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./commit-git-io.js")>();
	type Args = Parameters<typeof real.gitShow>;
	return { ...real, gitShow: (...args: Args) => (sim.noBlob ? null : real.gitShow(...args)) };
});

const TAG = "[interlinked:commit-shippability]";
let repo: string;
const cleanup: string[] = [];

function git(...args: string[]): string {
	return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf-8" });
}

function put(rel: string, content: string): void {
	const abs = join(repo, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

function event(command: string, cwd = repo): HarnessEvent {
	// SAFETY: the gate reads only tool_name / tool_input.command / cwd.
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command }, timestamp: "t", cwd } as HarnessEvent;
}

function run(command = "git commit -m x", cwd = repo): string[] {
	const pre: HarnessDecision = { decision: "allow" };
	expect(runCommitShippabilityGate(event(command, cwd), pre)).toBeUndefined();
	expect(pre.decision).toBe("allow");
	return pre.warnings ?? [];
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "shippability-"));
	cleanup.push(repo);
	git("init", "-q");
	put(".gitignore", "scripts/*\nsecret/\n");
	put("README.md", "base\n");
	git("add", "-A");
	git("commit", "-q", "-m", "base");
});

afterEach(() => {
	sim.noParser = false;
	sim.noBlob = false;
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runCommitShippabilityGate — positive (must fire)", () => {
	it("P1: // test-contract: a staged file importing an untracked sibling warns with file:line and target", () => {
		put("src/b.ts", "export const b = 1;\n");
		put("src/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
		git("add", "src/a.ts");
		const warnings = run();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toBe(`${TAG} src/a.ts:1 imports src/b.ts, which is untracked — a clean checkout of this commit will not have it.`);
	});

	it("P2: // test-contract: importing a gitignored file (require and dynamic import included) says ignored", () => {
		put("secret/k.ts", "export const k = 1;\n");
		put("src/c.ts", 'const k = require("../secret/k");\nexport const load = () => import("../secret/k.js");\nexport { k };\n');
		git("add", "src/c.ts");
		const warnings = run();
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("src/c.ts:1 imports secret/k.ts, which is ignored");
		expect(warnings[1]).toContain("src/c.ts:2 imports secret/k.ts, which is ignored");
	});

	it("P3: // test-contract: a workflow running a gitignored script warns", () => {
		put("scripts/x.mjs", "console.log(1);\n");
		put(".github/workflows/ci.yml", "jobs:\n  t:\n    steps:\n      - run: node scripts/x.mjs --fast\n");
		git("add", ".github/workflows/ci.yml");
		expect(run()).toEqual([`${TAG} .github/workflows/ci.yml runs scripts/x.mjs, which is ignored — CI's checkout will not have it.`]);
	});

	it("P4: workflow block scalars are scanned and a path that is untracked or missing is named", () => {
		put("tools/gen.py", "print(1)\n");
		put(".github/workflows/ci.yaml", "jobs:\n  t:\n    steps:\n      - name: gen\n        run: |\n          python ./tools/gen.py\n          bash src/none.sh\n\n          echo done\n      - run: >-\n          node bin/folded.js\n      - uses: actions/checkout@v4\n");
		git("add", ".github/workflows/ci.yaml");
		const warnings = run();
		expect(warnings.map((w) => w.replace(/^.* runs /, ""))).toEqual([
			"tools/gen.py, which is untracked — CI's checkout will not have it.",
			"src/none.sh, which is missing — CI's checkout will not have it.",
			"bin/folded.js, which is missing — CI's checkout will not have it.",
		]);
	});

	it("P5: staging a source file triggers the check of an already tracked workflow", () => {
		put(".github/workflows/ci.yml", "steps:\n  - run: node src/gone.mjs\n");
		git("add", "-A");
		git("commit", "-q", "-m", "wf");
		put("src/new.ts", "export const n = 1;\n");
		git("add", "src/new.ts");
		expect(run()).toHaveLength(1);
	});

	it("P6: more than ten findings are capped with a summary line", () => {
		const imports = Array.from({ length: 12 }, (_, i) => `import "./u${i}.js";`).join("\n");
		for (let i = 0; i < 12; i++) put(`src/u${i}.ts`, "export {};\n");
		put("src/many.ts", `${imports}\n`);
		git("add", "src/many.ts");
		const warnings = run();
		expect(warnings).toHaveLength(11);
		expect(warnings[10]).toBe(`${TAG} and 2 more finding(s) not shown.`);
	});

	it("P7: more than 200 staged files report that only the first 200 were inspected", () => {
		for (let i = 0; i < 201; i++) put(`docs/f${i}.md`, `${i}\n`);
		git("add", "docs");
		expect(run()).toEqual([`${TAG} NOT CHECKED: only the first 200 of 201 staged files were inspected.`]);
	});
});

describe("runCommitShippabilityGate — negative (must not fire)", () => {
	it("N1: // test-contract: importing a tracked file is silent", () => {
		put("src/b.ts", "export const b = 1;\n");
		git("add", "src/b.ts");
		git("commit", "-q", "-m", "b");
		put("src/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
		git("add", "src/a.ts");
		expect(run()).toEqual([]);
	});

	it("N2: // test-contract: importing a staged-but-new file, a directory index and a package is silent", () => {
		put("src/b.ts", "export const b = 1;\n");
		put("src/lib/index.ts", "export const i = 1;\n");
		put("src/a.ts", 'import { b } from "./b.js";\nimport { i } from "./lib";\nimport fs from "node:fs";\nexport const a = [b, i, fs];\n');
		git("add", "src");
		expect(run()).toEqual([]);
	});

	it("N3: // test-contract: a non-commit Bash command and a non-Bash tool never warn", () => {
		put("src/b.ts", "export const b = 1;\n");
		put("src/a.ts", 'import { b } from "./b.js";\n');
		git("add", "src/a.ts");
		expect(run("git status")).toEqual([]);
		const pre: HarnessDecision = { decision: "allow" };
		runCommitShippabilityGate({ ...event("git commit -m x"), tool_name: "Edit" }, pre);
		expect(pre.warnings).toBeUndefined();
	});

	it("N4: // test-contract: a workflow naming a tracked script is silent", () => {
		put("tools/ok.sh", "echo ok\n");
		put(".github/workflows/ci.yml", "steps:\n  - run: bash tools/ok.sh && echo 'the scripts/ directory'\n  - run: echo src/ and foo/src/x.js\n");
		git("add", "-A");
		expect(run()).toEqual([]);
	});

	it("N5: // test-contract: a cwd that is not a git repo yields one NOT CHECKED line and never throws", () => {
		const bare = mkdtempSync(join(tmpdir(), "shippability-bare-"));
		cleanup.push(bare);
		expect(run("git commit -m x", bare)).toEqual([`${TAG} NOT CHECKED: ${bare} is not inside a git repository.`]);
	});

	it("N6: an import that resolves to nothing at all is not this gate's finding", () => {
		put("src/a.ts", 'import "./nowhere.js";\n');
		git("add", "src/a.ts");
		expect(run()).toEqual([]);
	});

	it("N7: a commit that stages only documentation skips the workflow scan", () => {
		put(".github/workflows/ci.yml", "steps:\n  - run: node src/gone.mjs\n");
		git("add", "-A");
		git("commit", "-q", "-m", "wf");
		put("README.md", "changed\n");
		git("add", "README.md");
		expect(run()).toEqual([]);
	});

	it("N8: an already-blocked decision is left untouched", () => {
		const pre: HarnessDecision = { decision: "block", reason: "r" };
		runCommitShippabilityGate(event("git commit -m x"), pre);
		expect(pre.warnings).toBeUndefined();
	});

	it("N9: a relative import that escapes the repository is not judged", () => {
		put("a.ts", 'import "../../outside.js";\n');
		git("add", "a.ts");
		expect(run()).toEqual([]);
	});

	it("N10: an unparseable specifier (non-literal require) is ignored", () => {
		put("src/a.ts", "const n = './x';\nexport const v = require(n);\n");
		git("add", "src/a.ts");
		expect(run()).toEqual([]);
	});
});

describe("runCommitShippabilityGate — git failure (never throws)", () => {
	it("N12: an unavailable typescript parser is one NOT CHECKED line, not a silent pass", () => {
		put("src/a.ts", 'import "./b.js";\n');
		git("add", "src/a.ts");
		sim.noParser = true;
		expect(run()).toEqual([`${TAG} NOT CHECKED: the typescript parser is unavailable, so staged imports were not inspected.`]);
	});

	it("N13: a staged blob and a workflow blob that git cannot show are skipped without a warning", () => {
		put("src/a.ts", 'import "./b.js";\n');
		put(".github/workflows/ci.yml", "steps:\n  - run: node src/gone.mjs\n");
		git("add", "-A");
		sim.noBlob = true;
		expect(run()).toEqual([]);
	});

	it("N14: `git -C <repo> commit` is judged in that repo even when the event cwd is empty", () => {
		put("src/b.ts", "export {};\n");
		put("src/a.ts", 'import "./b.js";\n');
		git("add", "src/a.ts");
		const warnings = run(`git -C ${repo} commit -m x`, "");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("src/a.ts:1 imports src/b.ts, which is untracked");
	});

	it("N15: an event whose fields throw is a NOT CHECKED line, never an exception", () => {
		// SAFETY: a deliberately partial event; the gate must survive a field that throws on read.
		const hostile = { tool_name: "Bash", tool_input: { command: "git commit -m x" } } as unknown as HarnessEvent;
		Object.defineProperty(hostile, "cwd", { get: () => { throw new Error("boom"); } });
		const pre: HarnessDecision = { decision: "allow" };
		expect(() => runCommitShippabilityGate(hostile, pre)).not.toThrow();
		expect(pre.warnings).toEqual([`${TAG} NOT CHECKED: an unexpected error stopped the check.`]);
	});

	it("N11: a corrupt index (repo resolves, listing fails) is one NOT CHECKED line, not a crash", () => {
		put("src/a.ts", "export {};\n");
		git("add", "src/a.ts");
		writeFileSync(join(repo, ".git", "index"), "garbage");
		expect(run()).toEqual([`${TAG} NOT CHECKED: git diff --cached failed.`]);
	});
});
