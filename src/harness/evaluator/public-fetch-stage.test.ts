import { describe, expect, it } from "vitest";
import { shellSplit } from "../shell-structure.js";
import { fetchTargetsOf, isPublicUrl, publicFetchOf } from "./public-fetch-stage.js";

const fetchOf = (cmd: string) => publicFetchOf(cmd, shellSplit(cmd));
const targetsOf = (cmd: string) => fetchTargetsOf(shellSplit(cmd));

describe("isPublicUrl", () => {
	it("P1: public http(s) hosts", () => {
		expect(["https://www.youtube.com/watch?v=x", "http://example.com:8080/a", "https://8.8.8.8/"].map(isPublicUrl)).toEqual([true, true, true]);
	});

	it("N1: loopback, private, single-label, internal suffix, userinfo, non-http, keyed query", () => {
		const urls = [
			"http://localhost:3000/", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.1.4/", "http://172.20.0.1/",
			"http://[::1]/", "http://intranet/", "https://svc.internal/x", "https://printer.local/", "https://u:p@example.com/",
			"file:///etc/hosts", "ftp://example.com/x", "https://api.example.com/v?api_key=1", "https://example.com/?access_token=z",
			"https://$HOST/x",
		];
		expect(urls.filter(isPublicUrl)).toEqual([]);
	});

	// Review 3b item 3: the host is parsed canonically, every IPv4 form libc
	// accepts included, so a short or encoded loopback is never "public".
	it("N1b: encoded IPv4 loopback/private/special forms and non-public IPv6 are not public", () => {
		const urls = [
			"http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://0x7f.1/",
			"http://0.0.0.0/", "http://0/", "http://224.0.0.1/", "http://255.255.255.255/", "http://100.64.1.1/",
			"http://169.254.169.254/latest", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
			"http://[fe80::1]/", "http://[fd12:3456::1]/", "http://[::]/", "http://[ff02::1]/",
			"http://foo.localhost/", "http://svc.lan/", "http://nas.home.arpa/", "http://localhost./",
		];
		expect(urls.filter(isPublicUrl)).toEqual([]);
	});

	it("N1c: numeric-looking hosts that do not parse are not public (fail safe)", () => {
		expect(["http://999.1.1.1/", "http://1.2.3.4.5/", "http://0x1g.2/", "http://08.1.1.1/"].filter(isPublicUrl)).toEqual([]);
	});

	it("P1b: public IPv4 in short/decimal form, public IPv6 and a trailing-dot name are public", () => {
		const urls = ["http://134744072/", "http://8.8.8.8/", "https://[2606:4700:4700::1111]/dns", "https://example.com./x"];
		expect(urls.map(isPublicUrl)).toEqual([true, true, true, true]);
	});
});

describe("fetchTargetsOf — positive (targets found)", () => {
	it("P2: curl -o, --output=, clustered -sLo, attached -oFILE", () => {
		expect(targetsOf("curl -sLo a.html https://e.com/")?.targets).toEqual(["a.html"]);
		expect(targetsOf("curl --output=b.html https://e.com/")?.targets).toEqual(["b.html"]);
		expect(targetsOf("curl -oc.html https://e.com/")?.targets).toEqual(["c.html"]);
	});

	it("P3: curl -O / --remote-name with one URL uses its last path segment; --output-dir prefixes", () => {
		expect(targetsOf("curl -sLO https://e.com/a/page.html")?.targets).toEqual(["page.html"]);
		expect(targetsOf("curl --output-dir d --remote-name https://e.com/p.js")?.targets).toEqual(["d/p.js"]);
	});

	it("P4: wget -O, --output-document=, default basename (index.html for a bare host), -P prefix", () => {
		expect(targetsOf("wget -qO x.html https://e.com/")?.targets).toEqual(["x.html"]);
		expect(targetsOf("wget --output-document=y.html https://e.com/")?.targets).toEqual(["y.html"]);
		expect(targetsOf("wget https://e.com/s/bundle.js")?.targets).toEqual(["bundle.js"]);
		expect(targetsOf("wget -P dl https://e.com/")?.targets).toEqual(["dl/index.html"]);
	});

	it("P5: yt-dlp -o literal; stdout when no output file is named", () => {
		expect(targetsOf("yt-dlp -o meta.json https://www.youtube.com/watch?v=x")?.targets).toEqual(["meta.json"]);
		expect(targetsOf("curl -s https://e.com/")).toMatchObject({ targets: [], stdout: true, ok: true });
	});
});

