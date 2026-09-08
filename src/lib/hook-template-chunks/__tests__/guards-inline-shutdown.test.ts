// Regression test: shutdown/reboot detection in the shared destructive-command
// guard (src/lib/hook-template-chunks/destructive-command-guard.ts) must stay
// in lockstep with the harness rule at
// `src/harness/rules/builtin-rules-processes.ts:builtin-shutdown-reboot`.
// Divergence means a command the daemon allows can be blocked when the harness
// is down (and vice versa).
//
// `checkDestructiveCommand` is the single source — src/hook-entry.ts imports it
// for the cold path, and guards-inline.ts embeds it into the .mjs. The
// `runInlineGuard` tests at the bottom exercise it THROUGH the assembled .mjs
// chunk, so they also pin that the `${DESTRUCTIVE_COMMAND_GUARD_SOURCE}` splice
// carries shutdown detection into the generated hook.

import { describe, expect, it } from "vitest";
import { checkDestructiveCommand } from "../destructive-command-guard.js";
import { GUARDS_INLINE_CHUNK } from "../guards-inline.js";

/** Build the .mjs `inlineGuardCheck` from the assembled chunk and run it —
 *  exercises the EXACT function the generated hook evaluates, including the
 *  spliced-in checkDestructiveCommand. */
function runInlineGuard(command: string): { decision: string; reason: string } | null {
	// SAFETY: GUARDS_INLINE_CHUNK declares this named guard; the call uses its fixed PreToolUse/Bash/input signature, and cases below compare shutdown verdicts with the imported checker.
	const fn = new Function(`${GUARDS_INLINE_CHUNK}\nreturn inlineGuardCheck;`)() as (
		hookEvent: string,
		toolName: string,
		toolInput: { command: string },
	) => { decision: string; reason: string } | null;
	return fn("PreToolUse", "Bash", { command });
}

describe("destructive-command guard — shutdown/reboot detection", () => {
	// Must block — the agent must be stopped even with the harness down.
	const blocked = [
		"shutdown -h now",
		"sudo reboot",
		"printf x | sudo reboot",
		"echo ok\nreboot",
		"echo done; shutdown -h now",
		"false || shutdown -h now",
		"foo && shutdown -h now",
		// Wrapper forms — an anchor-only regex misses these even though each
		// actually executes the destructive verb at runtime.
		"env FOO=1 reboot",
		"command reboot",
		"bash -c reboot",
		'bash -c "reboot"',
		"nohup reboot",
		"exec reboot",
		"sudo bash -c reboot",
		"env A=1 B=2 sudo reboot",
	];

	for (const command of blocked) {
		it(`blocks: ${JSON.stringify(command)}`, () => {
			const verdict = checkDestructiveCommand(command);
			expect(verdict?.decision, command).toBe("block");
			expect(verdict?.reason, command).toContain("shutdown/reboot");
		});
	}

	// Must NOT block — the verb appears only as quoted or searched data, not
	// at an executable command position. (The prior `\s`-prefix regex flagged
	// these; the wrapper-aware regex must not.)
	const allowed = [
		'bash -c "echo Graceful shutdown stalled"',
		'echo "Graceful shutdown stalled"',
		"grep -n 'Shutting down' src/server.ts",
		"cat ./shutdown.log",
	];

	for (const command of allowed) {
		it(`allows: ${JSON.stringify(command)}`, () => {
			expect(checkDestructiveCommand(command), command).toBeNull();
		});
	}
});

describe("inline .mjs guard carries shutdown detection through the splice", () => {
	it("blocks pipeline shutdown even when the command starts with printf", () => {
		expect(runInlineGuard("printf x | sudo reboot")?.decision).toBe("block");
	});

	it("blocks newline shutdown even when the command starts with echo", () => {
		expect(runInlineGuard("echo ok\nreboot")?.decision).toBe("block");
	});

	it("allows rg patterns that mention wrapped reboot as data", () => {
		expect(runInlineGuard("rg -n 'foo|command reboot' src")).toBeNull();
	});

	it("allows quoted echo text with a pipe before reboot", () => {
		expect(runInlineGuard('echo "foo | reboot"')).toBeNull();
	});
});
