import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	evaluateProtectedFiles,
	evaluateRepoConfinement,
	isEphemeralTempPath,
	sessionScratchpadAllows,
} from "./filesystem-guards.js";

describe("filesystem-guards mutation kills — isEphemeralTempPath", () => {
	// Kills d79592584a0d2c19 / 205e9ae2769325d2 / db96a2fda7c16415: turning any of
	// the "/private/tmp" | "/var/tmp" | "/private/var/tmp" root literals into ""
	// makes resolve("") === process.cwd() get added as a bogus ephemeral root, so
	// an ordinary path under the real cwd starts reading as "ephemeral".
	// test-contract: public-api — isEphemeralTempPath must not classify an
	// ordinary path under a non-temp process cwd as an ephemeral temp root.
	it("does not treat a path under a non-temp process cwd as ephemeral", async () => {
		// Clean-clone tests may themselves run below macOS's /var/folders temp
		// root. Pin cwd to a platform-rooted non-temp value so this test keeps
		// exercising the empty-root mutant rather than assuming its host layout.
		// Reset and import AFTER the spy because EPHEMERAL_TEMP_ROOTS is computed
		// once at module evaluation; an empty root must therefore resolve to this
		// synthetic cwd for the mutation-directed assertion to retain its teeth.
		const syntheticCwd = path.join(path.parse(homedir()).root, "interlinked-non-temp-project");
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(syntheticCwd);
		vi.resetModules();
		try {
			const { isEphemeralTempPath: classifyEphemeral } = await import("./filesystem-guards.js");
			const underCwd = path.join(syntheticCwd, "definitely-not-a-temp-dir", "file.txt");
			expect(classifyEphemeral(underCwd)).toBe(false);
		} finally {
			cwdSpy.mockRestore();
			vi.resetModules();
		}
	});

	// Kills b9eb5089309f108c: root.endsWith(sep) -> root.startsWith(sep) drops the
	// trailing-separator requirement for POSIX roots (which always start with
	// "/"), so a sibling directory that merely shares the "/tmp" prefix would
	// wrongly read as contained.
	// test-contract: public-api — isEphemeralTempPath requires a trailing
	// path separator after a temp root, not just a shared string prefix.
	it("does not treat a sibling directory sharing the /tmp prefix as ephemeral", () => {
		expect(isEphemeralTempPath("/tmpNotActuallyTmp/secret.txt")).toBe(false);
	});

	// test-contract: public-api — control case establishing the positive
	// behavior isEphemeralTempPath is supposed to have for a genuine /tmp path.
	it("does treat a real path under /tmp as ephemeral", () => {
		expect(isEphemeralTempPath("/tmp/some/file.txt")).toBe(true);
	});
});

describe("filesystem-guards mutation kills — sessionScratchpadAllows", () => {
	// Kills 9a48319c26db66f6: !sessionId -> false. With sessionId = "" (falsy),
	// the real code returns false immediately; the mutant falls through and,
	// because path.split(sep) on an absolute path yields a leading "" segment,
	// indexOf("") finds that leading empty segment and can spuriously satisfy
	// the rest of the check.
	// test-contract: security — sessionScratchpadAllows must never carve out
	// a write path for a caller that supplied no real session id.
	it("rejects an empty sessionId even under an ephemeral scratchpad path", () => {
		expect(sessionScratchpadAllows("/tmp/scratchpad/file.txt", "")).toBe(false);
	});

	// Kills c9bca08aa1f5dcb1: `> sessionIdx` -> `>= sessionIdx`. Using a
	// sessionId literally equal to "scratchpad" makes both indices equal, so
	// the real strict `>` correctly rejects (scratchpad segment is not BELOW
	// the session segment) while the mutant's `>=` wrongly accepts.
	// test-contract: security — the scratchpad segment must sit strictly
	// below the session-id segment, not at or above it.
	it("rejects when the scratchpad segment sits at the same index as the session id", () => {
		expect(sessionScratchpadAllows("/tmp/scratchpad/file.txt", "scratchpad")).toBe(false);
	});

	// test-contract: public-api — control case establishing the positive
	// behavior sessionScratchpadAllows is supposed to have for a well-formed path.
	it("accepts a well-formed session-scoped scratchpad path", () => {
		expect(sessionScratchpadAllows("/tmp/abc-session-123/scratchpad/file.txt", "abc-session-123")).toBe(
			true,
		);
	});
});

