/**
 * Parse a `--changed-files a.ts,b.ts` CLI option into its file list.
 *
 * Returns `undefined` when the option was not supplied at all (the "no scope
 * given" signal callers branch on), and drops blank entries so a trailing or
 * doubled comma never becomes an empty path.
 */
export function parseChangedFiles(raw?: string): string[] | undefined {
	if (!raw) return undefined;
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