describe("fetchTargetsOf — negative (unknown file set ⇒ ok=false, or not a fetch)", () => {
	it("N2: server-chosen, recursive, resuming, no-clobber and templated names are not modeled", () => {
		for (const cmd of [
			"curl -OJ https://e.com/dl", "curl -O https://e.com/a https://e.com/b", "curl -C - -o a https://e.com/",
			"wget -r https://e.com/", "wget -nc https://e.com/a.js", "wget -N https://e.com/a.js", "wget -c https://e.com/a.js",
			"wget https://e.com/a https://e.com/b", "wget https://e.com/watch?v=x", "curl -O https://e.com/p.html?x=1", "yt-dlp -o '%(id)s.json' https://www.youtube.com/watch?v=x",
			"curl -o a -o b https://e.com/x https://e.com/y https://e.com/z",
		]) {
			expect(targetsOf(cmd)?.ok, cmd).toBe(false);
		}
	});

	it("N3: a head that is not a fetch tool returns null", () => {
		expect(targetsOf("rg -o x yt.html")).toBeNull();
	});
});

describe("publicFetchOf — positive (public, unauthenticated fetch)", () => {
	it("P6: curl to a public URL; consumed lists the output tokens", () => {
		expect(fetchOf("curl -sL -o yt.html https://www.youtube.com/watch?v=x")).toEqual({
			url: "https://www.youtube.com/watch?v=x",
			targets: ["yt.html"],
			consumed: ["yt.html"],
			stdout: false,
		});
	});

	it("P7: yt-dlp with a public URL and harmless headers on curl", () => {
		expect(fetchOf("yt-dlp --skip-download https://www.youtube.com/watch?v=x")?.url).toBe("https://www.youtube.com/watch?v=x");
		expect(fetchOf('curl -s -H "Accept: text/markdown" https://e.com/')?.stdout).toBe(true);
	});
});

describe("publicFetchOf — negative (auth, local, dynamic, or not public)", () => {
	it("N4: authentication and credential-loading flags", () => {
		for (const cmd of [
			'curl -H "Authorization: Bearer t" https://e.com/', "curl -u me:pw https://e.com/", "curl -sSLu me:pw https://e.com/",
			"curl -b cookies.txt https://e.com/", "curl --netrc https://e.com/", "curl -K cfg https://e.com/",
			"wget --header=Cookie:a=b https://e.com/", "wget --user=me https://e.com/", "wget -e robots=off https://e.com/",
			"wget -i urls.txt", "yt-dlp --cookies-from-browser chrome https://www.youtube.com/watch?v=x",
			"yt-dlp --exec 'cat x' https://www.youtube.com/watch?v=x",
		]) {
			expect(fetchOf(cmd), cmd).toBeNull();
		}
	});

	// Review 3b item 3: each flag below changes the peer, reads local
	// credentials, or reads request data from a local file.
	it("N4b: peer-rewriting, credential and local-file options; non-http schemes", () => {
		for (const cmd of [
			"curl --unix-socket /tmp/s https://e.com/", "curl --unix-socket=/tmp/s https://e.com/",
			"curl --abstract-unix-socket x https://e.com/", "curl --resolve e.com:443:127.0.0.1 https://e.com/",
			"curl --connect-to e.com:443:10.0.0.1:443 https://e.com/", "curl --config=cfg https://e.com/",
			"curl --netrc-file n https://e.com/", "curl --netrc-optional https://e.com/", "curl --user=a:b https://e.com/",
			"curl https://u:p@e.com/", "curl -H @headers.txt https://e.com/", "curl --header=@h.txt https://e.com/",
			"curl -H 'Cookie: a=b' https://e.com/", "curl --cookie=a=b https://e.com/", "curl --cert c.pem https://e.com/",
			"curl --key k.pem https://e.com/", "curl dict://e.com/d:x", "curl gopher://e.com/x", "curl scp://e.com/x",
			"curl sftp://e.com/x", "curl ftp://e.com/x", "curl file:///etc/hosts", "wget --post-file=f https://e.com/",
		]) {
			expect(fetchOf(cmd), cmd).toBeNull();
		}
	});

	it("N5: loopback, scheme-less, variable URL, and non-fetch heads", () => {
		for (const cmd of ["curl http://localhost:8080/", "curl example.com", "curl https://$HOST/x", "ssh host cat x", "rg x f"]) {
			expect(fetchOf(cmd), cmd).toBeNull();
		}
	});
});