describe("filesystem-guards mutation kills — evaluateProtectedFiles", () => {
	const containsSecretsTrue = () => true;
	const containsSecretsFalse = () => false;

	// Kills cd79fda73e910d02: `content && containsSecrets(content)` -> false.
	// test-contract: security — a secrets-check protected-file rule must
	// actually block when the boundary secrets scanner reports a hit.
	it("blocks a secrets-check rule when secrets are detected", () => {
		const decision = evaluateProtectedFiles({
			toolName: "Write",
			filePath: "config/secrets.env",
			content: "API_KEY=abc123",
			protectedFiles: [
				{
					glob: "config/secrets.env",
					operations: ["Write"],
					check: "secrets",
					reason: "no secrets in this file",
				},
			],
			containsSecrets: containsSecretsTrue,
		});
		expect(decision).not.toBeNull();
		expect(decision?.reason).toContain("Secrets detected");
	});

	// test-contract: public-api — control case: a secrets-check rule must not
	// block when the scanner reports no hit (the `&&` short-circuit branch).
	it("does not block a secrets-check rule when no secrets are detected", () => {
		const decision = evaluateProtectedFiles({
			toolName: "Write",
			filePath: "config/secrets.env",
			content: "PLAIN=1",
			protectedFiles: [
				{
					glob: "config/secrets.env",
					operations: ["Write"],
					check: "secrets",
					reason: "no secrets in this file",
				},
			],
			containsSecrets: containsSecretsFalse,
		});
		expect(decision).toBeNull();
	});

	// Kills a23424236befafd1 ("protected-file" -> ""), fbbce2696b52240c
	// ("high" -> ""), 1dde2833652e5c9f ("Security" -> "") — the blanket-block
	// branch's fixed fields.
	// test-contract: public-api — the blanket-block decision's fixed fields
	// (rule_id/severity/category) are the documented contract other callers
	// (e.g. logging, pre_block gate) key off of.
	it("returns the exact rule_id/severity/category for a blanket-block rule", () => {
		const decision = evaluateProtectedFiles({
			toolName: "Write",
			filePath: "README.md",
			content: "",
			protectedFiles: [
				{
					glob: "README.md",
					operations: ["Write"],
					reason: "do not touch the README",
				},
			],
			containsSecrets: containsSecretsFalse,
		});
		expect(decision).not.toBeNull();
		expect(decision?.rule_id).toBe("protected-file");
		expect(decision?.severity).toBe("high");
		expect(decision?.category).toBe("Security");
	});
});

