import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateProtectedFiles, evaluateRepoConfinement } from "../filesystem-guards.js";

describe("evaluateProtectedFiles", () => {
	it("blocks a matching glob with a blanket block reason", () => {
		const decision = evaluateProtectedFiles({
			toolName: "Write",
			filePath: ".env",
			content: "SECRET=x",
			protectedFiles: [
				{ glob: "**/.env", reason: "nope", operations: ["Write"] },
			],
			containsSecrets: () => true,
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toBe("nope");
	});

	it("lets writes pass when the rule is secrets-only and content has no secrets", () => {
		const decision = evaluateProtectedFiles({
			toolName: "Write",
			filePath: ".env",
			content: "SAFE=1",
			protectedFiles: [
				{
					glob: "**/.env",
					reason: "secrets only",
					check: "secrets",
					operations: ["Write"],
				},
			],
			containsSecrets: () => false,
		});
		expect(decision).toBeNull();
	});

	it("returns null when no rule glob matches", () => {
		expect(
			evaluateProtectedFiles({
				toolName: "Write",
				filePath: "src/x.ts",
				content: "x",
				protectedFiles: [
					{
						glob: "**/.env",
						reason: "env",
						operations: ["Write"],
					},
				],
				containsSecrets: () => true,
			}),
		).toBeNull();
	});
});

describe("evaluateRepoConfinement", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "confine-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null for paths inside the repo", () => {
		expect(
			evaluateRepoConfinement({
				rawPath: "src/foo.ts",
				cwd: tmpDir,
				allowlist: [],
			}),
		).toBeNull();
	});

	it("blocks paths outside the repo that are not allowlisted", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/tmp/outside.txt",
			cwd: tmpDir,
			allowlist: [],
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-repo-confinement");
	});

	it("permits paths in an allowlisted prefix", () => {
		expect(
			evaluateRepoConfinement({
				rawPath: "/tmp/outside.txt",
				cwd: tmpDir,
				allowlist: ["/tmp"],
			}),
		).toBeNull();
	});

	// --- Linked workspace (multi-repo) ---

	it("permits writes to a declared linked project (absolute sibling root)", () => {
		const sibling = mkdtempSync(join(tmpdir(), "confine-linked-"));
		try {
			expect(
				evaluateRepoConfinement({
					rawPath: join(sibling, "cloud", "worker.ts"),
					cwd: tmpDir,
					allowlist: [],
					linkedProjects: [sibling],
				}),
			).toBeNull();
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("resolves a relative linked project against the project root", () => {
		const sibling = mkdtempSync(join(tmpdir(), "confine-linked-"));
		try {
			const rel = join("..", basename(sibling));
			expect(
				evaluateRepoConfinement({
					rawPath: join(sibling, "x.ts"),
					cwd: tmpDir,
					allowlist: [],
					linkedProjects: [rel],
				}),
			).toBeNull();
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("still blocks paths outside primary + linked + allowlist", () => {
		const sibling = mkdtempSync(join(tmpdir(), "confine-linked-"));
		try {
			const decision = evaluateRepoConfinement({
				rawPath: "/tmp/elsewhere.txt",
				cwd: tmpDir,
				allowlist: [],
				linkedProjects: [sibling],
			});
			expect(decision?.decision).toBe("block");
			expect(decision?.rule_id).toBe("builtin-repo-confinement");
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("does not change single-root behavior when linkedProjects is empty/absent", () => {
		expect(
			evaluateRepoConfinement({ rawPath: "/tmp/x.txt", cwd: tmpDir, allowlist: [], linkedProjects: [] })
				?.decision,
		).toBe("block");
		expect(evaluateRepoConfinement({ rawPath: "src/ok.ts", cwd: tmpDir, allowlist: [] })).toBeNull();
	});

	// --- Session scratchpad carve-out (ephemeral + session-scoped + host-sanctioned) ---
	// The host provisions `<temp-root>/.../<session-id>/scratchpad/` for this run.
	// Allowed only when all three hold, so it never becomes a blanket /tmp escape.

	const SESSION_ID = "1afa076e-599d-46a5-b4ed-bcdb558eff4d";
	const OTHER_SESSION = "00000000-aaaa-bbbb-cccc-000000000000";
	const scratchpadPath = (sessionId: string, ...tail: string[]): string =>
		join(tmpdir(), "claude-501", "-Users-x-repo", sessionId, "scratchpad", ...tail);

	it("permits writes to this session's host-provisioned scratchpad", () => {
		expect(
			evaluateRepoConfinement({
				rawPath: scratchpadPath(SESSION_ID, "repro.ts"),
				cwd: tmpDir,
				allowlist: [],
				sessionId: SESSION_ID,
			}),
		).toBeNull();
	});

	it("permits writes nested deeper inside the session scratchpad", () => {
		expect(
			evaluateRepoConfinement({
				rawPath: scratchpadPath(SESSION_ID, "sub", "dir", "out.json"),
				cwd: tmpDir,
				allowlist: [],
				sessionId: SESSION_ID,
			}),
		).toBeNull();
	});

	it("blocks a scratchpad belonging to a DIFFERENT session", () => {
		const decision = evaluateRepoConfinement({
			rawPath: scratchpadPath(OTHER_SESSION, "x.ts"),
			cwd: tmpDir,
			allowlist: [],
			sessionId: SESSION_ID,
		});
		expect(decision?.rule_id).toBe("builtin-repo-confinement");
	});

	it("blocks a scratchpad-shaped path outside any ephemeral temp root", () => {
		const decision = evaluateRepoConfinement({
			rawPath: join("/opt", "notreal", SESSION_ID, "scratchpad", "x.ts"),
			cwd: tmpDir,
			allowlist: [],
			sessionId: SESSION_ID,
		});
		expect(decision?.decision).toBe("block");
	});

	it("blocks a temp path under the session id that is NOT the scratchpad subtree", () => {
		const decision = evaluateRepoConfinement({
			rawPath: join(tmpdir(), "claude-501", "-Users-x-repo", SESSION_ID, "transcript", "x.ts"),
			cwd: tmpDir,
			allowlist: [],
			sessionId: SESSION_ID,
		});
		expect(decision?.decision).toBe("block");
	});

	it("does not turn the temp dir into a blanket escape when the event has no session id", () => {
		const decision = evaluateRepoConfinement({
			rawPath: scratchpadPath(SESSION_ID, "x.ts"),
			cwd: tmpDir,
			allowlist: [],
			// sessionId omitted — the carve-out must not fire.
		});
		expect(decision?.decision).toBe("block");
	});
});
