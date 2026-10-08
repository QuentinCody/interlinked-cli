import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { evaluatePostToolUse } from "./post-tool.js";

// Built at run time so this source file carries no literal key shape.
const KEY = ["AIza", "SyB3xQ7mNp2LkR8vT1wZ5cH9jF4gD6sA0eU"].join("");
const AWS = ["AKIA", "IOSFODNN7EXAMPLQ"].join("");
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
let dir: string;
let session: SessionTrajectory;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secret-origin-"));
	session = makeSession();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function post(command: string, output: string, extra: Partial<HarnessEvent> = {}): string[] {
	const event: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: "t",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		tool_response: output,
		cwd: dir,
		timestamp: "2026-10-05T00:00:00.000Z",
		...extra,
	};
	const res = evaluatePostToolUse(event, getDefaultConfig(), session, new ReservationManager(), new CohortManager());
	return res.warnings ?? [];
}

function fetchPage(name: string, url = YT): void {
	writeFileSync(join(dir, name), `<script>ytcfg.set({"INNERTUBE_API_KEY":"${KEY}"})</script>`);
	post(`curl -sL -o ${name} ${url}`, "");
}

const RG_INNERTUBE = `rg -o '"INNERTUBE_API_KEY":"[^"]+"'`;

describe("secret-shaped Bash output — fetched origin (must NOT ratchet)", () => {
	it("P1 (H3 reproduction): curl -o yt.html <watch url>, then rg -o INNERTUBE_API_KEY yt.html ⇒ level unchanged", () => {
		fetchPage("yt.html");
		const ws = post(`${RG_INNERTUBE} yt.html`, `"INNERTUBE_API_KEY":"${KEY}"\n`);
		expect(session.sensitivity_level).toBe("Public");
		const line = ws.find((w) => w.startsWith("[interlinked:output-scan]"));
		expect(line).toBe(
			`[interlinked:output-scan] secret-shaped value (sig-secret-gcp-api) in content fetched from ${YT} — ` +
				"treated as public; session sensitivity unchanged. Do NOT include these in subsequent messages or file writes.",
		);
	});

	it("P2: the fetched-origin hit leaves an audit source at Public with its signature and origin", () => {
		fetchPage("yt.html");
		post(`${RG_INNERTUBE} yt.html`, `"INNERTUBE_API_KEY":"${KEY}"\n`);
		const audit = session.taint_sources.find((s) => s.file === "<command-output:public-origin>");
		expect(audit).toMatchObject({ level: "Public", provenance: "fetched_external" });
		expect(audit?.detail).toBe(`sig-secret-gcp-api fetched from ${YT}`);
		expect(audit?.escalated).toBeUndefined();
	});

	it("P3: curl <public url> | rg AIza ⇒ unchanged", () => {
		post(`curl -sL ${YT} | rg -o 'AIza[0-9A-Za-z_-]{35}'`, `${KEY}\n`);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("P4: the original loop shape over several fetched pages ⇒ unchanged", () => {
		fetchPage("yt_watch_a.html");
		fetchPage("yt_watch_b.html");
		post(`for s in a b; do echo "== $s"; ${RG_INNERTUBE} yt_watch_$s.html; done`, `== a\n"INNERTUBE_API_KEY":"${KEY}"\n`);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("P5: fetch and search in one command ⇒ unchanged", () => {
		writeFileSync(join(dir, "one.html"), `"INNERTUBE_API_KEY":"${KEY}"`);
		post(`curl -sL -o one.html ${YT} && ${RG_INNERTUBE} one.html`, `"INNERTUBE_API_KEY":"${KEY}"\n`);
		expect(session.sensitivity_level).toBe("Public");
	});
});

describe("secret-shaped Bash output — public-credential context (Internal, not Confidential)", () => {
	it("P6: a local page whose key sits in a registered public context ⇒ Internal", () => {
		writeFileSync(join(dir, "saved.html"), `"INNERTUBE_API_KEY":"${KEY}"`);
		const ws = post("cat saved.html", `"INNERTUBE_API_KEY":"${KEY}"`);
		expect(session.sensitivity_level).toBe("Internal");
		expect(ws.some((w) => w.includes("public-credential context (youtube-innertube-api-key)"))).toBe(true);
	});
});

// Review 3b item 5: printing regex SOURCE is not printing a secret.
describe("secret-shaped Bash output — regex source text (must NOT ratchet)", () => {
	it("N-R1: sed over our own signature source stays Public", () => {
		// Already passes: lines 25–40 hold only character-class patterns, whose
		// `[` breaks every closed-alphabet signature (AIza[…], AKIA[…]).
		const src = readFileSync(join(process.cwd(), "src/harness/signatures-patterns-secrets.ts"), "utf8");
		const lines = src.split("\n").slice(24, 40).join("\n");
		post("sed -n 25,40p src/harness/signatures-patterns-secrets.ts", lines);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("N-R2: printing connection-string and URL-credential regexes stays Public", () => {
		const out = 'docs/patterns.md:3: DB = "postgres://[^:]+:[^@]+@[^/]+/db"\ndocs/patterns.md:4: https://[^:/\\s]+:[^@/\\s]{4,}@\n';
		post("rg -n 'postgres|https' docs/patterns.md", out);
		expect(session.sensitivity_level).toBe("Public");
	});
});

describe("secret-shaped Bash output — regex source text next to real tokens (must ratchet)", () => {
	// Decision: a shape-valid placeholder in an example env file still ratchets;
	// the scanner cannot tell a placeholder from a key with the same shape.
	it("P-R1: cat .env.example printing a shape-valid key ⇒ Confidential", () => {
		writeFileSync(join(dir, ".env.example"), `GOOGLE_API_KEY=${KEY}\n`);
		post("cat .env.example", `GOOGLE_API_KEY=${KEY}\n`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("P-R2: a concrete token adjacent to regex text ⇒ Confidential", () => {
		post("rg -n AKIA notes.md", `notes.md:1: ${AWS}[0-9]{16}\n`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("P-R3: a real connection string after a regex for it ⇒ Confidential", () => {
		post("rg -n postgres notes.md", "notes.md:1: postgres://[^:]+:[^@]+@\nnotes.md:2: postgres://admin:hunter2pw@db.example.com/x\n");
		expect(session.sensitivity_level).toBe("Confidential");
	});
});

describe("secret-shaped Bash output — local or uncertain origin (must ratchet to Confidential)", () => {
	it("N1: cat of a local credentials file printing a key ⇒ Confidential", () => {
		mkdirSync(join(dir, ".config/app"), { recursive: true });
		writeFileSync(join(dir, ".config/app/creds.json"), `{"key":"${KEY}"}`);
		post("cat .config/app/creds.json", `{"key":"${KEY}"}`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N2: mixed operands (one fetched, one local) ⇒ Confidential", () => {
		fetchPage("yt.html");
		writeFileSync(join(dir, "creds.json"), `{"key":"${KEY}"}`);
		post("rg AIza yt.html creds.json", `creds.json:{"key":"${KEY}"}`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N3: a fetched file overwritten by the Write tool is local again ⇒ Confidential", () => {
		fetchPage("yt.html");
		post("", "", { tool_name: "Write", tool_input: { file_path: join(dir, "yt.html"), content: `k=${KEY}` } });
		writeFileSync(join(dir, "yt.html"), `k=${KEY}`);
		post("rg AIza yt.html", `k=${KEY}`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N4: rg with no path searches the working tree ⇒ Confidential", () => {
		fetchPage("yt.html");
		post("rg -o AIza", `yt.html:${KEY}`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N5: a fetch pipeline that also reads a local file ⇒ Confidential", () => {
		writeFileSync(join(dir, "creds.json"), `{"key":"${KEY}"}`);
		post(`curl -sL ${YT} | cat - creds.json`, `{"key":"${KEY}"}`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N6: an authenticated fetch may return private data ⇒ Confidential", () => {
		post('curl -s -H "Authorization: Bearer abc" https://api.example.com/me | rg AIza', KEY);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N7: a key in a public context plus an AWS key outside any context ⇒ Confidential", () => {
		writeFileSync(join(dir, "mixed.txt"), "x");
		post("cat mixed.txt", `"INNERTUBE_API_KEY":"${KEY}"\nAWS_ACCESS_KEY_ID=${AWS}\n`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N8: echo of an environment variable ⇒ Confidential", () => {
		post("echo $GCP_KEY", KEY);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N9: an interpreter reading a fetched file is not a known filter ⇒ Confidential", () => {
		fetchPage("yt.html");
		post("python3 -c 'print(open(\"yt.html\").read())'", KEY);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N10: the Confidential source names the signature and the command excerpt", () => {
		post("printenv", `GCP=${KEY}`);
		expect(session.taint_sources[0]).toMatchObject({
			file: "<command-output>",
			level: "Confidential",
			escalated: true,
			detail: "sig-secret-gcp-api from `printenv`",
		});
	});

	// Review 3b item 4: a fetch that UPLOADS a local file may echo it back
	// (httpbin-style echo servers), so its output is local, never "fetched".
	it("N12: curl uploading a local file (-d / --data-binary / -F / -T / --json @file) ⇒ Confidential", () => {
		writeFileSync(join(dir, "body.json"), `{"k":"${KEY}"}`);
		for (const flags of ["-d @body.json", "--data-binary @body.json", "-F x=@body.json", "-T body.json", "--json @body.json"]) {
			session = makeSession();
			post(`curl -s ${flags} https://httpbin.org/anything`, `{"data":"${KEY}"}`);
			expect(session.sensitivity_level, flags).toBe("Confidential");
		}
	});

	it("N13: curl with an inline POST body is not a public GET ⇒ Confidential", () => {
		post("curl -s -d 'q=1' https://httpbin.org/anything", `{"k":"${KEY}"}`);
		expect(session.sensitivity_level).toBe("Confidential");
	});

	it("N11: a command excerpt carrying a secret is redacted and capped at 120 chars", () => {
		post(`echo ${KEY} ${"x".repeat(200)}`, KEY);
		const detail = session.taint_sources[0]?.detail ?? "";
		expect(detail).not.toContain(KEY);
		expect(detail).toContain("[REDACTED]");
		expect(detail.length).toBeLessThanOrEqual("sig-secret-gcp-api from ``".length + 120);
	});
});
