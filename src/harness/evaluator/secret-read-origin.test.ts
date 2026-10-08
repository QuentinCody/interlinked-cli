import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import { formatTaintSources } from "../taint-tracker.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { evaluatePostToolUse } from "./post-tool.js";
import { readResponseText, scanReadSecretLeaks } from "./secret-read-origin.js";

// Built at run time so this source file carries no literal key shape.
const AWS = ["AKIA", "IOSFODNN7EXAMPLQ"].join("");
const GKEY = ["AIza", "SyB3xQ7mNp2LkR8vT1wZ5cH9jF4gD6sA0eU"].join("");
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

let dir: string;
let session: SessionTrajectory;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "secret-read-")));
	session = makeSession();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, body: string): string {
	const p = join(dir, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, body);
	return p;
}

function event(tool: string, input: Record<string, unknown>, response: unknown, extra: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "t",
		agent_source: "claude",
		tool_name: tool,
		tool_input: input,
		tool_response: response,
		cwd: dir,
		timestamp: "2026-10-05T00:00:00.000Z",
		...extra,
	};
}

/** Claude Code's Read response shape. */
function readResponse(path: string, content: string): unknown {
	return { type: "text", file: { filePath: path, content, numLines: 1, startLine: 1, totalLines: 1 } };
}

function post(ev: HarnessEvent, rules: GuardRulesConfig = getDefaultConfig()): string[] {
	return evaluatePostToolUse(ev, rules, session, new ReservationManager(), new CohortManager()).warnings ?? [];
}

function read(path: string, content: string, extra: Partial<HarnessEvent> = {}): string[] {
	return post(event("Read", { file_path: path }, readResponse(path, content), extra));
}

function git(...args: string[]): void {
	execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
		stdio: "ignore",
	});
}

describe("Read output secret scan — positive (must ratchet to Confidential)", () => {
	it("P1: Read of an untracked ~-style credentials file outside the repo ⇒ Confidential, named by path", () => {
		const p = put("home/.config/tool/token.json", `{"aws_access_key_id":"${AWS}"}`);
		read(p, `{"aws_access_key_id":"${AWS}"}`);
		expect(session.sensitivity_level).toBe("Confidential");
		expect(formatTaintSources(session)).toContain(`<read: sig-secret-aws-key in ${p}>`);
	});

	it("P2: Read of a gitignored .env.local with a key ⇒ Confidential, set by the content scan", () => {
		git("init", "-q");
		put(".gitignore", ".env.local\n");
		const p = put(".env.local", `AWS_ACCESS_KEY_ID=${AWS}\n`);
		const warnings = scanReadSecretLeaks(event("Read", { file_path: p }, readResponse(p, `AWS_ACCESS_KEY_ID=${AWS}`)), getDefaultConfig(), session, dir);
		expect(session.sensitivity_level).toBe("Confidential");
		expect(session.taint_sources.at(-1)?.file).toBe("<read>");
		expect(warnings.join("\n")).toContain("sig-secret-aws-key");
	});

	it("P3: Read of a gitignored test fixture ⇒ Confidential (no HEAD blob)", () => {
		git("init", "-q");
		put(".gitignore", "tests/fixtures/local.json\n");
		const p = put("tests/fixtures/local.json", `{"k":"${AWS}"}`);
		git("add", "-A");
		git("commit", "-q", "-m", "x");
		scanReadSecretLeaks(event("Read", { file_path: p }, readResponse(p, `{"k":"${AWS}"}`)), getDefaultConfig(), session, dir);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("P4: a fetched page modified after the fetch is local again ⇒ Confidential", () => {
		const p = put("yt.html", `<script>{"INNERTUBE_API_KEY":"${GKEY}"}</script>`);
		post(event("Bash", { command: `curl -sL -o yt.html ${YT}` }, ""));
		writeFileSync(p, `planted ${AWS} and a longer body`);
		read(p, `planted ${AWS} and a longer body`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("P5: a plain string response (other runners) is scanned too", () => {
		const p = put("creds.txt", AWS);
		post(event("Read", { file_path: p }, `1\t${AWS}`));
		expect(session.sensitivity_level).toBe("Confidential");
	});
});

describe("Read output secret scan — escalation tier (Internal, not Confidential)", () => {
	it("N1: Read of a tracked test fixture whose fake key is committed ⇒ Internal", () => {
		git("init", "-q");
		const p = put("src/__tests__/sig.test.ts", `const k = "${AWS}";\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "x");
		const warnings = scanReadSecretLeaks(event("Read", { file_path: p }, readResponse(p, `const k = "${AWS}";`)), getDefaultConfig(), session, dir);
		expect(session.sensitivity_level).toBe("Internal");
		expect(session.taint_sources.at(-1)?.detail).toContain("committed test fixture");
		expect(warnings.join("\n")).toContain("Internal");
	});

	it("N2: a key inside a registered public-credential context ⇒ Internal", () => {
		const p = put("page.html", `ytcfg.set({"INNERTUBE_API_KEY":"${GKEY}"})`);
		read(p, `ytcfg.set({"INNERTUBE_API_KEY":"${GKEY}"})`);
		expect(session.sensitivity_level).toBe("Internal");
	});
});

describe("Read output secret scan — negative (must NOT ratchet)", () => {
	it("N3: Read of a fetched, unchanged page ⇒ level unchanged, audit source recorded", () => {
		const body = `<script>{"k":"${AWS}"}</script>`;
		const p = put("page.html", body);
		post(event("Bash", { command: "curl -sL -o page.html https://example.com/page.html" }, ""));
		const warnings = read(p, body);
		expect(session.sensitivity_level).toBe("Public");
		expect(session.taint_sources.at(-1)).toMatchObject({ file: "<read:public-origin>", level: "Public" });
		expect(warnings.join("\n")).toContain("treated as public");
	});

	it("N4: a dry_run Read warns but changes no session state", () => {
		const p = put("home/.config/tool/token.json", AWS);
		const warnings = read(p, AWS, { dry_run: true });
		expect(session.sensitivity_level).toBe("Public");
		expect(session.taint_sources).toEqual([]);
		expect(warnings.join("\n")).toContain("sig-secret-aws-key");
	});

	it("N5: a Read with no secret signature ⇒ no output-scan warning", () => {
		const p = put("notes.md", "nothing secret here, just prose");
		const warnings = read(p, "nothing secret here, just prose");
		expect(warnings.filter((w) => w.includes("output-scan"))).toEqual([]);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("N6: secret output scanning switched off ⇒ no ratchet from content", () => {
		const rules = getDefaultConfig();
		rules.output_scanning = { ...rules.output_scanning, scan_bash_secrets: false };
		const p = put("token.txt", AWS);
		post(event("Read", { file_path: p }, readResponse(p, AWS)), rules);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("N7: a Bash call is not handled by the Read scan", () => {
		expect(scanReadSecretLeaks(event("Bash", { command: "true" }, AWS), getDefaultConfig(), session, dir)).toEqual([]);
	});
});

describe("readResponseText", () => {
	it("P: Claude Code's {file:{content}} shape yields the raw content", () => {
		expect(readResponseText(readResponse("/x", 'a "quoted" line'))).toBe('a "quoted" line');
	});
	it("P: a string response is returned as is; another object is JSON text", () => {
		expect([readResponseText("abc"), readResponseText({ cells: ["x"] })]).toEqual(["abc", '{"cells":["x"]}']);
	});
	it("N: an absent response is empty", () => {
		expect([readResponseText(undefined), readResponseText(null)]).toEqual(["", ""]);
	});
});
