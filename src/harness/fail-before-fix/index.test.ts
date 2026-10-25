// End to end: a temporary git project, a session that fixes `sum` and adds tests, the session's edits in the
// harness log, and the real vitest binary in both the live tree and the pre-session copy.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCollectionPath } from "../../lib/collection/writer.js";
import { failBeforeFix, subjectChanged } from "./index.js";

const REPO_NODE_MODULES = join(process.cwd(), "node_modules");
const TIMEOUT = 120_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const OLD_TEST = `import { expect, it } from "vitest";\nimport { sum } from "./sum.js";\nit("keeps zero", () => { expect(sum(0, 0)).toBe(0); });\nfor (const n of [1, 2]) it(\`doubles \${n} as n + n\`, () => { expect(sum(n, n) === n + n || sum(n, n) === 0).toBe(true); });\n`;
const NEW_TESTS = `it("adds two numbers", () => { expect(sum(2, 3)).toBe(5); });\nit("returns a number", () => { expect(typeof sum(1, 1)).toBe("number"); });\n`;

const COMMIT_DATE = "2026-01-01T00:00:00Z"; // HEAD is older than every logged edit below
function git(root: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE } });
}
function edit(root: string, ts: string, session: string, path: string, old: string, next: string): string {
    return JSON.stringify({ schema: "collection.v1", kind: "tool_event", ts, seq: 1, session_id: session, phase: "post", provider_tool: "Edit", cwd: root, action: { path: join(root, path), diff: { hunks: [{ old, new: next }] } }, observation: { applied: true }, outcome: "ok" });
}
/** HEAD holds the bug (a - b) and one old test; the working tree holds the session's fix and two new tests. */
function project(log: (root: string) => string[]): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fbf-e2e-"))); roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fbf-fixture", type: "module" }));
    writeFileSync(join(root, ".gitignore"), "node_modules\n.interlinked\n");
    writeFileSync(join(root, "src/sum.ts"), "export function sum(a: number, b: number): number { return a - b; }\n");
    writeFileSync(join(root, "src/sum.test.ts"), OLD_TEST);
    symlinkSync(REPO_NODE_MODULES, join(root, "node_modules"));
    git(root, "init", "--quiet"); git(root, "add", "."); git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
    writeFileSync(join(root, "src/sum.ts"), "export function sum(a: number, b: number): number { return a + b; }\n");
    writeFileSync(join(root, "src/sum.test.ts"), OLD_TEST + NEW_TESTS);
    const path = getCollectionPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, log(root).join("\n") + "\n");
    return root;
}
const later = (n: number) => `2026-06-01T00:00:0${n}.000Z`;
function sessionLog(root: string): string[] {
    return [
        edit(root, later(1), "S", "src/sum.ts", "a - b", "a + b"),
        edit(root, later(2), "S", "src/sum.test.ts", OLD_TEST, OLD_TEST + NEW_TESTS),
    ];
}

describe("failBeforeFix — positive", () => {
    it("P1: a new test that fails on the pre-session code pins the fix; a new test that passes there does not; the copy is removed", async () => {
        const root = project(sessionLog);
        const report = await failBeforeFix({ root, session: "S", budgetMs: TIMEOUT });
        expect(report.status, report.reasons.join("\n")).toBe("ok");
        expect(report.files).toEqual([
            { path: "src/sum.test.ts", role: "test", state: "reverted" },
            { path: "src/sum.ts", role: "product", state: "reverted" },
        ]);
        const verdicts = Object.fromEntries(report.tests.map(row => [row.name, [row.isNew, row.verdict, row.subjectChanged]]));
        expect(verdicts).toEqual({
            "adds two numbers": [true, "fails-before-fix", true],
            "returns a number": [true, "passes-before-fix", true],
            "keeps zero": [false, "passes-before-fix", true],
            "doubles 1 as n + n": [false, "passes-before-fix", true], // a generated title is not literal in the source
            "doubles 2 as n + n": [false, "passes-before-fix", true],
        });
        expect(existsSync(report.copyDir ?? "")).toBe(false);
    }, TIMEOUT);
});

