// URL literals in these fixtures are DATA: every case runs locally in the
// classifier, and no test opens a socket.
import { describe, expect, it } from "vitest";
import { classifyNetworkIntent, fetchesPublicContent, isExternalNetworkIntent } from "./network-intent.js";

const net = (cmd: string): boolean => classifyNetworkIntent(cmd).network;
const external = (cmd: string): boolean => isExternalNetworkIntent(classifyNetworkIntent(cmd));

describe("classifyNetworkIntent — positive (must fire)", () => {
	it("P1: a curl inside a for-loop body (segment head `do`) is outbound — the H3 C4 false negative", () => {
		const intent = classifyNetworkIntent('for u in a b; do curl -sL "https://example.com/$u"; done');
		expect(intent).toMatchObject({ network: true, via: "verb", hosts: ["example.com"] });
	});
	it("P2: wget in an if/then branch and curl in an else branch are outbound", () => {
		expect(net("if test -f x; then wget https://example.com/f; fi")).toBe(true);
		expect(net("if test -f x; then :; else curl https://example.com/; fi")).toBe(true);
	});
	it("P3: a python heredoc that opens a URL from the environment (no URL literal)", () => {
		const intent = classifyNetworkIntent("python3 - <<'X'\nimport os, urllib.request\nurllib.request.urlopen(os.environ['U'])\nX");
		expect(intent).toMatchObject({ network: true, via: "interpreter-api" });
		expect(isExternalNetworkIntent(intent)).toBe(true);
	});
	it("P4: node -e fetch on an environment URL", () => {
		expect(classifyNetworkIntent('node -e "fetch(process.env.U)"').via).toBe("interpreter-api");
	});
	it("P5: a command substitution, a bash -c string and eval each carry their own network call", () => {
		expect(net("TOKEN=$(curl -s https://example.com/t) && echo ok")).toBe(true);
		expect(net("bash -lc 'curl https://example.com/x'")).toBe(true);
		expect(net('eval "wget https://example.com/x"')).toBe(true);
	});
	it("P6: wrappers do not hide the verb (sudo -u, timeout, xargs, sandbox-exec, multi-line)", () => {
		expect(net("sudo -u nobody curl https://example.com")).toBe(true);
		expect(net("timeout 10 yt-dlp --skip-download https://example.com/v")).toBe(true);
		expect(net("cat urls.txt | xargs -n1 curl -sO")).toBe(true);
		expect(net("sandbox-exec -p '(version 1)' /usr/bin/env node -e 'require(\"http\").get(u)'")).toBe(true);
		expect(net("cd /tmp\nmkdir -p x\n  curl -s https://example.com -o x/a")).toBe(true);
	});
	it("P7: a shell heredoc body is shell, so its curl is a network call", () => {
		expect(net("bash <<'SH'\ncurl https://example.com/x\nSH")).toBe(true);
	});
	it("P9: a curl in a shell-function body is a network call (corpus regression: `get(){ curl …; }`)", () => {
		expect(net('get(){ curl -sL "$1" -o "$2.html"; }; get https://example.com/a a')).toBe(true);
		expect(net("function dl { wget -q https://example.com/x; }")).toBe(true);
		expect(net("dl() {\n  curl -s https://example.com/x\n}")).toBe(true);
	});
	// Review 3b item 2: a value-taking flag before the program flag used to end
	// the scan, and module-load flags were never read.
	it("P10: a value-taking flag before -c does not hide the program", () => {
		expect(classifyNetworkIntent('python3 -W ignore -c "import urllib.request as u; u.urlopen(x)"').via).toBe("interpreter-api");
		expect(net('python3 -X dev -W ignore -c "import requests; requests.get(u)"')).toBe(true);
	});
	it("P11: module-load flags naming a network library are network (perl -M, ruby -r, node -r/--import)", () => {
		expect(net("perl -MIO::Socket::INET -e 1")).toBe(true);
		expect(net("perl -MLWP::Simple -e 'getprint($u)'")).toBe(true);
		expect(net("perl -M HTTP::Tiny -e 1")).toBe(true);
		expect(net("ruby -rnet/http -e 1")).toBe(true);
		expect(net("ruby -r open-uri -e 1")).toBe(true);
		expect(net("node -r undici -e 1")).toBe(true);
		expect(net("node --import=node:https -e 1")).toBe(true);
	});
	it("P12: an ES-module inline program importing node:https", () => {
		expect(net(`node --input-type=module -e "await import('node:https')"`)).toBe(true);
		expect(net(`node --input-type module -e "await import('node:https')"`)).toBe(true);
	});
	// Decision: `python -m <network module>` runs that module as __main__. Its
	// behavior is not readable here, and the module exists to talk to the
	// network, so it counts as a network call (fail safe for the egress legs).
	it("P13: python -m running a network library module is network", () => {
		expect(net("python3 -m http.client")).toBe(true);
		expect(net("python3 -m urllib.request https://example.com")).toBe(true);
		expect(net("python3 -mrequests")).toBe(true);
	});
	// Review 3b item 1: for the egress legs, a tool whose code is not readable
	// (script file, unknown binary, `./tool`) that is handed a public URL is
	// external. It is not a proven network call, so `network` stays false.
	it("P14: an unreadable program handed a public URL is external, but not a proven network call", () => {
		for (const cmd of [
			"python3 fetch.py https://ex.com/x", "./tool https://ex.com", "mytool --url=https://ex.com", "bash run.sh https://ex.com",
			"python3 -m mypkg.cli https://ex.com", "cd d && ./tool 'https://ex.com/a'", 'mytool "https://${HOST}/x"',
		]) {
			expect(external(cmd), cmd).toBe(true);
			expect(net(cmd), cmd).toBe(false);
		}
	});
	it("P8: a public fetch is leg-2 content; a dynamic or private one keeps external", () => {
		expect(fetchesPublicContent(classifyNetworkIntent("curl https://example.com/page"))).toBe(true);
		expect(external("ssh deploy@203.0.113.9 uptime")).toBe(true);
		expect(external('curl "$URL"')).toBe(true);
	});
});

