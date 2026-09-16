import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { checkSingleUseTrivialHelper } from "./checks/over-extraction.js";
import { pythonSimplificationAdvice } from "./checks/python-simplification.js";
import { sourceScanScope } from "./source-scan-scope.js";
import { reviewExpectations } from "./contracts/review.js";

const MAX_FILES = 32, MAX_BYTES = 256 * 1024, MAX_FINDINGS = 5;
const SOURCE = /\.(?:py|[cm]?[jt]sx?|rs|go|java|kt|swift|rb|php|c|h|cpp|cs)$/;
const TEST = /(?:^|\/)(?:tests?\/|test_[^/]+\.py$)|(?:_test\.go|_test\.py|\.(?:test|spec)\.[^.]+)$/;
export interface ChangeReview {
    status: "review-required" | "partial";
    baseline: string;
    files: Array<{ path: string; sha256: string; role: "test" | "source" }>;
    findings: Array<{ path: string; line: number; text: string }>;
    gaps: Array<{ path: string; reason: string }>;
    excluded: Array<{ path: string; reason: string }>;
    behavioralEvidence: "not-run";
    review: string[];
}

function changedPaths(root: string, base: string): string[] {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
    const revision = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { cwd: root, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return [...new Set([...git(["diff", "--name-only", "-z", revision, "--"]), ...git(["ls-files", "--others", "--exclude-standard", "-z"])])].sort();
}

function reviewFile(root: string, path: string, report: ChangeReview): void {
    const absolute = resolve(root, path), rel = relative(root, absolute);
    try {
        if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || realpathSync(absolute) !== absolute) throw new Error("Path escapes the project or crosses a symlink");
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Source is not a regular file within the 256 KiB review budget");
        const content = readFileSync(absolute, "utf8"), sha256 = createHash("sha256").update(content).digest("hex");
        const role = TEST.test(rel) ? "test" : "source";
        report.files.push({ path: rel, sha256, role });
        const advice = role === "test" ? [] : path.endsWith(".py") ? pythonSimplificationAdvice(content, path) : checkSingleUseTrivialHelper(content, path);
        report.gaps.push(...advice.filter(row => "kind" in row && row.kind === "unavailable").map(row => ({ path: rel, reason: row.text })));
        report.findings.push(...advice.slice(0, Math.max(0, MAX_FINDINGS - report.findings.length)).map(row => ({ path: rel, line: row.line, text: row.text })));
        if (createHash("sha256").update(readFileSync(absolute)).digest("hex") !== sha256) throw new Error("Source changed during review; findings require a fresh review");
    } catch (error) { report.gaps.push({ path: rel, reason: String(error) }); }
}

/** Bounded boundary-time review. Neither source shape nor a test filename is a behavioral verdict. */
export function reviewChange(root: string, options: { paths?: readonly string[]; base?: string } = {}): ChangeReview {
    root = realpathSync(root);
    const report: ChangeReview = { status: "review-required", baseline: options.base ?? "HEAD", files: [], findings: [], gaps: [], excluded: [], behavioralEvidence: "not-run", review: [
        "Preserve established public behavior unless the requirements explicitly replace it. Retain executable assertions for previous behavior, new requirements, and relevant invalid-input boundaries; manual probes should become repeatable tests.",
        "Review the change across callers: validation belongs at the boundary that owns the contract; helpers should name cohesive responsibilities. Inspect repeated validation, forwarding chains, shared mutable state, and duplicated logic before extracting further.",
        "After relevant behavior passes, make at most one focused simplification pass over the candidates. Retain useful boundaries, rerun affected tests after changes, and leave uncertain candidates advisory. Passing tests do not prove that new requirements were covered.",
    ] };
    let paths: readonly string[];
    try { paths = options.paths?.length ? [...new Set(options.paths)] : changedPaths(root, report.baseline); }
    catch (error) { report.gaps.push({ path: ".", reason: `Change inventory unavailable: ${String(error)}` }); report.status = "partial"; return report; }
    const scope = sourceScanScope(root, options.paths);
    const expectations = reviewExpectations(root, paths.filter(path => !scope.reason(path)), report.baseline);
    report.findings.push(...expectations.findings.map(row => ({ path: row.path, line: 1, text: row.message })));
    report.gaps.push(...expectations.gaps.map(reason => ({ path: ".", reason })));
    for (const path of paths.filter(path => SOURCE.test(path))) {
        const reason = scope.reason(path);
        if (reason) { report.excluded.push({ path, reason }); continue; }
        if (report.files.length + report.gaps.length >= MAX_FILES) { report.gaps.push({ path, reason: "32-file review budget exhausted; narrow the change scope" }); continue; }
        reviewFile(root, path, report);
    }
    if (report.gaps.length) report.status = "partial";
    return report;
}
