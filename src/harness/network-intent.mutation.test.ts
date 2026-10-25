// Mutation-hardening tests for network-intent.ts. URL literals are DATA: every case runs
// in the classifier and no test opens a socket. Behavior basis is cited per test as
// network-intent.ts header/doc-comment lines (the module header is lines 1-31).
import { describe, expect, it } from "vitest";
import { classifyNetworkIntent, fetchesPublicContent, isExternalNetworkIntent } from "./network-intent.js";

const intentOf = classifyNetworkIntent;
const net = (cmd: string): boolean => classifyNetworkIntent(cmd).network;
const external = (cmd: string): boolean => isExternalNetworkIntent(classifyNetworkIntent(cmd));

/** Wrap `cmd` in `levels` layers of `bash -c '…'`, single-quoting each layer. */
function nestBash(cmd: string, levels: number): string {
	let out = cmd;
	for (let i = 0; i < levels; i++) out = `bash -c '${out.replace(/'/g, "'\\''")}'`;
	return out;
}

describe("nested shell programs (header lines 25-26, MAX_DEPTH comment lines 85-86)", () => {
	it("follows a curl nested four shell levels deep but not five", () => {
		expect(net(nestBash("curl https://example.com", 4))).toBe(true);
		expect(net(nestBash("curl https://example.com", 5))).toBe(false);
	});
	it("a curl nested three shell levels deep is followed (each nested shell costs one level)", () => {
		expect(net(nestBash("curl https://example.com", 3))).toBe(true);
	});
	it("`eval` with several words reads all of them as the command", () => {
		const intent = intentOf("eval curl https://example.com");
		expect(intent).toMatchObject({ network: true, hosts: ["example.com"] });
	});
	it.each(["zsh", "ksh", "dash", "sh"])("`%s -c` reads its string as shell", (shell) => {
		expect(net(`${shell} -c "curl https://example.com"`)).toBe(true);
	});
	it("a shell running a script FILE is not inspected, even when a later `-c` follows (line 28)", () => {
		const intent = intentOf('bash script.sh -c "curl https://example.com"');
		expect(intent.network).toBe(false);
		expect(isExternalNetworkIntent(intent)).toBe(true);
	});
});

describe("heredocs (header lines 16-17, 23-26)", () => {
	it("a command after the heredoc operator on the same line is still read", () => {
		expect(net("cat <<EOF && curl https://example.com\nbody\nEOF")).toBe(true);
	});
	it("with two heredocs, a shell body is taken from ITS OWN heredoc, not the first", () => {
		const intent = intentOf("cat <<A\nnotes\nA\nbash <<B\ncurl https://example.com\nB");
		expect(intent).toMatchObject({ network: true, hosts: ["example.com"] });
	});
	it("an inline `-c` program outranks a heredoc on stdin (python -c ignores stdin)", () => {
		expect(net("python3 -c 'import requests; requests.get(u)' <<EOF\nprint(1)\nEOF")).toBe(true);
		expect(net("python3 -c 'print(1)' <<EOF\nimport requests; requests.get(u)\nEOF")).toBe(false);
	});
	it("a script FILE given a heredoc is still unreadable code handed a public URL (line 28)", () => {
		const intent = intentOf("python3 x.py https://ex.com <<EOF\ndata\nEOF");
		expect(intent.network).toBe(false);
		expect(intent.opaque).toHaveLength(1);
		expect(isExternalNetworkIntent(intent)).toBe(true);
	});
	it("an UNQUOTED heredoc delimiter expands `$(…)` in the body; a quoted one does not (lines 355-356)", () => {
		expect(net("cat <<EOF\n$(curl https://example.com)\nEOF")).toBe(true);
		expect(net("cat <<'EOF'\n$(curl https://example.com)\nEOF")).toBe(false);
	});
});