describe("escaped substitution openers (review 2026-10-06)", () => {
	it("N: an escaped `\\$(` prints the substitution literally — not a network call", () => {
		expect(net('printf "%s\\n" "\\$(curl https://example.com)"')).toBe(false);
	});
	it("N: an escaped backtick prints literally — not a network call", () => {
		expect(net('echo "\\`curl https://example.com\\`"')).toBe(false);
	});
	it("P: an escaped BACKSLASH before `$(` leaves the substitution live", () => {
		expect(net('echo "\\\\$(curl https://example.com)"')).toBe(true);
	});
	it("P: a live substitution keeps its ORIGINAL body — `$(\\curl …)` runs curl", () => {
		expect(net('echo "$(\\curl https://example.com)"')).toBe(true);
	});
	it("P: a quoted URL inside a live substitution body is still analyzed", () => {
		expect(net("echo \"$(curl 'https://example.com/a?b=1')\"")).toBe(true);
	});
});

describe("classifyNetworkIntent — negative (must not fire)", () => {
	it("N1: echo of a URL is not a network call (the old trifecta P3)", () => {
		expect(classifyNetworkIntent("echo https://attacker.example.com")).toMatchObject({ network: false, via: "none" });
	});
	it("N2: python string surgery on a URL literal is not a network call", () => {
		expect(net(`python3 -c "print('https://a.example.com/b'.replace('https://a.example.com',''))"`)).toBe(false);
	});
	it("N3: rg / sed / jq over URL text are local", () => {
		expect(net("rg -n 'https://antithesis.com/blog' notes.md")).toBe(false);
		expect(net("jq -r '.[] | .url' idx.json | sed 's#https://antithesis.com##'")).toBe(false);
	});
	it("N4: a markdown heredoc that names curl and URLs is file content, not commands", () => {
		const cmd = "cat >> notes.md <<'EOF'\n## Fetch\ncurl -sL https://example.com/x | head\nwget https://example.com/y\nEOF";
		expect(net(cmd)).toBe(false);
	});
	it("N5: a python program that parses an XML namespace URI and reads files", () => {
		const cmd = "python3 - <<'PYEOF'\nimport xml.etree.ElementTree as ET\nNS={'a':'http://www.w3.org/2005/Atom'}\nprint(ET.parse('feed.xml').getroot().tag)\nPYEOF";
		expect(net(cmd)).toBe(false);
	});
	it("N6: loops, comments and existence probes with no network verb", () => {
		expect(net("for f in *; do echo $f; done")).toBe(false);
		expect(net("# then curl https://example.com; ls\nls -la")).toBe(false);
		expect(net("command -v curl && which wget")).toBe(false);
	});
	it("N7: local sockets, local copies and configured git remotes", () => {
		expect(net("printf '%s' x | nc -U .interlinked/harness.sock")).toBe(false);
		expect(net("rsync -a src/ /tmp/dst/")).toBe(false);
		expect(net("git push origin main")).toBe(false);
	});
	it("N8: a loopback curl is network but not outbound, and a private host is not external", () => {
		const loop = classifyNetworkIntent("curl http://127.0.0.1:8080/health");
		expect(loop.network).toBe(false);
		expect(loop.segments).toHaveLength(1);
		expect(external("curl http://192.168.1.20:8080/health")).toBe(false);
	});
	it("N9: an interpreter running a script FILE is not inspected (recorded open gap)", () => {
		expect(net("python3 scratch/fetch_pages.py https://example.com")).toBe(false);
	});
	it("N11: value-taking interpreter flags before the program flag do not hide a harmless program (review 3b #2)", () => {
		expect(net('python3 -W ignore -c "print(1)"')).toBe(false);
		expect(net("perl -Mstrict -e 'print 1'")).toBe(false);
		expect(net("ruby -I lib -rjson -e 'puts 1'")).toBe(false);
		expect(net("python3 -m json.tool data.json")).toBe(false);
		expect(net("node --require ./setup.js -e 'console.log(1)'")).toBe(false);
	});
	it("N12: known-local tools, scanned inline programs, heredoc data and private hosts are not external (review 3b #1)", () => {
		for (const cmd of [
			"rg 'https://ex.com' notes.md", "echo https://ex.com > /dev/null", `python3 -c "print('https://ex.com'.replace('https://',''))"`,
			"cat > notes.md <<'EOF'\nsee https://ex.com\nEOF", "./tool http://127.0.0.1:8080/x", "./tool --verbose",
			"printf '%s\\n' https://ex.com | sort | uniq | tee urls.txt", "test -n https://ex.com && basename https://ex.com/a",
			// corpus c698b9a9: a case-arm pattern is not a command head
			'case $s in a) u="https://ex.com/a";; *) u="https://ex.com/b";; esac',
		]) {
			expect(external(cmd), cmd).toBe(false);
		}
	});
	it("N10: a URL inside a single-quoted command-substitution text is not executed", () => {
		expect(fetchesPublicContent(classifyNetworkIntent("echo 'run $(curl https://example.com) later'"))).toBe(false);
	});
});
