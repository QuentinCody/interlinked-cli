// Unit tests for the Go invocation-policy helpers (package scope, build-tag
// threading, environment parity). Pure functions — no subprocess, no fs.
//
// The defect these encode: every `.go` edit spawned THREE project-wide Go
// compilations with three different loader configurations (`go build ./...`,
// `go test -count=1 ./<pkg>`, `golangci-lint run ./...`), so each populated a
// different build-cache key set and re-did work the others had just done.
// Scoping the two project-wide invocations to the edited package, and giving
// all three the same build tags and the same GOCACHE, is the fix.

import { describe, expect, it } from "vitest";
import type { CheckScope } from "../types.js";
import {
	goBuildTagArgs,
	goPackageArg,
	goPackagePattern,
	goToolTags,
	golangciBuildTagArgs,
	parseGoBuildTags,
	resolveGoEnv,
	WHOLE_MODULE_PATTERN,
} from "./go-invocation.js";

const ROOT = "/work/repo";

function fileScope(over: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: ROOT,
		mode: "file",
		targetFile: `${ROOT}/cmd/server/main.go`,
		filterToFile: true,
		...over,
	};
}

// ---------------------------------------------------------------------------
// goPackagePattern — narrowing decision
// ---------------------------------------------------------------------------

describe("goPackagePattern — positive (must fire)", () => {
	it("P1: narrows to the edited file's package in file mode with filterToFile", () => {
		expect(goPackagePattern(fileScope())).toBe("./cmd/server");
	});

	it("P2: narrows to '.' when the edited file sits in the project root", () => {
		expect(goPackagePattern(fileScope({ targetFile: `${ROOT}/main.go` }))).toBe(".");
	});
});

describe("goPackagePattern — negative (must not fire)", () => {
	it("N1: keeps the whole module in project mode (verify runs stay project-wide)", () => {
		expect(goPackagePattern(fileScope({ mode: "project" }))).toBe(WHOLE_MODULE_PATTERN);
	});

	it("N2: keeps the whole module when findings are NOT filtered to the file", () => {
		// Without filterToFile the caller consumes findings from other files,
		// so narrowing would DROP findings rather than just save time.
		expect(goPackagePattern(fileScope({ filterToFile: false }))).toBe(WHOLE_MODULE_PATTERN);
	});

	it("N3: keeps the whole module when targetFile is absent in file mode", () => {
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		expect(goPackagePattern(scope)).toBe(WHOLE_MODULE_PATTERN);
	});

	it("N4: keeps the whole module when the target sits outside the project root", () => {
		expect(goPackagePattern(fileScope({ targetFile: "/elsewhere/x/main.go" }))).toBe(
			WHOLE_MODULE_PATTERN,
		);
	});
});

// ---------------------------------------------------------------------------
// goPackageArg
// ---------------------------------------------------------------------------

describe("goPackageArg — positive (must fire)", () => {
	it("P1: returns a ./-prefixed, forward-slash relative package path", () => {
		expect(goPackageArg({ pkgDir: `${ROOT}/internal/svc`, projectRoot: ROOT })).toBe(
			"./internal/svc",
		);
	});

	it("P2: returns '.' for the project root itself", () => {
		expect(goPackageArg({ pkgDir: ROOT, projectRoot: ROOT })).toBe(".");
	});
});

