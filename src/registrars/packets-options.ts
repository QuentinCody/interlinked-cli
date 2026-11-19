// interlinked-tdd: exempt
// Shared commander option parsers for the `packets` registrars (one definition
// each; the registrar pin in packets.test.ts exercises them through parsing).

/** `--tail-mb` and friends: a finite number above zero. */
export function positiveNumber(flag: string): (v: string) => number {
	return (v: string) => {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got ${v}`);
		return n;
	};
}

/** `--sessions` and friends: an integer above zero. */
export function positiveInteger(flag: string): (v: string) => number {
	return (v: string) => {
		const n = Number(v);
		if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got ${v}`);
		return n;
	};
}

export const CWD_FLAG = ["--cwd <path>", "Project root (default: current directory)"] as const;
export const JSON_FLAG = ["--json", "Machine-readable output"] as const;
