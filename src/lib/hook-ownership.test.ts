import { describe, expect, it } from "vitest";
import {
	documentContainsInterlinkedHook,
	hookEntryCommands,
	isHookEntryInvokingBinary,
	isInterlinkedHookCommand,
	isInterlinkedHookEntry,
	isProjectOwnedHookEntry,
	ownedInvocations,
} from "./hook-ownership.js";

// The real command shapes the two install systems write.
const LEGACY_MJS =
	`HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"; HOOK_DIR="$PWD"; ` +
	`while :; do if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then node "$HOOK_DIR/$HOOK_SCRIPT_REL"; break; fi; done`;
const ADAPTER_CMD =
	`if test -f '/repo/dist/hook-entry.js' ; then node '/repo/dist/hook-entry.js' ` +
	`--runner 'claude-code' --event 'PostToolUse' ; fi`;
const ADAPTER_BIN_CMD = `node '/usr/local/bin/interlinked-hook' --runner 'codex' --event 'PreToolUse'`;

describe("isInterlinkedHookCommand", () => {
	it("recognizes the legacy .mjs hook command", () => {
		expect(isInterlinkedHookCommand(LEGACY_MJS)).toBe(true);
	});
	it("recognizes the adapter hook-entry.js command", () => {
		expect(isInterlinkedHookCommand(ADAPTER_CMD)).toBe(true);
	});
	it("recognizes the adapter interlinked-hook bin command", () => {
		expect(isInterlinkedHookCommand(ADAPTER_BIN_CMD)).toBe(true);
	});
	it("does not match an unrelated hook command", () => {
		expect(isInterlinkedHookCommand("npx prettier --write .")).toBe(false);
		expect(isInterlinkedHookCommand("node ./scripts/my-hook.js")).toBe(false);
	});
	it("does not match an empty command", () => {
		expect(isInterlinkedHookCommand("")).toBe(false);
	});

	it.each([
		"node",
		"node --",
		"# node /repo/dist/hook-entry.js --runner codex --event PreToolUse",
		"node /repo/dist/hook-entry.js --runner",
		"node /repo/dist/hook-entry.js --runner --event PreToolUse",
		"node /repo/dist/hook-entry.js --runner codex --event",
		'node "/repo/dist/hook-entry.js\\',
		"node /repo/dist/hook-entry.js\\",
	])("preserves incomplete or non-executable user hook text: %s", (command) => {
		expect(isInterlinkedHookCommand(command)).toBe(false);
		expect(ownedInvocations(command)).toEqual([]);
	});

	// test-contract: security — review 2026-08-30: the substring recognizer
	// CLAIMED these user commands, and a claimed entry is a REMOVED entry on
	// the purge/uninstall paths. Ownership is shape-parsed now.
	describe("shape parsing — must NOT claim user commands (review repros)", () => {
		it("N: `echo hook-entry.js` is not an Interlinked hook", () => {
			expect(isInterlinkedHookCommand("echo hook-entry.js")).toBe(false);
		});
		it("N: a similarly named executable is not claimed", () => {
			expect(isInterlinkedHookCommand("node /home/u/my-hook-entry.js.sh --fast")).toBe(false);
			expect(isInterlinkedHookCommand("/usr/bin/not-interlinked-hookish --runner 'x' --event 'y'")).toBe(false);
		});
		it("N: the marker appearing only as an ARGUMENT is not claimed", () => {
			expect(isInterlinkedHookCommand("node build.js hook-entry.js")).toBe(false);
			expect(isInterlinkedHookCommand("mytool --config hook-entry.js --verbose")).toBe(false);
		});
		it("N: Node option values named like our script are not claimed as the entry point", () => {
			expect(isInterlinkedHookCommand("node --require /tmp/hook-entry.js app.js")).toBe(false);
			expect(isInterlinkedHookCommand("node --loader /tmp/hook-entry.js app.js")).toBe(false);
			expect(isInterlinkedHookCommand("node -r /tmp/hook-entry.js app.js")).toBe(false);
		});
		it("N: the marker inside prose/comment text is not claimed", () => {
			expect(isInterlinkedHookCommand("echo 'see docs about hook-entry.js' # interlinked-hook note")).toBe(false);
		});
		it("N: an args-less same-basename adapter script is not ownership evidence", () => {
			expect(
				isInterlinkedHookCommand('test -f "/repo/dist/hook-entry.js" && node "/repo/dist/hook-entry.js" || true'),
			).toBe(false);
		});
		// test-contract: invariant — the recognizer takes ONE command string,
		// never a serialized document; a raw JSON blob is NOT a hook command.
		// Document scanning is the parsed-walk helper's job.
		it("N: a raw JSON document is not itself a hook command; the parsed walk finds the entry", () => {
			const raw =
				'{"hooks":{"PreToolUse":[{"command":"node \\"/r/dist/hook-entry.js\\" --runner \\"claude-code\\" --event \\"PreToolUse\\""}]}}';
			expect(isInterlinkedHookCommand(raw)).toBe(false);
			expect(documentContainsInterlinkedHook(JSON.parse(raw))).toBe(true);
		});

		// test-contract: security — the review's four executable-position
		// repros: printing or commenting on an invocation is not an invocation.
		it("N: echo/printf/comment forms containing a full node invocation are NOT claimed", () => {
			expect(isInterlinkedHookCommand("echo node /repo/dist/hook-entry.js")).toBe(false);
			expect(isInterlinkedHookCommand("echo ok # node /repo/dist/hook-entry.js")).toBe(false);
			expect(isInterlinkedHookCommand("printf '%s\\n' 'node /repo/dist/hook-entry.js'")).toBe(false);
			expect(isInterlinkedHookCommand("echo node .interlinked/hooks/interlinked-activity.mjs")).toBe(false);
		});

		// test-contract: security — review 2026-08-31 probes 1+2: identity is
		// the EXACT basename; a user's look-alike script whose name merely ends
		// with ours is not Interlinked's (a claimed entry is a removed entry).
		it("N: look-alike basenames (my-hook-entry.js, myinterlinked-activity.mjs) are NOT claimed", () => {
			expect(isInterlinkedHookCommand("node /home/u/my-hook-entry.js")).toBe(false);
			expect(isInterlinkedHookCommand("node /home/u/myinterlinked-activity.mjs")).toBe(false);
			expect(isInterlinkedHookCommand("/usr/local/bin/my-interlinked-hook --event pre")).toBe(false);
		});

		// test-contract: public-api — adapter identity needs the canonical
		// registered-runner + event shape; legacy identity needs the reserved
		// path, not basename alone.
		it("P: canonical adapter invocations and exact legacy paths are claimed", () => {
			expect(
				isInterlinkedHookCommand(
					'node "/deep/a b/dist/hook-entry.js" --runner claude-code --event PreToolUse',
				),
			).toBe(true);
			expect(
				isInterlinkedHookCommand(
					"node -- /deep/dist/hook-entry.js --runner=codex --event=PermissionRequest",
				),
			).toBe(true);
			expect(isInterlinkedHookCommand("node /abs/.interlinked/hooks/interlinked-activity.mjs")).toBe(true);
			expect(
				isInterlinkedHookCommand(
					"/opt/bin/interlinked-hook --runner gemini-cli --event BeforeTool",
				),
			).toBe(true);
		});

		it("N: same-basename adapter scripts with missing or unknown identity survive", () => {
			expect(
				isInterlinkedHookCommand("node /home/u/hook-entry.js --runner claude-code"),
			).toBe(false);
			expect(
				isInterlinkedHookCommand("node /home/u/hook-entry.js --event PreToolUse"),
			).toBe(false);
			expect(
				isInterlinkedHookCommand(
					"node /home/u/hook-entry.js --runner user-runner --event PreToolUse",
				),
			).toBe(false);
			expect(
				isInterlinkedHookCommand(
					"node /home/u/hook-entry.js --runner claude-code --runner codex --event PreToolUse",
				),
			).toBe(false);
			expect(
				isInterlinkedHookCommand(
					"node /home/u/hook-entry.js --runner=codex --event=--not-an-event",
				),
			).toBe(false);
			expect(
				isInterlinkedHookCommand("/home/u/interlinked-hook --event PreToolUse"),
			).toBe(false);
		});

		it("N: arbitrary legacy basenames and assignment near-misses survive", () => {
			expect(isInterlinkedHookCommand("node /home/u/interlinked-activity.mjs")).toBe(false);
			expect(isInterlinkedHookCommand("node interlinked-activity.mjs")).toBe(false);
			expect(
				isInterlinkedHookCommand(
					'HOOK_SCRIPT_REL="hooks/interlinked-activity.mjs"; node "$HOOK_DIR/$HOOK_SCRIPT_REL"',
				),
			).toBe(false);
			expect(
				isInterlinkedHookCommand(
					'HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs.extra"; node "$HOOK_DIR/$HOOK_SCRIPT_REL"',
				),
			).toBe(false);
			expect(
				isInterlinkedHookCommand(
					'HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"; node "$HOOK_DIR/$HOOK_SCRIPT_REL"',
				),
			).toBe(false);
		});

		it.each([
			"claude-code",
			"copilot-cli",
			"cursor",
			"gemini-cli",
			"codex",
			"opencode",
			"pi",
		])("P: %s is a registered adapter runner", (runner) => {
			expect(
				isInterlinkedHookCommand(
					`node /repo/dist/hook-entry.js --runner ${runner} --event NativeEvent`,
				),
			).toBe(true);
		});
	});
});