describe("goPackageArg — negative (must not fire)", () => {
	it("N1: returns null for a directory outside the project root", () => {
		expect(goPackageArg({ pkgDir: "/other/pkg", projectRoot: ROOT })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseGoBuildTags
// ---------------------------------------------------------------------------

describe("parseGoBuildTags — positive (must fire)", () => {
	it("P1: extracts a single tag from -tags=integration", () => {
		expect(parseGoBuildTags("-tags=integration")).toEqual(["integration"]);
	});

	it("P2: extracts a comma list and ignores surrounding flags", () => {
		expect(parseGoBuildTags("-mod=mod -tags=integration,e2e -trimpath")).toEqual([
			"integration",
			"e2e",
		]);
	});

	it("P3: accepts the double-dash and space-separated spellings", () => {
		expect(parseGoBuildTags("--tags netgo")).toEqual(["netgo"]);
	});

	it("P4: the LAST -tags occurrence wins (go's own flag semantics)", () => {
		expect(parseGoBuildTags("-tags=old -tags=new")).toEqual(["new"]);
	});
});

describe("parseGoBuildTags — negative (must not fire)", () => {
	it("N1: returns [] for undefined GOFLAGS", () => {
		expect(parseGoBuildTags(undefined)).toEqual([]);
	});

	it("N2: returns [] when GOFLAGS carries no -tags flag", () => {
		expect(parseGoBuildTags("-mod=vendor -trimpath")).toEqual([]);
	});

	it("N3: does not match a flag that merely starts with 'tags'", () => {
		expect(parseGoBuildTags("-tagsfile=x")).toEqual([]);
	});

	it("N4: drops empty entries from a trailing comma", () => {
		expect(parseGoBuildTags("-tags=a,,b,")).toEqual(["a", "b"]);
	});
});

// ---------------------------------------------------------------------------
// tag → argv
// ---------------------------------------------------------------------------

describe("build-tag argv — positive (must fire)", () => {
	it("P1: go spelling is -tags=<csv>", () => {
		expect(goBuildTagArgs(["a", "b"])).toEqual(["-tags=a,b"]);
	});

	it("P2: golangci-lint spelling is --build-tags=<csv>", () => {
		// golangci-lint does NOT read -tags out of GOFLAGS; its loader needs
		// the flag explicitly or it type-checks a different file set.
		expect(golangciBuildTagArgs(["a", "b"])).toEqual(["--build-tags=a,b"]);
	});
});

describe("build-tag argv — negative (must not fire)", () => {
	it("N1: no tags → no extra argv for go", () => {
		expect(goBuildTagArgs([])).toEqual([]);
	});

	it("N2: no tags → no extra argv for golangci-lint", () => {
		expect(golangciBuildTagArgs([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// resolveGoEnv / goToolTags
// ---------------------------------------------------------------------------

describe("resolveGoEnv — positive (must fire)", () => {
	it("P1: appends INTERLINKED_GOFLAGS to an inherited GOFLAGS", () => {
		const out = resolveGoEnv({ GOFLAGS: "-mod=mod", INTERLINKED_GOFLAGS: "-tags=integration" });
		expect(out.GOFLAGS).toBe("-mod=mod -tags=integration");
	});

	it("P2: sets GOFLAGS from INTERLINKED_GOFLAGS alone", () => {
		expect(resolveGoEnv({ INTERLINKED_GOFLAGS: "-tags=e2e" }).GOFLAGS).toBe("-tags=e2e");
	});

	it("P3: overrides the daemon's inherited GOCACHE with INTERLINKED_GOCACHE", () => {
		const out = resolveGoEnv({ GOCACHE: "/daemon/cache", INTERLINKED_GOCACHE: "/shell/cache" });
		expect(out.GOCACHE).toBe("/shell/cache");
	});

	it("P4: preserves every unrelated variable (PATH, HOME, …)", () => {
		const out = resolveGoEnv({ PATH: "/usr/bin", HOME: "/home/u" });
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/home/u");
	});
});

describe("resolveGoEnv — negative (must not fire)", () => {
	it("N1: leaves GOFLAGS untouched when no override is present", () => {
		expect(resolveGoEnv({ GOFLAGS: "-mod=mod" }).GOFLAGS).toBe("-mod=mod");
	});

	it("N2: does not invent GOFLAGS or GOCACHE when neither side sets them", () => {
		const out = resolveGoEnv({ PATH: "/usr/bin" });
		expect(out.GOFLAGS).toBeUndefined();
		expect(out.GOCACHE).toBeUndefined();
	});

	it("N3: ignores a whitespace-only INTERLINKED_GOCACHE", () => {
		expect(resolveGoEnv({ GOCACHE: "/daemon/cache", INTERLINKED_GOCACHE: "   " }).GOCACHE).toBe(
			"/daemon/cache",
		);
	});
});

describe("goToolTags", () => {
	it("P1: reads tags through the resolved (override-merged) GOFLAGS", () => {
		expect(goToolTags({ INTERLINKED_GOFLAGS: "-tags=integration" })).toEqual(["integration"]);
	});

	it("N1: returns [] for an environment with no Go flags at all", () => {
		expect(goToolTags({ PATH: "/usr/bin" })).toEqual([]);
	});
});
