import { basename, extname } from "node:path";

/** Naming hints are discovery aids, never proof that a test covers a source file. */
export const PYTHON_TEST_FILE = /^(?:test_.*|.*_test)\.py$/i;
const TEST_FIRST_SOURCE = /\.(?:[cm]?[jt]sx?|py)$/i;

export function supportsTestFirstPath(path: string): boolean {
    return TEST_FIRST_SOURCE.test(path) && !/\.d\.[cm]?ts$/i.test(path);
}

export function companionNames(base: string, extension: string): string[] {
    return extension.toLowerCase() === ".py"
        ? [`test_${base}.py`, `${base}_test.py`]
        : [`${base}.test${extension}`, `${base}.spec${extension}`];
}

export function companionNameMatches(name: string, base: string, extension: string): boolean {
    if (extension.toLowerCase() === ".py") return companionNames(base, extension).includes(name);
    return name.startsWith(`${base}.`) &&
        ["test", "spec"].some(suffix => name.endsWith(`.${suffix}${extension}`));
}

export function companionNameHint(path: string): string {
    const extension = extname(path);
    const base = basename(path, extension);
    return extension.toLowerCase() === ".py" ? `test_${base}.py` : `${base}.test${extension}`;
}

export function tddDirectiveComment(path: string): string {
    return extname(path).toLowerCase() === ".py" ? "#" : "//";
}
