import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import {
	classifyBashCommandProvenance,
	recordBashTaintSource,
} from "./bash-provenance.js";
import type { SessionTrajectory } from "./types.js";

describe("classifyBashCommandProvenance", () => {
	describe("fetched_external", () => {
		it("tags `gh issue view <n>` as fetched_external", () => {
			expect(classifyBashCommandProvenance("gh issue view 42")).toBe("fetched_external");
		});

		it("tags `gh pr view <n>` as fetched_external", () => {
			expect(classifyBashCommandProvenance("gh pr view 7 --json body")).toBe(
				"fetched_external",
			);
		});

		it("tags `gh gist view <id>` as fetched_external", () => {
			expect(classifyBashCommandProvenance("gh gist view abc123")).toBe("fetched_external");
		});

		it("tags `gh api repos/owner/repo/issues/1` as fetched_external", () => {
			expect(classifyBashCommandProvenance("gh api repos/owner/repo/issues/1")).toBe(
				"fetched_external",
			);
		});

		it("tags `glab issue view <n>` as fetched_external", () => {
			expect(classifyBashCommandProvenance("glab issue view 5")).toBe("fetched_external");
		});

		it("tags `glab mr view <n>` as fetched_external", () => {
			expect(classifyBashCommandProvenance("glab mr view 12")).toBe("fetched_external");
		});

		it("tags `curl https://...` (non-localhost) as fetched_external", () => {
			expect(classifyBashCommandProvenance("curl https://example.com/page")).toBe(
				"fetched_external",
			);
		});

		it("tags `wget https://...` (non-localhost) as fetched_external", () => {
			expect(classifyBashCommandProvenance("wget https://example.com/file.tar.gz")).toBe(
				"fetched_external",
			);
		});

		it("tags httpie `http https://...` as fetched_external", () => {
			expect(classifyBashCommandProvenance("http https://example.com/api/v1/items")).toBe(
				"fetched_external",
			);
		});

		it("tags `npm view <pkg>` as fetched_external (registry query)", () => {
			expect(classifyBashCommandProvenance("npm view lodash version")).toBe(
				"fetched_external",
			);
		});

		it("tags `pip show <pkg>` as fetched_external (registry query)", () => {
			expect(classifyBashCommandProvenance("pip show requests")).toBe("fetched_external");
		});
	});

	describe("not fetched_external (negative cases)", () => {
		it("returns null for `curl http://localhost:3000/api`", () => {
			expect(classifyBashCommandProvenance("curl http://localhost:3000/api")).toBeNull();
		});

		it("returns null for `curl http://127.0.0.1:8080/`", () => {
			expect(classifyBashCommandProvenance("curl http://127.0.0.1:8080/")).toBeNull();
		});

		it("returns null for `gh auth status` (no fetch)", () => {
			expect(classifyBashCommandProvenance("gh auth status")).toBeNull();
		});

		it("returns null for `gh repo clone owner/repo` (clone is not a body fetch)", () => {
			expect(classifyBashCommandProvenance("gh repo clone owner/repo")).toBeNull();
		});

		it("returns null for `npm install lodash` (install is not a view)", () => {
			expect(classifyBashCommandProvenance("npm install lodash")).toBeNull();
		});

		it("returns null for `ls -la` (unrelated)", () => {
			expect(classifyBashCommandProvenance("ls -la")).toBeNull();
		});

		it("returns null for empty command", () => {
			expect(classifyBashCommandProvenance("")).toBeNull();
		});
	});
});

// 2026-10-05: leg 2 is a source only when the command actually fetches
// (network-intent.ts). A URL a local command merely names is not content the
// agent ingested from the internet.
describe("classifyBashCommandProvenance — network-intent leg 2 (positive, must fire)", () => {
	it("P1: a curl inside a for-loop body is a fetch", () => {
		expect(classifyBashCommandProvenance("for s in a b; do curl -s https://example.com/$s; done")).toBe("fetched_external");
	});
	it("P2: a python program that calls urlopen on a literal public URL is a fetch", () => {
		expect(classifyBashCommandProvenance("python3 -c \"import urllib.request as u; print(u.urlopen('https://example.com').read())\"")).toBe("fetched_external");
	});
	it("P3: yt-dlp on a public URL is a fetch", () => {
		expect(classifyBashCommandProvenance("yt-dlp --skip-download https://www.youtube.com/watch?v=x")).toBe("fetched_external");
	});
});

describe("classifyBashCommandProvenance — network-intent leg 2 (negative, must not fire)", () => {
	it("N1: echo of a URL is not a fetch", () => {
		expect(classifyBashCommandProvenance("echo https://example.com/probe > /dev/null")).toBeNull();
	});
	it("N2: rg over notes that name a URL is not a fetch", () => {
		expect(classifyBashCommandProvenance("rg -n 'https://antithesis.com/blog/' notes.md")).toBeNull();
	});
	it("N3: a python program that only rewrites URL strings is not a fetch", () => {
		expect(classifyBashCommandProvenance("python3 -c \"print('https://a.example.com/x'.replace('https://a.example.com',''))\"")).toBeNull();
	});
	it("N4: a curl to a private LAN host is not public content", () => {
		expect(classifyBashCommandProvenance("curl http://192.168.1.20:8080/health")).toBeNull();
	});
});

describe("recordBashTaintSource", () => {
	function makeSession(): SessionTrajectory {
		return ({ ...completeSessionFixture(), ...{
			session_id: "s1",
			agent_name: "tester",
			tool_call_count: 3,
			sensitivity_level: "Public",
			taint_sources: [],
		} });
	}

	it("appends a TaintSource with the given provenance", () => {
		const session = makeSession();
		recordBashTaintSource(session, "gh issue view 42", "fetched_external");
		expect(session.taint_sources).toHaveLength(1);
		expect(session.taint_sources[0]?.provenance).toBe("fetched_external");
	});

	it("records the command (truncated) as the taint source's `file`", () => {
		const session = makeSession();
		recordBashTaintSource(session, "gh issue view 42", "fetched_external");
		expect(session.taint_sources[0]?.file).toContain("gh issue view 42");
	});

	it("records the current tool_call_count as at_step", () => {
		const session = makeSession();
		recordBashTaintSource(session, "wget https://example.com", "fetched_external");
		expect(session.taint_sources[0]?.at_step).toBe(3);
	});

	it("attributes level=Public (untrusted-but-public is the common case)", () => {
		const session = makeSession();
		recordBashTaintSource(session, "gh api repos/o/r/issues/1", "fetched_external");
		expect(session.taint_sources[0]?.level).toBe("Public");
	});

	it("truncates extremely long commands to keep taint_sources bounded", () => {
		const session = makeSession();
		const long = `curl https://example.com/${"x".repeat(500)}`;
		recordBashTaintSource(session, long, "fetched_external");
		expect(session.taint_sources[0]?.file.length).toBeLessThan(300);
	});
});
