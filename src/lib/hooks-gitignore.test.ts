import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "../harness/workspace-effects.js";
import { ensureGitignore } from "./hooks-gitignore.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("keeps harness output churn out of tool effects while preserving source, policy and tracked output", () => {
    const root = mkdtempSync(join(tmpdir(), "interlinked-ignore-effects-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    ensureGitignore(root);
    const write = (path: string, content: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    };
    write(".interlinked/timeline.jsonl", "before");
    execFileSync("git", ["add", "-f", ".interlinked/timeline.jsonl"], { cwd: root });
    const before = captureWorkspaceSnapshot(root);
    for (const path of ["capture-receipts.jsonl", "logs/latency.jsonl", "metrics/executions.jsonl",
        "test-runs/latest.json", "capture/state/session.json", "hook-translations.jsonl", "hook-coverage.json"]) {
        write(`.interlinked/${path}`, "runtime output");
    }
    write(".interlinked/guard-rules.json", "{}");
    write(".interlinked/timeline.jsonl", "after");
    write("source.py", "def value(): return 1\n");
    const changed = diffWorkspaceSnapshots(before, captureWorkspaceSnapshot(root)).files.map(file => file.path);
    expect(changed).toEqual([".interlinked/guard-rules.json", ".interlinked/timeline.jsonl", "source.py"]);
    expect(ensureGitignore(root)).toBe(false);
});
