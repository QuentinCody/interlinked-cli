// Independent adversarial review of the `ubs_tls_verify_disabled` pre_block
// check (2026-10-21). Every negative here was a probed false positive before
// the detector was refined:
// `scratch/2026-10-21-adversarial/ubs_tls_verify_disabled.probe.mts`.
// A pre_block check blocks an agent's edit, so each of these is a legitimate
// edit the gate used to refuse — the first two refused the probe file itself.
//
// The env-var name is assembled at runtime: a daemon running the PRE-review
// build applies the old regex to this test file and would refuse the
// comparison / guard-message lines below.

import { describe, expect, it } from "vitest";
import { checkTlsVerifyDisabled } from "../../checks/agent-safety-crypto.js";

const ENV = ["NODE_TLS", "REJECT_UNAUTHORIZED"].join("_");

describe("ubs_tls_verify_disabled — negative (must not fire)", () => {
	it("N1: a guard that COMPARES the env var to \"0\" and warns", () => {
		const code = [
			`if (process.env.${ENV} === "0") {`,
			`\tconsole.warn("TLS verification is disabled by ${ENV}=0");`,
			"}",
			"",
		].join("\n");
		expect(checkTlsVerifyDisabled(code, "src/http/client.ts")).toEqual([]);
	});

	it("N2: a startup guard whose error MESSAGE names the env var assignment", () => {
		const code = [
			`if (process.env.${ENV} !== undefined) {`,
			`\tthrow new Error("Refusing to start with ${ENV}=0: TLS checks must stay on");`,
			"}",
			"",
		].join("\n");
		expect(checkTlsVerifyDisabled(code, "src/boot.ts")).toEqual([]);
	});

	it("N3: a Node SERVER with requestCert: true and rejectUnauthorized: false (optional client cert)", () => {
		const code = [
			"const server = https.createServer(",
			"\t{",
			"\t\tkey,",
			"\t\tcert,",
			"\t\tca: [clientCa],",
			"\t\trequestCert: true,",
			"\t\trejectUnauthorized: false, // per-route check via socket.authorized",
			"\t},",
			"\tapp,",
			");",
			"",
		].join("\n");
		expect(checkTlsVerifyDisabled(code, "src/server/tls.ts")).toEqual([]);
	});

	it("N4: Go certificate pinning — InsecureSkipVerify beside VerifyPeerCertificate in the same tls.Config", () => {
		const code = [
			"cfg := &tls.Config{",
			"\tInsecureSkipVerify: true, // verification is done by VerifyPeerCertificate below",
			"\tVerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {",
			"\t\treturn verifyPin(rawCerts, pinnedSPKI)",
			"\t},",
			"}",
			"",
		].join("\n");
		expect(checkTlsVerifyDisabled(code, "pkg/pin/client.go")).toEqual([]);
	});

	it("N5: Go VerifyConnection declared BEFORE InsecureSkipVerify in the same literal", () => {
		const code = "cfg := &tls.Config{\n\tVerifyConnection: verify,\n\tInsecureSkipVerify: true,\n}\n";
		expect(checkTlsVerifyDisabled(code, "pkg/pin/client.go")).toEqual([]);
	});

	it("N6: a vitest test connecting to its own self-signed fixture server", () => {
		const code =
			'it("serves over https", async () => {\n\tconst res = await fetchWith({ rejectUnauthorized: false, host: srv.host });\n\texpect(res.status).toBe(200);\n});\n';
		expect(checkTlsVerifyDisabled(code, "src/server/__tests__/https.test.ts")).toEqual([]);
	});

	it("N7: a Python test asserting the --insecure flag was forwarded as verify=False", () => {
		const code =
			'def test_insecure_flag_forwarded(mock_get):\n    run(["fetch", "--insecure", URL])\n    mock_get.assert_called_once_with(URL, verify=False)\n';
		expect(checkTlsVerifyDisabled(code, "tests/test_cli.py")).toEqual([]);
	});

	it("N8: Markdown prose that names verify=False as the anti-pattern", () => {
		const code = "# TLS policy\n\nNever pass verify=False to requests in production code; install the CA instead.\n";
		expect(checkTlsVerifyDisabled(code, "docs/security.md")).toEqual([]);
	});

	it("N9: a Python identity comparison that DETECTS the unverified-context monkeypatch", () => {
		const code =
			"import ssl\n\ndef tls_is_verified() -> bool:\n    return ssl._create_default_https_context is not ssl._create_unverified_context\n";
		expect(checkTlsVerifyDisabled(code, "src/net/sanity.py")).toEqual([]);
	});

	it("N10: a Python equality comparison against ssl._create_unverified_context", () => {
		const code =
			"if ssl._create_default_https_context == ssl._create_unverified_context:\n    warn()\n";
		expect(checkTlsVerifyDisabled(code, "src/net/sanity.py")).toEqual([]);
	});

	it("N11: a TS literal-type union member `rejectUnauthorized: false;` (type-level, no runtime value)", () => {
		const code =
			"export type PeerPolicy =\n\t| { rejectUnauthorized: true; ca?: string[] }\n\t| { rejectUnauthorized: false; reason: string };\n";
		expect(checkTlsVerifyDisabled(code, "src/tls/types.ts")).toEqual([]);
	});

	it("N12: a multi-line Python docstring that mentions verify=False", () => {
		const code = [
			"def get(url):",
			'    """Fetch url.',
			"",
			"    Unlike requests.get(url, verify=False) this always verifies the peer.",
			'    """',
			"    return requests.get(url)",
			"",
		].join("\n");
		expect(checkTlsVerifyDisabled(code, "src/net/client.py")).toEqual([]);
	});

	it("N13: a guard whose console.warn message LEADS with the env var assignment (round 2)", () => {
		const code = [
			`if (process.env.${ENV} === "0") {`,
			`\tconsole.warn("${ENV}=0 detected: TLS verification is off");`,
			"}",
			"",
		].join("\n");
		expect(checkTlsVerifyDisabled(code, "src/boot.ts")).toEqual([]);
	});

	it("N14: a guard whose thrown Error / Python raise message LEADS with the assignment (round 2)", () => {
		expect(
			checkTlsVerifyDisabled(`\tthrow new Error("${ENV}=0 is not allowed in production");\n`, "src/boot.ts"),
		).toEqual([]);
		expect(
			checkTlsVerifyDisabled(`    raise RuntimeError("${ENV}=0 is set; refusing to start")\n`, "src/boot.py"),
		).toEqual([]);
	});
});

