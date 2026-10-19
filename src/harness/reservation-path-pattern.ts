// ===========================================
// Reservation path-pattern matching
// ===========================================
// Pure leaf split out of `reservations.ts` (per-file line cap). A reservation
// key is either an exact path or one of three simple glob shapes.

/** Simple path-to-pattern matching (exact match or glob). */
export function reservationPathMatchesPattern(filePath: string, pattern: string): boolean {
	// Exact match
	if (filePath === pattern) return true;

	// Simple glob: "src/auth/**" matches "src/auth/login.ts"
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return filePath.startsWith(`${prefix}/`) || filePath === prefix;
	}

	// Simple glob: "**/*.ts" matches any .ts file; "**/Makefile" matches a
	// Makefile in any directory. MUST be checked BEFORE the single-'*' arm:
	// "**/..." also starts with '*', and the '*' arm would mishandle it
	// (testing endsWith("*/...") — the literal '*' never matches a real path),
	// silently making every "**/" reservation a no-op.
	if (pattern.startsWith("**/")) {
		const suffix = pattern.slice(3);
		if (suffix.startsWith("*")) {
			return filePath.endsWith(suffix.slice(1));
		}
		return filePath.endsWith(`/${suffix}`) || filePath === suffix;
	}

	// Simple glob: "*.env" matches ".env", "staging.env"
	if (pattern.startsWith("*")) {
		return filePath.endsWith(pattern.slice(1));
	}

	return false;
}
