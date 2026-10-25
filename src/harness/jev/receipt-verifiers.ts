/** Experimental deterministic verification of one explicit claim grammar and supplied run identity. */
import { isAbsolute, relative, resolve } from "node:path";

export interface TestReceipt {
    id: string;
    completion: "completed" | "running" | "missing";
    sourceIdentity: string | null;
    selection: string[] | null;
    runner: Record<string, unknown> | null;
}
interface ClaimScope { receiptId: string; sourceIdentity: string; selection: string[] }
interface TestClaim extends ClaimScope {
    family: "all_executed_tests_passed";
    expectedPassed: number;
    passage: { text: string; span: [number, number] };
}
interface TestVerdict {
    status: "supported" | "contradicted" | "unsupported" | "not_assessable";
    reason: string;
    receiptId: string;
}

/** Scope is an explicit interpretation input. Never infer whole-repository scope from a count. */
export function interpretTestClaim(text: string, scope: ClaimScope): TestClaim | null {
    const match = /^All ([1-9]\d*) executed tests passed\.$/.exec(text);
    if (!match) return null;
    const expectedPassed = Number(match[1]);
    if (!Number.isSafeInteger(expectedPassed) || !scope.receiptId || !scope.sourceIdentity || !scope.selection.length) return null;
    return { ...scope, family: "all_executed_tests_passed", expectedPassed, passage: { text, span: [0, text.length] } };
}

/** A selection is a set of targets: order and duplicates carry no meaning on either side. */
function normalizedSelection(values: string[]): string {
    return JSON.stringify([...new Set(values)].sort());
}

function countsOf(runner: Record<string, unknown>) {
    const fields = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"] as const;
    if (typeof runner.success !== "boolean" || fields.some(field => typeof runner[field] !== "number" || !Number.isSafeInteger(runner[field]) || runner[field] < 0)) return null;
    const [total, passed, failed, pending, todo] = fields.map(field => Number(runner[field]));
    if (total !== passed! + failed! + pending! + todo!) return null;
    return { success: runner.success, total: total!, passed: passed!, failed: failed! };
}

/** Verifies the typed receipt only; it does not authenticate its producer or infer missing capture. */
export function verifyTestClaim(claim: TestClaim, receipt: TestReceipt): TestVerdict {
    const verdict = (status: TestVerdict["status"], reason: string): TestVerdict => ({ status, reason, receiptId: receipt.id });
    if (claim.receiptId !== receipt.id) return verdict("not_assessable", "cited_receipt_missing");
    if (receipt.completion !== "completed") return verdict("not_assessable", "execution_not_completed");
    if (!receipt.runner || !receipt.sourceIdentity || !receipt.selection?.length) return verdict("not_assessable", "receipt_incomplete");
    if (claim.sourceIdentity !== receipt.sourceIdentity) return verdict("unsupported", "different_source_identity");
    if (normalizedSelection(claim.selection) !== normalizedSelection(receipt.selection)) return verdict("unsupported", "different_test_selection");
    const counts = countsOf(receipt.runner);
    if (!counts) return verdict("not_assessable", "invalid_or_unsupported_runner_report");
    if (!counts.success || counts.failed !== 0) return verdict("contradicted", "runner_reported_failure");
    if (counts.passed !== claim.expectedPassed) return verdict("contradicted", "passed_count_differs");
    return verdict("supported", "matching_completed_runner_result");
}
/** Evaluation-only verification of narrow operational predicates and supplied identities. */
interface ReceiptScope { receiptId: string; cwd: string; sourceIdentity: string; selection: string[] }
export interface OperationalReceipt {
    id: string; cwd: string; sourceIdentity: string | null; selection: string[] | null;
    completion: "completed" | "running" | "missing" | "cancelled"; exitCode: number | null; signal: string | null;
    runner: "command" | "typescript"; directInvocation: boolean; outputComplete: boolean;
    stdout: string; stderr: string; sourceUnchanged: boolean | null;
    fileWrite?: { path: string; observedByCall: string; afterSha256: string; bytesWritten: number };
}
interface OperationalClaim extends ReceiptScope {
    family: "command_completed" | "typecheck_clean" | "file_written";
    path?: string; passage: { text: string; span: [number, number] };
}
interface Verdict { status: "supported" | "contradicted" | "unsupported" | "not_assessable"; reason: string; receiptId: string }

