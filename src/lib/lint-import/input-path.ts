import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Source/policy paths stay inside the selected codebase, including through symlinks. */
export function lintPath(root: string, file: string): string {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error(`Out-of-project lint path: ${file}`);
    const absolute = resolve(root, file);
    let existing = absolute;
    while (!existsSync(existing)) existing = dirname(existing);
    const rel = relative(realpathSync(root), realpathSync(existing));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Lint path escapes project: ${file}`);
    return absolute;
}