describe("failBeforeFix — negative", () => {
    it("reports unavailable when the current test file cannot load", async () => {
        const invalid = "throw new Error(\"test suite could not load\");\n";
        const root = project(r => [edit(r, later(1), "S", "src/sum.ts", "a - b", "a + b"), edit(r, later(2), "S", "src/sum.test.ts", OLD_TEST, invalid)]);
        writeFileSync(join(root, "src/sum.test.ts"), invalid);
        const report = await failBeforeFix({ root, session: "S", budgetMs: TIMEOUT });
        expect(report.status).toBe("unavailable");
        expect(report.reasons).toContain("current run produced no executed test evidence for: src/sum.test.ts");
    }, TIMEOUT);
    it("N1: a product file whose log does not reproduce its bytes makes the run unavailable; nothing runs", async () => {
        const root = project(r => [edit(r, later(1), "S", "src/sum.ts", "a - b", "a * b"), edit(r, later(2), "S", "src/sum.test.ts", OLD_TEST, OLD_TEST + NEW_TESTS)]);
        const report = await failBeforeFix({ root, session: "S", budgetMs: TIMEOUT });
        expect(report.status).toBe("unavailable");
        expect(report.files.find(row => row.path === "src/sum.ts")).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/do not reproduce the current bytes/) });
        expect(report.tests).toEqual([]);
    }, TIMEOUT);

    it("N1b: a non-code file the log cannot replay is a note, never a blocker; only code files gate the run", async () => {
        const root = project(r => [...sessionLog(r), edit(r, later(3), "S", "docs/notes.md", "draft", "final")]);
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, "docs/notes.md"), "final\n"); // never committed and never written through the log
        const report = await failBeforeFix({ root, session: "S", budgetMs: TIMEOUT });
        expect(report.status, report.reasons.join("\n")).toBe("ok");
        expect(report.files.find(row => row.path === "docs/notes.md")).toMatchObject({ role: "other", state: "unavailable" });
        expect(report.reasons).toEqual([expect.stringMatching(/^docs\/notes\.md \(not code, kept as is\): /)]);
    }, TIMEOUT);

    it("N2: a session that changed no test file has nothing to judge", async () => {
        const root = project(r => [edit(r, later(1), "S", "src/sum.ts", "a - b", "a + b")]);
        const report = await failBeforeFix({ root, session: "S", budgetMs: TIMEOUT });
        expect(report.status).toBe("no-tests");
    }, TIMEOUT);

    it("N3: an unknown session is reported, never guessed", async () => {
        const root = project(sessionLog);
        expect((await failBeforeFix({ root, session: "nobody", budgetMs: TIMEOUT })).status).toBe("no-session");
    }, TIMEOUT);
});

// Dogfood 2026-10-22: with "any changed file in the same directory", one edit to checks/iteration-safety.ts made 14
// isolating cases of UNCHANGED detectors in that 200-file directory read as concerns. The subject is what the test
// reaches: its companion module, or a module it imports at runtime.
function subjectTree(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fbf-subject-"))); roots.push(root);
    mkdirSync(join(root, "src/checks"), { recursive: true }); mkdirSync(join(root, "src/lib"), { recursive: true });
    for (const file of ["src/checks/catch.ts", "src/checks/spy.ts", "src/lib/strip.ts", "src/lib/types.ts"]) writeFileSync(join(root, file), "export const x = 1;\n");
    writeFileSync(join(root, "src/checks/catch.test.ts"), `import { x } from "./catch.js";\nimport { y } from "../lib/strip.js";\nimport type { T } from "../lib/types.js";\n`);
    writeFileSync(join(root, "src/checks/cli.test.ts"), `import { execFileSync } from "node:child_process";\n`);
    return root;
}

describe("subjectChanged — positive", () => {
    it("P2: the companion module, or a module the test imports at runtime, changed", () => {
        const root = subjectTree();
        expect(subjectChanged(root, "src/checks/catch.test.ts", new Set(["src/checks/catch.ts"]))).toBe(true);
        expect(subjectChanged(root, "src/checks/catch.test.ts", new Set(["src/lib/strip.ts"]))).toBe(true);
    });
});

describe("subjectChanged — negative", () => {
    it("N4: a changed sibling the test does not import, a type-only import, and a black-box test are not its subject", () => {
        const root = subjectTree();
        expect(subjectChanged(root, "src/checks/catch.test.ts", new Set(["src/checks/spy.ts"]))).toBe(false);
        expect(subjectChanged(root, "src/checks/catch.test.ts", new Set(["src/lib/types.ts"]))).toBe(false);
        expect(subjectChanged(root, "src/checks/cli.test.ts", new Set(["src/checks/catch.ts", "src/checks/spy.ts"]))).toBe(false);
    });
});