export function interpretOperationalClaim(text: string, scope: ReceiptScope): OperationalClaim | null {
    if (!scope.receiptId || !scope.cwd || !scope.sourceIdentity || !scope.selection.length) return null;
    const passage: OperationalClaim["passage"] = { text, span: [0, text.length] };
    if (text === "Command completed.") return { ...scope, family: "command_completed", passage };
    if (text === "Typecheck completed cleanly.") return { ...scope, family: "typecheck_clean", passage };
    const file = /^File `([^`\r\n]+)` was written\.$/.exec(text);
    return file ? { ...scope, family: "file_written", path: file[1]!, passage } : null;
}

/**
 * String normalization only (no filesystem, no symlinks): the path resolved against `cwd`.
 * An absolute path is compared by its resolved form wherever it sits; a relative path
 * that escapes `cwd` (or names `cwd` itself) is null, so `../x` never matches by resolution.
 */
function resolvedWritePath(cwd: string, path: string): string | null {
    const resolved = resolve(cwd, path);
    if (isAbsolute(path)) return resolved;
    const rel = relative(cwd, resolved);
    const escapes = rel === "" || isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..";
    return escapes ? null : resolved;
}

/** The write observation stands on its own evidence: it is bound to the receipt by `observedByCall`, not by process termination. */
function verifyObservedWrite(claim: OperationalClaim, receipt: OperationalReceipt, result: (status: Verdict["status"], reason: string) => Verdict): Verdict {
    const write = receipt.fileWrite;
    if (!write || write.observedByCall !== receipt.id || !/^[a-f0-9]{64}$/.test(write.afterSha256)
        || !Number.isSafeInteger(write.bytesWritten) || write.bytesWritten < 0) return result("not_assessable", "write_observation_missing");
    const observed = resolvedWritePath(receipt.cwd, write.path);
    const claimed = resolvedWritePath(claim.cwd, claim.path ?? "");
    return observed !== null && observed === claimed ? result("supported", "matching_observed_write") : result("unsupported", "different_written_path");
}

/** Caller-supplied capture is evidence, not authenticated fact; no natural-language receipt inference. */
export function verifyOperationalClaim(claim: OperationalClaim, receipt: OperationalReceipt): Verdict {
    const result = (status: Verdict["status"], reason: string): Verdict => ({ status, reason, receiptId: receipt.id });
    if (claim.receiptId !== receipt.id) return result("not_assessable", "receipt_identity_missing");
    if (!receipt.sourceIdentity || !receipt.selection) return result("not_assessable", "scope_not_captured");
    if (claim.cwd !== receipt.cwd || claim.sourceIdentity !== receipt.sourceIdentity || normalizedSelection(claim.selection) !== normalizedSelection(receipt.selection)) return result("unsupported", "different_execution_scope");
    if (claim.family === "file_written") return verifyObservedWrite(claim, receipt, result);
    if (receipt.completion === "cancelled") return result("contradicted", "execution_cancelled");
    if (receipt.completion !== "completed") return result("not_assessable", "completion_not_observed");
    if (receipt.signal !== null) return result("contradicted", "execution_terminated_by_signal");
    if (!Number.isInteger(receipt.exitCode)) return result("not_assessable", "terminal_exit_not_captured");
    if (claim.family === "command_completed") return result("supported", "terminal_command_result");
    if (!receipt.directInvocation || receipt.runner !== "typescript") return result("not_assessable", "direct_compiler_result_missing");
    if (!receipt.outputComplete || receipt.sourceUnchanged !== true) return result("not_assessable", "incomplete_output_or_source_identity");
    return receipt.exitCode === 0 ? result("supported", "selected_compiler_completed_cleanly") : result("contradicted", "compiler_failed");
}