describe("hookEntryCommands", () => {
	it("extracts from the Claude Code nested shape", () => {
		const entry = { matcher: "", hooks: [{ type: "command", command: ADAPTER_CMD }] };
		expect(hookEntryCommands(entry)).toEqual([ADAPTER_CMD]);
	});
	it("extracts from a flat command entry", () => {
		expect(hookEntryCommands({ command: LEGACY_MJS })).toEqual([LEGACY_MJS]);
	});
	it("extracts from a Copilot-style bash entry", () => {
		expect(hookEntryCommands({ type: "command", bash: ADAPTER_CMD })).toEqual([ADAPTER_CMD]);
	});
	it("yields nothing for junk", () => {
		expect(hookEntryCommands(null)).toEqual([]);
		expect(hookEntryCommands({ matcher: "" })).toEqual([]);
	});
});

describe("isInterlinkedHookEntry", () => {
	it("recognizes a Claude Code legacy hook entry", () => {
		const entry = { matcher: "", hooks: [{ type: "command", command: LEGACY_MJS }] };
		expect(isInterlinkedHookEntry(entry)).toBe(true);
	});
	it("recognizes a Claude Code adapter hook entry", () => {
		const entry = { matcher: "Edit|Write", hooks: [{ type: "command", command: ADAPTER_CMD }] };
		expect(isInterlinkedHookEntry(entry)).toBe(true);
	});
	it("recognizes a Copilot-style adapter entry", () => {
		expect(isInterlinkedHookEntry({ type: "command", bash: ADAPTER_BIN_CMD })).toBe(true);
	});
	it("does not match a foreign hook entry", () => {
		const entry = { matcher: "", hooks: [{ type: "command", command: "npx lint-staged" }] };
		expect(isInterlinkedHookEntry(entry)).toBe(false);
	});
});

