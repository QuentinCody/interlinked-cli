// `check --only duplicates`: which files of one exported-name group are really duplicates of each other.
// The group is every file in a project boundary that exports one name. These rules drop files that share the
// name by convention, so that what is left is a collision a reviewer would act on.

import { basename } from "node:path";

/**
 * When this many modules with one file name export one name (`FIELDS` in every `fields.ts`, `vars` in every
 * theme's `vars.ts`), the file name defines the export: a convention, not a copy. Two is a coincidence and
 * still reported. [heuristic]
 */
const CONVENTION_SAME_FILENAME = 3;

/** `X.d.ts` with `X.ts|tsx|js|jsx|mjs|cjs` in the group: the declaration file describes that implementation. */
function isDeclarationCompanion(file: string, others: readonly string[]): boolean {
	if (!file.endsWith(".d.ts")) return false;
	const stem = file.slice(0, -".d.ts".length);
	return others.some((other) => other !== file && other.startsWith(stem) && /^\.(?:tsx?|[cm]?jsx?)$/.test(other.slice(stem.length)));
}

/** An `index` module is addressed by its directory, so index modules in different directories are not duplicates of each other. */
function isIndexModule(file: string): boolean {
	return /(?:^|[\\/])index\.[cm]?[jt]sx?$/.test(file);
}

function withoutFilenameConvention(files: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const file of files) counts.set(basename(file), (counts.get(basename(file)) ?? 0) + 1);
	return files.filter((file) => (counts.get(basename(file)) ?? 0) < CONVENTION_SAME_FILENAME);
}

/** The files of one name group that are duplicates of each other; empty when the group is not a duplicate. */
export function duplicateGroup(group: readonly string[]): string[] {
	const files = withoutFilenameConvention(group.filter((file) => !isDeclarationCompanion(file, group)));
	return files.length <= 1 || files.every(isIndexModule) ? [] : files;
}
