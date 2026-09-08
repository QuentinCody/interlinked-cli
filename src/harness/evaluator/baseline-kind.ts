import { type WaterLineStem, waterLineStem } from "./water-line-files.js";

export type BaselineKind = "coverage" | "coverage-edit" | "mutation" | "large-files" | "untested-files" | "metric-caps" | "mutation-manifest" | "skipped-tests" | "check-evidence" | "function-complexity" | "lint";

const KIND_MAP: Record<WaterLineStem, BaselineKind> = {
    "coverage-baseline": "coverage",
    "coverage-edit-baseline": "coverage-edit",
    "mutation-baseline": "mutation",
    "large-files-baseline": "large-files",
    "untested-files-baseline": "untested-files",
    "metric-caps": "metric-caps",
    "mutation-manifest": "mutation-manifest",
    "skipped-tests-baseline": "skipped-tests",
    "check-evidence-baseline": "check-evidence",
    "function-complexity-baseline": "function-complexity",
    "lint-baseline": "lint",
};

export function baselineKind(filePath: string): BaselineKind | null {
    const stem = waterLineStem(filePath);
    return stem ? KIND_MAP[stem] : null;
}
