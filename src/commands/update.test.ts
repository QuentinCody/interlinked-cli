// ===========================================
// update.ts — resolveRoots unit tests
// ===========================================
// Focused on the one branch the fuller `update.integration.test.ts` /
// `update.mutation-kill.test.ts` companions never exercise: `resolveRoots`'s
// "cannot resolve CLI install location" guard. `resolveRoots` is exported
// with injectable `resolveCliRoot` / `ensureManagedSourceCheckout` seams
// (both default to the real resolvers, so every other caller's behavior is
// unchanged) specifically so this branch can be driven without touching the
// real filesystem or spawning git.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRoots } from "./update.js";

class ProcessExit extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	// SAFETY: process.exit's real signature returns `never`; this mock throws
	// instead of exiting so the test can observe the call and unwind cleanly.
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExit(code ?? 0);
	}) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveRoots — cliRoot cannot be resolved", () => {
	it("prints 'Cannot resolve CLI install location' and exits 1 when neither resolver yields a usable root", () => {
		expect(() =>
			resolveRoots(
				{ json: false },
				{
					// No installed checkout found on disk...
					resolveCliRoot: () => null,
					// ...and the managed-checkout bootstrap itself comes back empty
					// (e.g. an unwritable/misconfigured managed-root path) — the one
					// input shape that leaves `cliRoot` falsy after the fallback.
					ensureManagedSourceCheckout: () => "",
				},
			),
		).toThrow(ProcessExit);
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Cannot resolve CLI install location"));
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("does not fail when the managed-checkout bootstrap yields a real root", () => {
		const roots = resolveRoots(
			{ json: false },
			{
				resolveCliRoot: () => null,
				ensureManagedSourceCheckout: () => "/managed/interlinked-cli",
			},
		);
		expect(roots).toEqual({
			cliRoot: "/managed/interlinked-cli",
			repoRoot: "/managed/interlinked-cli",
			managedCheckout: true,
		});
		expect(errSpy).not.toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
	});
});
