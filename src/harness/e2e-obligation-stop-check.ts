import { isAbsolute, relative } from "node:path";
import { isBoundaryFile, isInterlinkedCheckout } from "./e2e-boundary.js";

/** Interlinked's OWN self-test reminder (plan 31 §15): confined to the Interlinked checkout; a host repository's only e2e obligation is its project policy. */
export function formatE2eObligationWarning(input: { cwd: string; files: Iterable<string>; lanes: readonly string[] }): string | null {
    if (input.lanes.includes("e2e") || !isInterlinkedCheckout(input.cwd)) return null;
    const boundaries = [...input.files].map((path) => isAbsolute(path) ? relative(input.cwd, path) : path).filter(isBoundaryFile);
    if (boundaries.length === 0) return null;
    return `[interlinked:e2e-obligation] ${boundaries.length} boundary file(s) changed without an e2e invocation in this session. Run npm run test:e2e from this session (${boundaries.slice(0, 5).join(", ")}).`;
}
