import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import {
	EXTERNAL_ORIGIN_MAX_FILES,
	externalOriginOf,
	recordExternalOriginFile,
} from "./external-origin-files.js";
import { evaluatePostToolUse } from "./post-tool.js";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
let dir: string;
let session: SessionTrajectory;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ext-origin-"));
	session = makeSession();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function post(command: string, extra: Partial<HarnessEvent> = {}): void {
	const event: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: "t",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		tool_response: "",
		cwd: dir,
		timestamp: "2026-10-05T00:00:00.000Z",
		...extra,
	};
	evaluatePostToolUse(event, getDefaultConfig(), session, new ReservationManager(), new CohortManager());
}

function file(name: string, body = "<html>public page</html>"): string {
	const p = join(dir, name);
	writeFileSync(p, body);
	return p;
}

describe("external-origin registry — positive (must record)", () => {
	it("P1: curl -sL -o <file> <public url>", () => {
		const p = file("yt.html");
		post(`curl -sL -o yt.html ${YT}`);
		expect(externalOriginOf(session, p)?.source).toBe(YT);
	});

	it("P2: curl -O names the file after the URL's last path segment", () => {
		const p = file("page.html");
		post("curl -sLO https://example.com/a/page.html");
		expect(externalOriginOf(session, p)).toBeDefined();
	});

	it("P3: wget -O <file> and wget --output-document=<file>", () => {
		const a = file("a.html");
		const b = file("b.html");
		post("wget -q -O a.html https://example.com/");
		post("wget --output-document=b.html https://example.com/x");
		expect([externalOriginOf(session, a) !== undefined, externalOriginOf(session, b) !== undefined]).toEqual([true, true]);
	});

	it("P4: wget with no -O records the URL basename", () => {
		const p = file("bundle.js");
		post("wget https://cdn.example.com/static/bundle.js");
		expect(externalOriginOf(session, p)).toBeDefined();
	});

	it("P5: yt-dlp -o <literal file>", () => {
		const p = file("meta.json");
		post(`yt-dlp --skip-download -o meta.json ${YT}`);
		expect(externalOriginOf(session, p)).toBeDefined();
	});

	it("P6: stdout redirect and tee of a pipeline whose producer is a public fetch", () => {
		const r = file("r.html");
		const t = file("t.html");
		post("curl -s https://example.com/r > r.html");
		post("curl -s https://example.com/t | grep -v x | tee t.html");
		expect([externalOriginOf(session, r) !== undefined, externalOriginOf(session, t) !== undefined]).toEqual([true, true]);
	});

	it("P7: a same-command cd moves the base the target resolves against", () => {
		mkdirSync(join(dir, "sub"));
		const p = file("sub/a.html");
		post("cd sub && curl -s -o a.html https://example.com/a");
		expect(externalOriginOf(session, p)).toBeDefined();
	});

	it("P8: a for-loop fetch with a bound variable records every expansion", () => {
		const a = file("yt_a.html");
		const b = file("yt_b.html");
		post('for s in a b; do curl -sL -o "yt_$s.html" "https://www.youtube.com/watch?v=$s"; done');
		expect([externalOriginOf(session, a) !== undefined, externalOriginOf(session, b) !== undefined]).toEqual([true, true]);
	});
});

describe("external-origin registry — negative (must not record / must forget)", () => {
	it("N1: a loopback fetch is local content", () => {
		const p = file("local.html");
		post("curl -s -o local.html http://localhost:8080/");
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N2: an authenticated fetch may return private data", () => {
		const p = file("me.json");
		post('curl -s -H "Authorization: Bearer abc" -o me.json https://api.github.com/user');
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N3: a non-http scheme (file://) reads the local disk", () => {
		const p = file("hosts.txt");
		post("curl -s -o hosts.txt file:///etc/hosts");
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N4: a Write tool overwrite removes the file", () => {
		const p = file("yt.html");
		post(`curl -sL -o yt.html ${YT}`);
		post("", { tool_name: "Write", tool_input: { file_path: p, content: "local" } });
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N5: a non-network redirect overwrite removes the file", () => {
		const p = file("yt.html");
		post(`curl -sL -o yt.html ${YT}`);
		post("cat notes.txt > yt.html");
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N6: a dry run records nothing", () => {
		const p = file("yt.html");
		post(`curl -sL -o yt.html ${YT}`, { dry_run: true });
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N7: a file changed after it was recorded no longer counts as external", () => {
		const p = file("yt.html");
		post(`curl -sL -o yt.html ${YT}`);
		writeFileSync(p, "changed by another process, different size");
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N8: a later non-filter command in the same line that names the file blocks the record", () => {
		const p = file("yt.html");
		post(`curl -sL -o yt.html ${YT} && cp ~/creds.json yt.html`);
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N9: a stale file (not written by this command) is not recorded", () => {
		const p = file("old.html");
		const old = new Date("2020-01-01T00:00:00.000Z");
		utimesSync(p, old, old);
		post("curl -s -o old.html https://example.com/");
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N10: a pipeline through an interpreter is not a filter; its redirect is not recorded", () => {
		const p = file("out.html");
		post("curl -s https://example.com/ | python3 x.py > out.html");
		expect(externalOriginOf(session, p)).toBeUndefined();
	});

	it("N11: the registry keeps only the newest entries", () => {
		const first = file("f0.html");
		recordExternalOriginFile(session, first, "https://example.com/0");
		for (let i = 1; i <= EXTERNAL_ORIGIN_MAX_FILES; i++) {
			recordExternalOriginFile(session, file(`f${i}.html`), `https://example.com/${i}`);
		}
		expect(externalOriginOf(session, first)).toBeUndefined();
		expect(externalOriginOf(session, join(dir, `f${EXTERNAL_ORIGIN_MAX_FILES}.html`))).toBeDefined();
	});
});
