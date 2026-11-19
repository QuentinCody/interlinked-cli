import { createRequire } from "node:module";
import type * as TS from "typescript";

type Compiler = typeof TS;

/** Resolve the optional compiler using Node's package resolution at the supplied caller. */
export function requireTypescriptFrom(base: string): Compiler | null {
	try {
		// SAFETY: Node resolves the installed TypeScript package described by the type-only import.
		return createRequire(base)("typescript") as Compiler;
	} catch {
		return null;
	}
}

/** A single caller's lazy compiler resolution. Both successful and unavailable results are cached. */
export function optionalTypescript(base: string) {
	let cached: Compiler | null | undefined;
	return {
		load() {
			if (cached === undefined) cached = requireTypescriptFrom(base);
			return cached;
		},
		set(value: Compiler | null | undefined) { cached = value; },
	};
}
