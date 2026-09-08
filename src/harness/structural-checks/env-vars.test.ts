import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Mock node:fs so we control BOTH the target file content (read inside
// env-vars.ts) and .env.example discovery (read inside the unmocked
// env-loader.ts, which calls these same mocked fs functions).
//
// Two virtual stores keyed by absolute path:
//   FILES   — readable files; a path mapped to the THROW sentinel makes
//             readFileSync raise (exercises env-vars.ts catch + env-loader
//             catch). An unmapped path makes readFileSync throw ENOENT.
//   EXISTS  — set of paths existsSync() should report as present.
// ---------------------------------------------------------------------------
const THROW = Symbol("throw");
let FILES: Map<string, string | typeof THROW>;
let EXISTS: Set<string>;

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn((p: string) => EXISTS.has(p)),
		readFileSync: vi.fn((p: string) => {
			const v = FILES.get(p);
			if (v === undefined) {
				const err = new Error(`ENOENT: no such file, open '${p}'`);
				throw err;
			}
			if (v === THROW) {
				throw new Error(`EACCES: permission denied, open '${p}'`);
			}
			return v;
		}),
	};
});

import { nonNull } from "../../lib/non-null.js";
import { checkUndefinedEnvVars } from "./env-vars.js";

// Use a deep path so the parent-walk loop (max 10 hops) has room to walk.
const SRC = "/repo/a/b/c/d/src/app.ts";
const ROOT_ENV = "/repo/.env.example";

/** Register a readable file. */
function file(path: string, content: string): void {
	FILES.set(path, content);
}
/** Register an .env.example at a given dir, both readable + existing. */
function envExample(path: string, content: string): void {
	FILES.set(path, content);
	EXISTS.add(path);
}

beforeEach(() => {
	FILES = new Map();
	EXISTS = new Set();
});