describe("quoting, comments and substitutions (header lines 18-19, 26-27)", () => {
	it("a `#` inside a word (`a#b`) is not a comment", () => {
		expect(net("echo a#b; curl https://example.com")).toBe(true);
	});
	it("a `#` inside double quotes is not a comment", () => {
		expect(net('echo "see #1"; curl https://example.com')).toBe(true);
	});
	it("a comment ends at its own line: the next line still runs", () => {
		expect(net("echo a # note\ncurl https://example.com")).toBe(true);
		expect(net("# only a comment\ncurl https://example.com")).toBe(true);
	});
	it("a backtick substitution runs its body as a command", () => {
		expect(net("echo `curl https://example.com`")).toBe(true);
	});
	it("an apostrophe inside double quotes does not open a single-quoted string", () => {
		expect(net(`echo "it's" # c\ncurl https://example.com`)).toBe(true);
		expect(net(`echo "it's"\ncurl https://example.com`)).toBe(true);
		expect(net(`echo "don't" "$(curl https://example.com)"`)).toBe(true);
	});
	it("a double quote inside single quotes does not open a double-quoted string", () => {
		expect(net(`echo 'say "hi"'\ncurl https://example.com`)).toBe(true);
		expect(net(`echo 'a"b'\ncurl https://example.com`)).toBe(true);
	});
	it("a backslash is literal inside single quotes", () => {
		expect(net("echo 'a\\'\ncurl https://example.com")).toBe(true);
		expect(net("echo 'a\\'; curl https://example.com")).toBe(true);
		expect(net("echo 'a\\' # c\ncurl https://example.com")).toBe(true);
	});
});

describe("compound keywords, wrappers and prefixes (header lines 20-22)", () => {
	it("`while curl …; do` and `time curl …` find the curl past the keyword", () => {
		expect(net("while curl -s https://example.com; do sleep 1; done")).toBe(true);
		expect(net("time curl https://example.com")).toBe(true);
	});
	it("a proxy variable prefix makes a loopback URL leave the machine", () => {
		expect(net("https_proxy=http://proxy.example.com:3128 curl http://127.0.0.1/x")).toBe(true);
		expect(net("curl http://127.0.0.1/x")).toBe(false);
	});
	it("`xargs` hides its arguments even when another wrapper sits between it and the verb", () => {
		expect(net("xargs sudo curl -s http://127.0.0.1:8080/")).toBe(true);
		expect(net("xargs timeout 5 curl -s http://127.0.0.1:8080/")).toBe(true);
		expect(net("sudo curl -s http://127.0.0.1:8080/")).toBe(false);
	});
	it("`command -v` only looks a word up: it neither runs it nor counts as an unreadable program", () => {
		expect(external("command -v ./tool https://example.com/x")).toBe(false);
	});
});

describe("results: via, hosts, loopback and external (NetworkIntent docs, lines 49-62)", () => {
	it("a loopback-only interpreter call is recorded but is not outbound", () => {
		const intent = intentOf(`python3 -c "import urllib.request as u; u.urlopen('http://127.0.0.1:80')"`);
		expect(intent.network).toBe(false);
		expect(intent.segments).toHaveLength(1);
		expect(intent.via).toBe("none");
	});
	it("`via` names the first OUTBOUND segment, not a loopback one before it", () => {
		const intent = intentOf('curl http://127.0.0.1/ ; python3 -c "import requests; requests.get(u)"');
		expect(intent.segments).toHaveLength(2);
		expect(intent.via).toBe("interpreter-api");
	});
	it("`hosts` lists outbound hosts once each and leaves out loopback peers", () => {
		const intent = intentOf("curl http://127.0.0.1/ ; curl https://example.com; curl https://example.com");
		expect(intent.hosts).toEqual(["example.com"]);
	});
	it("a Unix-socket peer is local, so it is never external whatever the URL says (line 49)", () => {
		const intent = intentOf("curl --unix-socket /tmp/s http://example.com/x");
		expect(intent.segments).toHaveLength(1);
		expect(intent.segments[0]?.outbound).toBe(false);
		expect(isExternalNetworkIntent(intent)).toBe(false);
	});
	it("leg 2 counts only FETCHES from a public host, not a session to one (line 383)", () => {
		expect(fetchesPublicContent(intentOf("ssh deploy@203.0.113.9 uptime"))).toBe(false);
		expect(fetchesPublicContent(intentOf("npm publish"))).toBe(false);
		expect(fetchesPublicContent(intentOf("curl https://example.com/page"))).toBe(true);
	});
});