describe("isProjectOwnedHookEntry", () => {
	it("recognizes an adapter entry whose binary path is inside the project", () => {
		// ADAPTER_CMD bakes in /repo/dist/hook-entry.js — owned by /repo.
		expect(isProjectOwnedHookEntry({ command: ADAPTER_CMD }, "/repo")).toBe(true);
	});
	it("recognizes a Claude Code nested adapter entry for the project", () => {
		const entry = { matcher: "Edit|Write", hooks: [{ type: "command", command: ADAPTER_CMD }] };
		expect(isProjectOwnedHookEntry(entry, "/repo")).toBe(true);
	});
	it("accepts a project root passed with a trailing slash", () => {
		expect(isProjectOwnedHookEntry({ command: ADAPTER_CMD }, "/repo/")).toBe(true);
	});
	it("rejects an Interlinked entry owned by a different project", () => {
		expect(isProjectOwnedHookEntry({ command: ADAPTER_CMD }, "/other")).toBe(false);
	});
	it("rejects a sibling repo whose path is a string prefix of the root", () => {
		// /repo-fork/... must not be attributed to project root /repo.
		const forkCmd = ADAPTER_CMD.replace(/\/repo\//g, "/repo-fork/");
		expect(isProjectOwnedHookEntry({ command: forkCmd }, "/repo")).toBe(false);
	});
	it("rejects the legacy $PWD-relative command (no absolute project path)", () => {
		expect(isProjectOwnedHookEntry({ command: LEGACY_MJS }, "/repo")).toBe(false);
	});
	it("rejects a non-Interlinked command even when it mentions the root", () => {
		expect(isProjectOwnedHookEntry({ command: "node /repo/scripts/other.js" }, "/repo")).toBe(
			false,
		);
	});
	it("rejects an empty project root", () => {
		expect(isProjectOwnedHookEntry({ command: ADAPTER_CMD }, "")).toBe(false);
	});
	it("rejects junk entries", () => {
		expect(isProjectOwnedHookEntry(null, "/repo")).toBe(false);
		expect(isProjectOwnedHookEntry({ matcher: "" }, "/repo")).toBe(false);
	});

	// test-contract: security — review 2026-08-31 probe 4: attribution reads
	// the INVOKED path only; a FOREIGN repo's hook whose echo argument
	// mentions this project's root stays foreign.
	it("N: a foreign hook mentioning the current root in an argument stays foreign", () => {
		const foreign = {
			command:
				"node '/other/repo/dist/hook-entry.js' --runner claude-code --event PreToolUse ; echo /repo/notes",
		};
		expect(isProjectOwnedHookEntry(foreign, "/repo")).toBe(false);
		expect(isProjectOwnedHookEntry(foreign, "/other/repo")).toBe(true);
	});
});

describe("ownedInvocations", () => {
	// test-contract: public-api — the enumerator returns each owned
	// invocation with its classified kind and invoked path, in order.
	it("P: returns kind + script for every owned invocation in one command", () => {
		const invocations = ownedInvocations(ADAPTER_CMD);
		expect(invocations).toEqual([
			expect.objectContaining({ kind: "hook-entry", script: "/repo/dist/hook-entry.js" }),
		]);
		expect(ownedInvocations(ADAPTER_BIN_CMD)[0]?.kind).toBe("interlinked-hook");
	});

	// test-contract: boundary — non-invocations yield an empty list.
	it("N: mentions and look-alikes yield no invocations", () => {
		expect(ownedInvocations("echo node /repo/dist/hook-entry.js")).toEqual([]);
		expect(ownedInvocations("node /home/u/my-hook-entry.js")).toEqual([]);
	});
});

describe("isHookEntryInvokingBinary", () => {
	// test-contract: public-api — the entry invokes the exact recorded
	// binary in the script (or executable) position.
	it("P: matches the recorded binary in the invocation position", () => {
		expect(isHookEntryInvokingBinary({ command: ADAPTER_CMD }, "/repo/dist/hook-entry.js")).toBe(true);
		expect(
			isHookEntryInvokingBinary({ command: ADAPTER_BIN_CMD }, "/usr/local/bin/interlinked-hook"),
		).toBe(true);
	});

	// test-contract: security — echoing the recorded binary is not invoking
	// it (the removed substring fallback's failure mode), a different binary
	// does not match, and an empty recorded path matches nothing.
	it("N: mentions, other binaries, and empty paths do not match", () => {
		expect(
			isHookEntryInvokingBinary({ command: "echo /repo/dist/hook-entry.js" }, "/repo/dist/hook-entry.js"),
		).toBe(false);
		expect(isHookEntryInvokingBinary({ command: ADAPTER_CMD }, "/other/dist/hook-entry.js")).toBe(false);
		expect(isHookEntryInvokingBinary({ command: ADAPTER_CMD }, "")).toBe(false);
		expect(
			isHookEntryInvokingBinary(
				{ command: "node /repo/dist/hook-entry.js --runner claude-code" },
				"/repo/dist/hook-entry.js",
			),
		).toBe(false);
		expect(
			isHookEntryInvokingBinary(
				{
					command:
						"node /repo/dist/hook-entry.js --runner not-registered --event PreToolUse",
				},
				"/repo/dist/hook-entry.js",
			),
		).toBe(false);
	});
});

describe("documentContainsInterlinkedHook — hook containers only", () => {
	const CMD = "node '/repo/dist/hook-entry.js' --runner 'claude-code' --event 'PreToolUse'";

	// test-contract: security — review 2026-08-31 probe 3: a hook-shaped
	// command inside unrelated metadata is a mention, not a registration.
	it("N: an Interlinked-looking command outside the hooks container is unrelated", () => {
		expect(documentContainsInterlinkedHook({ unrelated_note: CMD })).toBe(false);
		expect(documentContainsInterlinkedHook({ notes: [{ command: CMD }] })).toBe(false);
	});

	// test-contract: public-api — every runner's native container shape is
	// found: event-map of flat entries (gemini/cursor/copilot) and the Claude
	// nested entry shape.
	it("P: native container shapes across runners are recognized", () => {
		expect(documentContainsInterlinkedHook({ hooks: { PreToolUse: [{ command: CMD }] } })).toBe(true);
		expect(
			documentContainsInterlinkedHook({
				hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: CMD }] }] },
			}),
		).toBe(true);
		expect(
			documentContainsInterlinkedHook({ version: 1, hooks: { afterEdit: [{ type: "command", bash: CMD }] } }),
		).toBe(true);
		expect(documentContainsInterlinkedHook({ hooks: { PreToolUse: [{ command: "npx lint-staged" }] } })).toBe(false);
	});
});