describe("checkUndefinedEnvVars", () => {
	it("returns [] when the target file cannot be read (readFileSync throws)", () => {
		// SRC is not registered at all -> readFileSync throws -> catch -> []
		expect(checkUndefinedEnvVars(SRC, "src/app.ts")).toEqual([]);
	});

	it("returns [] when the file has no process.env references (usedVars empty)", () => {
		file(SRC, "const x = 1;\nfunction f() { return x; }\n");
		expect(checkUndefinedEnvVars(SRC, "src/app.ts")).toEqual([]);
	});

	it("flags an undeclared env var when an .env.example exists in the same dir-walk", () => {
		file(SRC, "const k = process.env.SECRET_KEY;");
		envExample(ROOT_ENV, "OTHER_VAR=1\n");
		const res = checkUndefinedEnvVars(SRC, "src/app.ts");
		expect(res).toHaveLength(1);
		expect(res[0]).toMatchObject({
			check: "undefined_env_vars",
			severity: "info",
			file: SRC,
		});
		expect(nonNull(res[0]).message).toContain("src/app.ts references 1 env var(s)");
		expect(nonNull(res[0]).message).toContain("SECRET_KEY");
		expect(nonNull(res[0]).message).not.toContain("more");
	});

	it("returns [] when every used var is declared in .env.example", () => {
		file(SRC, "const a = process.env.API_TOKEN;\nconst b = process.env.DB_URL;");
		envExample(ROOT_ENV, "API_TOKEN=x\nDB_URL=y\n");
		expect(checkUndefinedEnvVars(SRC, "src/app.ts")).toEqual([]);
	});

	it("returns [] when no .env.example is found anywhere in the parent walk", () => {
		file(SRC, "const k = process.env.SECRET_KEY;");
		// No envExample registered -> existsSync always false -> walk exhausts -> []
		expect(checkUndefinedEnvVars(SRC, "src/app.ts")).toEqual([]);
	});

	it("skips standard env vars (NODE_ENV etc.) even when not in .env.example", () => {
		file(
			SRC,
			"const a = process.env.NODE_ENV;\nconst b = process.env.PORT;\nconst c = process.env.LOG_LEVEL;",
		);
		envExample(ROOT_ENV, "UNRELATED=1\n");
		// All used vars are in the standardVars allow-list -> nothing to flag.
		expect(checkUndefinedEnvVars(SRC, "src/app.ts")).toEqual([]);
	});

	it("flags an undeclared var while skipping a co-located standard var", () => {
		file(SRC, "const a = process.env.NODE_ENV;\nconst b = process.env.CUSTOM_FLAG;");
		envExample(ROOT_ENV, "X=1\n");
		const res = checkUndefinedEnvVars(SRC, "src/app.ts");
		expect(res).toHaveLength(1);
		expect(nonNull(res[0]).message).toContain("CUSTOM_FLAG");
		expect(nonNull(res[0]).message).not.toContain("NODE_ENV");
	});

	it("walks parent directories to locate .env.example higher in the tree", () => {
		file(SRC, "const k = process.env.HIGH_VAR;");
		// Place .env.example several levels up from SRC's dir.
		envExample(ROOT_ENV, "DECLARED=1\n");
		const res = checkUndefinedEnvVars(SRC, "src/app.ts");
		expect(res).toHaveLength(1);
		expect(nonNull(res[0]).message).toContain("HIGH_VAR");
	});

	it("truncates to 5 names and appends a '+N more' suffix for many undeclared vars", () => {
		const vars = ["VAR_A", "VAR_B", "VAR_C", "VAR_D", "VAR_E", "VAR_F", "VAR_G"];
		file(SRC, vars.map((v) => `const x = process.env.${v};`).join("\n"));
		envExample(ROOT_ENV, "NOTHING=1\n");
		const res = checkUndefinedEnvVars(SRC, "src/app.ts");
		expect(res).toHaveLength(1);
		// 7 undeclared -> "references 7 env var(s)" + first 5 listed + "+2 more"
		expect(nonNull(res[0]).message).toContain("references 7 env var(s)");
		expect(nonNull(res[0]).message).toContain("+2 more");
		expect(nonNull(res[0]).message).toContain("VAR_A");
		expect(nonNull(res[0]).message).toContain("VAR_E");
		// 6th and 7th are not listed by name (only counted in "+2 more").
		expect(nonNull(res[0]).message).not.toContain("VAR_F");
		expect(nonNull(res[0]).message).not.toContain("VAR_G");
	});

	describe("diff-aware mode (event.tool_input present)", () => {
		const evt = (toolInput: Record<string, unknown>): HarnessEvent =>
			({
				hook_event: "PostToolUse",
				session_id: "s1",
				agent_source: "claude",
				tool_input: toolInput,
				timestamp: "2026-01-01T00:00:00Z",
			});

		it("only reports env vars introduced in new_string (existing keys ignored)", () => {
			// File references two vars; the edit only introduces NEW_VAR.
			file(SRC, "const a = process.env.OLD_VAR;\nconst b = process.env.NEW_VAR;");
			envExample(ROOT_ENV, "DECLARED=1\n");
			const res = checkUndefinedEnvVars(
				SRC,
				"src/app.ts",
				evt({ new_string: "const b = process.env.NEW_VAR;" }),
			);
			expect(res).toHaveLength(1);
			expect(nonNull(res[0]).message).toContain("NEW_VAR");
			expect(nonNull(res[0]).message).not.toContain("OLD_VAR");
		});

		it("falls back to tool_input.content when new_string is absent", () => {
			file(SRC, "const a = process.env.OLD_VAR;\nconst b = process.env.WRITTEN_VAR;");
			envExample(ROOT_ENV, "DECLARED=1\n");
			const res = checkUndefinedEnvVars(
				SRC,
				"src/app.ts",
				evt({ content: "const b = process.env.WRITTEN_VAR;" }),
			);
			expect(res).toHaveLength(1);
			expect(nonNull(res[0]).message).toContain("WRITTEN_VAR");
			expect(nonNull(res[0]).message).not.toContain("OLD_VAR");
		});

		it("returns [] when the edit introduces no env var references at all", () => {
			file(SRC, "const a = process.env.OLD_VAR;");
			envExample(ROOT_ENV, "DECLARED=1\n");
			// editContent is non-empty but contains no process.env.* -> editVars empty -> []
			const res = checkUndefinedEnvVars(
				SRC,
				"src/app.ts",
				evt({ new_string: "const a = 42;" }),
			);
			expect(res).toEqual([]);
		});

		it("returns [] when filtering to the edit's vars leaves nothing (edit var is declared)", () => {
			// Edit introduces only EDIT_VAR, which IS declared; OLD_VAR (undeclared)
			// exists in the file but isn't in the edit, so it's filtered out.
			file(SRC, "const a = process.env.OLD_VAR;\nconst b = process.env.EDIT_VAR;");
			envExample(ROOT_ENV, "EDIT_VAR=1\n");
			const res = checkUndefinedEnvVars(
				SRC,
				"src/app.ts",
				evt({ new_string: "const b = process.env.EDIT_VAR;" }),
			);
			expect(res).toEqual([]);
		});

		it("returns [] when the edit's vars don't intersect the file's vars (usedVars empties out)", () => {
			// The whole file references only FILE_VAR; the edit references only
			// EDIT_ONLY_VAR (not present in the file snapshot). editVars is
			// non-empty (passes the size!==0 guard) but the intersection filter
			// removes FILE_VAR, leaving usedVars empty -> the `usedVars.size === 0`
			// early-return inside the diff block fires (line 61).
			file(SRC, "const a = process.env.FILE_VAR;");
			envExample(ROOT_ENV, "DECLARED=1\n");
			const res = checkUndefinedEnvVars(
				SRC,
				"src/app.ts",
				evt({ new_string: "const z = process.env.EDIT_ONLY_VAR;" }),
			);
			expect(res).toEqual([]);
		});

		it("treats empty new_string/content as no-diff and checks the whole file", () => {
			// Both new_string and content are empty -> editContent is "" ->
			// the `if (editContent)` block is skipped -> whole-file check runs.
			file(SRC, "const a = process.env.WHOLE_FILE_VAR;");
			envExample(ROOT_ENV, "DECLARED=1\n");
			const res = checkUndefinedEnvVars(
				SRC,
				"src/app.ts",
				evt({ new_string: "", content: "" }),
			);
			expect(res).toHaveLength(1);
			expect(nonNull(res[0]).message).toContain("WHOLE_FILE_VAR");
		});

		it("treats a missing tool_input object as whole-file (event present, tool_input undefined)", () => {
			file(SRC, "const a = process.env.NO_TOOLINPUT_VAR;");
			envExample(ROOT_ENV, "DECLARED=1\n");
			const event: HarnessEvent = {
				hook_event: "PostToolUse",
				session_id: "s1",
				agent_source: "claude",
				timestamp: "2026-01-01T00:00:00Z",
				// tool_input intentionally omitted
			};
			const res = checkUndefinedEnvVars(SRC, "src/app.ts", event);
			expect(res).toHaveLength(1);
			expect(nonNull(res[0]).message).toContain("NO_TOOLINPUT_VAR");
		});
	});

	it("returns [] (empty declared set) when .env.example is unreadable", () => {
		// existsSync true but readFileSync throws inside env-loader -> returns
		// an empty Set (not null) -> walk stops -> every used var is undeclared.
		file(SRC, "const a = process.env.SOME_VAR;");
		EXISTS.add(ROOT_ENV);
		FILES.set(ROOT_ENV, THROW);
		const res = checkUndefinedEnvVars(SRC, "src/app.ts");
		// env-loader returns an empty Set, so SOME_VAR is undeclared -> flagged.
		expect(res).toHaveLength(1);
		expect(nonNull(res[0]).message).toContain("SOME_VAR");
	});
});