describe("filesystem-guards mutation kills — evaluateRepoConfinement", () => {
	const cwd = "/fake/repo/root";

	// Kills 579aac78832516a5 (cwd.endsWith("/") -> cwd.startsWith("/")) and
	// 947bad0d9592be21 ("/" -> "" in the cwd-normalization branch): both make
	// cwdNormalized collapse to bare `cwd` (no trailing separator), so a
	// sibling directory that merely shares the cwd prefix wrongly reads as
	// "inside" the repo.
	// test-contract: security — repo confinement must require the cwd
	// separator boundary, not just a shared string prefix, before treating a
	// path as inside the repo.
	it("does not treat a sibling directory sharing the cwd prefix as confined", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/fake/repo/rootXYZ/file.txt",
			cwd,
			allowlist: [],
		});
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("block");
	});

	// Kills 7e077f9b03a022ae: `resolvedPath === cwd` -> false. Writing exactly
	// to the repo root itself (no subpath) must be allowed.
	// test-contract: boundary — the repo root itself is the boundary edge
	// case for the confinement predicate (equality, not just prefix-match).
	it("allows a write target that resolves to exactly the repo root", () => {
		const decision = evaluateRepoConfinement({
			rawPath: ".",
			cwd,
			allowlist: [],
		});
		expect(decision).toBeNull();
	});

	// Kills dccbfb57db19a625 ("critical" -> ""), decfa24217477d33
	// ("Security" -> ""), c2adb386d806351d (reason template -> ``).
	// test-contract: public-api — the confinement block's fixed severity,
	// category, and reason text are what the agent-facing message depends on.
	it("returns the exact severity/category/reason for a confinement block", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/outside/anywhere/file.txt",
			cwd,
			allowlist: [],
		});
		expect(decision).not.toBeNull();
		expect(decision?.severity).toBe("critical");
		expect(decision?.category).toBe("Security");
		expect(decision?.reason).toContain("BLOCKED: Writing to /outside/anywhere/file.txt");
		expect(decision?.reason).toContain(cwd);
	});

	// Kills 73ccdc86bbddbdc2: the `linkedProjects: string[] = []` default
	// becoming `["Stryker was here"]`. Omitting linkedProjects entirely must
	// not add the "or a declared linked project" hint.
	// test-contract: public-api — the default-parameter value for
	// linkedProjects must behave as an empty list (no hint) when omitted.
	it("omits the linked-project hint when linkedProjects is not passed at all", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/outside/anywhere/file.txt",
			cwd,
			allowlist: [],
		});
		expect(decision?.reason).not.toContain("or a declared linked project");
	});

	// Kills 6bfc0f781771a5d7 (>0 -> true), 3f1cea4ef7f9d982 (>0 -> >=0),
	// cf47b387b021b03d (>0 -> <=0), 2b2e89554d44e0b5 ("" -> "Stryker was here!"):
	// with an explicitly empty linkedProjects array, the hint must be absent.
	// test-contract: invariant — an explicitly empty linkedProjects array
	// must produce the same "no hint" reason text as the missing-arg case.
	it("omits the linked-project hint for an explicitly empty linkedProjects array", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/outside/anywhere/file.txt",
			cwd,
			allowlist: [],
			linkedProjects: [],
		});
		expect(decision?.reason).not.toContain("or a declared linked project");
	});

	// Kills a16ba7255f3cd55c (>0 -> false), 20b2c678d07e5b27
	// (" or a declared linked project" -> ""): with a non-empty (but
	// non-matching) linkedProjects array, the hint must be present.
	// test-contract: invariant — a non-empty (non-matching) linkedProjects
	// array must add the hint text, the positive counterpart of the empty case.
	it("includes the linked-project hint when linkedProjects is non-empty", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/outside/anywhere/file.txt",
			cwd,
			allowlist: [],
			linkedProjects: ["/some/other/project"],
		});
		expect(decision?.reason).toContain("or a declared linked project");
	});

	// Kills 0fc5dbc16009eae9: prefix.startsWith("~/") -> prefix.endsWith("~/").
	// A "~/allowed" allowlist entry must expand against the real home dir.
	// test-contract: security — a "~/"-prefixed allowlist entry must
	// actually expand against the real home dir, not be resolved literally.
	it("expands a ~/-prefixed allowlist entry against the home directory", () => {
		const home = homedir();
		const target = path.join(home, "allowed-dir", "file.txt");
		const decision = evaluateRepoConfinement({
			rawPath: target,
			cwd,
			allowlist: ["~/allowed-dir"],
		});
		expect(decision).toBeNull();
	});

	// Kills 601c512635d6893c (absPrefix.endsWith("/") -> startsWith("/")) and
	// 794cffb8086ab976 ("/" -> "" in the allowlist branch): both collapse the
	// normalized prefix to the bare absPrefix, so a sibling dir sharing the
	// prefix wrongly matches.
	// test-contract: security — allowlist prefix matching must require the
	// separator boundary, not just a shared string prefix.
	it("does not treat a sibling directory sharing an allowlist prefix as allowed", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/fake/allowedXYZ/file.txt",
			cwd,
			allowlist: ["/fake/allowed"],
		});
		expect(decision).not.toBeNull();
	});

	// Kills 4258825dd86269c5 (`${absPrefix}/` -> ``) and bb4779841e879c24
	// (the whole startsWith||=== condition forced to `true`): both make an
	// unrelated allowlist entry allow an entirely unrelated path.
	// test-contract: security — an unrelated allowlist entry must never
	// allow an entirely unrelated write target.
	it("does not allow a path unrelated to any allowlist entry", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/totally/unrelated/path/file.txt",
			cwd,
			allowlist: ["/fake/allowed"],
		});
		expect(decision).not.toBeNull();
	});

	// Kills 99b405237c2b83b0 (absRoot.endsWith("/") -> startsWith("/")) and
	// b99d2c7b5755567d ("/" -> "" in the linkedProjects branch): both collapse
	// the normalized linked-project root, so a sibling dir wrongly matches.
	// test-contract: security — linked-project prefix matching must require
	// the separator boundary, not just a shared string prefix.
	it("does not treat a sibling directory sharing a linked-project prefix as inside it", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/fake/linkedXYZ/file.txt",
			cwd,
			allowlist: [],
			linkedProjects: ["/fake/linked"],
		});
		expect(decision).not.toBeNull();
	});

	// Kills 4fd1ab2284e7bf46: `resolvedPath === absRoot` -> false. Writing
	// exactly to a linked project's root (no subpath) must be allowed.
	// test-contract: boundary — a linked project's own root is the boundary
	// edge case for the equality branch of its predicate.
	it("allows a write target that resolves to exactly a linked project's root", () => {
		const decision = evaluateRepoConfinement({
			rawPath: "/fake/linked",
			cwd,
			allowlist: [],
			linkedProjects: ["/fake/linked"],
		});
		expect(decision).toBeNull();
	});
});
