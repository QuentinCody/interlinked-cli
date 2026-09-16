import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { contractPath, readContractFile } from "./paths.js";

export interface ExpectationReview {
    path: string;
    kind: "expectations-changed" | "new-expectations" | "oracle-input-changed";
    message: string;
    /** Candidate detection only: a textual change does not establish lost behavior. */
    determinism: "heuristic";
}
const TEST = /(?:^|\/)(?:tests?\/|__tests__\/|test_[^/]+\.py$)|(?:_test\.(?:py|go)|\.(?:test|spec)\.[^.]+)$/;
const ORACLE = /(?:^|\/)(?:fixtures?|__snapshots__|golden)(?:\/|\.)|(?:^|\/)(?:pytest\.ini|conftest\.py|pyproject\.toml|package\.json|[\w.-]*(?:vitest|jest|pytest)[\w.-]*config[\w.-]*)$|\.snap$/;
const ASSERTION = /\b(?:assert\b|assert\w*\s*\(|expect\s*\(|pytest\.(?:raises|mark)|unittest\.skip|mock\b|mock\w*\s*\(|\.skip\s*\(|toMatch\w*Snapshot)/;
export function isOraclePath(path: string): boolean { return TEST.test(path) || ORACLE.test(path); }

export function reviewExpectationDiff(path: string, diff: string): ExpectationReview | null {
    const removed = diff.split("\n").filter(line => line.startsWith("-") && !line.startsWith("---")).map(line => line.slice(1).trim());
    const added = diff.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1).trim());
    const changed = [...removed.filter(line => !added.includes(line)), ...added.filter(line => !removed.includes(line))];
    if (!changed.some(line => line.trim())) return null;
    const common = { path, determinism: "heuristic" as const };
    if (ORACLE.test(path)) return { ...common, kind: "oracle-input-changed", message: "Fixture, snapshot, mock setup or collection configuration changed. Review the requirement authorizing it; preserve prior cases or record an intentional replacement. A new green run alone does not establish preservation." };
    if (!TEST.test(path) || !changed.some(line => ASSERTION.test(line))) return null;
    if (diff.includes("new file mode")) return { ...common, kind: "new-expectations", message: "Ground new test expectations in a supplied requirement or public example, independently of the implementation. Record concrete examples with interlinked tests contracts; a passing self-authored assertion is not contract validation." };
    return { ...common, kind: "expectations-changed", message: "Assertions, mocks or skips changed. Compare old and new expectations with the requirement; retain old invocation modes unless explicitly replaced. Text matching is advisory and may include moved or parameterized tests." };
}

/** Bounded diffs for explicit paths; never walks dependency/scratch trees. */
export function reviewExpectations(root: string, paths: readonly string[], base = "HEAD"): { findings: ExpectationReview[]; gaps: string[] } {
    const findings: ExpectationReview[] = [], gaps: string[] = [];
    if (!base || base.startsWith("-") || base.includes("\0")) return { findings, gaps: ["Invalid expectation baseline revision"] };
    const selected = [...new Set(paths.map(path => isAbsolute(path) ? relative(root, path) : path))].filter(isOraclePath);
    if (!selected.length) return { findings, gaps };
    if (selected.length > 32) gaps.push("Expectation review limited to 32 changed paths");
    const deadline = Date.now() + 500;
    for (const path of selected.slice(0, 32)) {
        if (Date.now() >= deadline) { gaps.push("Expectation diff budget exhausted; remaining paths unreviewed"); break; }
        try {
            contractPath(root, path);
            const tracked = execFileSync("git", ["ls-files", "--", path], { cwd: root, timeout: 250, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
            const text = !tracked && existsSync(contractPath(root, path)) ? "new file mode\n" + readContractFile(root, path, 256 * 1024).split("\n").map(line => `+${line}`).join("\n") : execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", base, "--", path], { cwd: root, timeout: 250, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
            const finding = reviewExpectationDiff(path, text);
            if (finding) findings.push(finding);
        } catch { gaps.push(`${path}: expectation baseline/diff unavailable; no preservation verdict`); }
    }
    return { findings, gaps };
}
