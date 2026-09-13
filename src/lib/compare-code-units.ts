/** Locale-independent UTF-16 ordering used for canonical identities and paths. */
export function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}