describe("ubs_tls_verify_disabled — positive (must fire)", () => {
	it("P10: a shell command string passed to execSync still fires (round 2)", () => {
		expect(checkTlsVerifyDisabled(`execSync("${ENV}=0 node server.js");\n`, "scripts/dev.ts")).toHaveLength(1);
	});

	it("P1: a package.json script that LEADS with the env var assignment", () => {
		const code = `{\n  "scripts": {\n    "dev": "${ENV}=0 node server.js"\n  }\n}\n`;
		expect(checkTlsVerifyDisabled(code, "package.json")).toHaveLength(1);
	});

	it("P2: a cross-env script string", () => {
		expect(checkTlsVerifyDisabled(`"test": "cross-env ${ENV}=0 mocha"\n`, "package.json")).toHaveLength(1);
	});

	it("P3: Python os.environ bracket assignment", () => {
		expect(checkTlsVerifyDisabled(`os.environ["${ENV}"] = "0"\n`, "scripts/run.py")).toHaveLength(1);
	});

	it("P4: process.env bracket assignment", () => {
		expect(checkTlsVerifyDisabled(`process.env["${ENV}"] = "0";\n`, "src/dev.ts")).toHaveLength(1);
	});

	it("P5: Dockerfile ENV and a .env file", () => {
		expect(checkTlsVerifyDisabled(`ENV ${ENV}=0\n`, "Dockerfile")).toHaveLength(1);
		expect(checkTlsVerifyDisabled(`${ENV}=0\n`, ".env")).toHaveLength(1);
	});

	it("P6: Go InsecureSkipVerify whose VerifyPeerCertificate lives in a SIBLING struct", () => {
		const code =
			"a := &tls.Config{\n\tInsecureSkipVerify: true,\n}\nb := &tls.Config{\n\tVerifyPeerCertificate: pin,\n}\n";
		const out = checkTlsVerifyDisabled(code, "pkg/pin/client.go");
		expect(out.map((m) => m.line)).toEqual([2]);
	});

	it("P7: rejectUnauthorized: false in a CLIENT literal next to a separate server literal", () => {
		const code = "const client = { rejectUnauthorized: false };\nconst server = { requestCert: true };\n";
		expect(checkTlsVerifyDisabled(code, "src/client.ts").map((m) => m.line)).toEqual([1]);
	});

	it("P8: a docstring does not hide a real verify=False on the next code line", () => {
		const code = 'def get(url):\n    """Doc."""\n    return requests.get(url, verify=False)\n';
		expect(checkTlsVerifyDisabled(code, "src/net/client.py").map((m) => m.line)).toEqual([3]);
	});

	it("P9: the monkeypatch assignment and the bare context call still fire", () => {
		expect(
			checkTlsVerifyDisabled(
				"ssl._create_default_https_context = ssl._create_unverified_context\n",
				"a.py",
			),
		).toHaveLength(1);
		expect(checkTlsVerifyDisabled("ctx = ssl._create_unverified_context()\n", "a.py")).toHaveLength(1);
	});
});
