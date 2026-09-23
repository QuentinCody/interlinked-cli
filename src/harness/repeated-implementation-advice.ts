import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { checkRepeatedImplementation } from "./checks/repeated-implementation.js";
import type { CheckResultEntry, HarnessDecision, SessionTrajectory } from "./types.js";

// Session-owned, bounded by touched files; a daemon restart can repeat an advisory.
const previous = new WeakMap<SessionTrajectory, Map<string, Set<string>>>();

function readCandidate(cwd: string, path: string): string | null {
    const rel = relative(realpathSync(cwd), realpathSync(path));
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
    return readFileSync(path, "utf8");
}

interface AdviceContext {
    cwd: string; state: Map<string, Set<string>>; decision: HarnessDecision; dryRun: boolean;
}
function inspectFile(path: string, context: AdviceContext): CheckResultEntry[] {
    const { cwd, state, decision, dryRun } = context;
    let content: string | null;
    try { content = readCandidate(cwd, path); } catch { return []; }
    if (content === null) return [];
    const findings = checkRepeatedImplementation(content, path);
    const old = state.get(path) ?? new Set<string>();
    const fresh = findings.filter(row => !old.has(row.fingerprint));
    if (fresh.length) {
        decision.warnings ??= [];
        decision.warnings.push(`[interlinked:repeated_implementation] [heuristic] ${relative(cwd, path)}: ${fresh.slice(0, 3).map(row => row.text).join("\n")}`);
        if (fresh.length > 3) decision.warnings.push("Additional groups are retained in check-results.jsonl; inspect with interlinked verify --all-checks.");
    }
    if (!dryRun) state.set(path, new Set(findings.map(row => row.fingerprint)));
    return findings.map(row => ({ source: "quality", name: "repeated_implementation",
        severity: "warning", determinism: "heuristic", phase: "post", file: path, line: row.line,
        message: row.text, detail: `group=${row.fingerprint}` }));
}

/** Invoked once after all files in the observed tool changeset have landed. */
export function appendRepeatedImplementationAdvice(
    cwd: string, paths: readonly string[], session: SessionTrajectory,
    decision: HarnessDecision, dryRun = false,
): CheckResultEntry[] {
    const state = previous.get(session) ?? new Map<string, Set<string>>();
    const results: CheckResultEntry[] = [];
    const context = { cwd, state, decision, dryRun };
    for (const path of new Set(paths.filter(Boolean).map(file => resolve(cwd, file)))) {
        results.push(...inspectFile(path, context));
    }
    if (!dryRun) previous.set(session, state);
    return results;
}
