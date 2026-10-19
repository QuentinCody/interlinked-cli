// U1 review (2026-10-09) and U1s audit: the ±150-char E19 context around a
// signature hit carried NEIGHBOURING credentials raw (no signature matched
// them, and they sat under the 24-char high-entropy floor). The hook-path
// shadow masks them before the state is sent. One positive test per leak class
// the U1s audit found (scratch/2026-10-08-decisions-orthogonal/u1-audit/:
// 68 of 83 adversarial fixtures and 81 of 218 edge-sweep variants leaked
// before the fix). Every credential below is assembled at runtime, so no
// literal credential sits in this source.
import { describe, expect, it } from "vitest";
import { scanSecrets } from "../signatures.js";
import { firstSecretMatch, maskCredentialAssignments, maskedSecretContext } from "./decision-shadow-redact.js";
import { buildSecretHitState } from "./secret-shadow.js";

const OPENAI_LIKE = `sk-${"Q1w2E3r4T5y6U7i8"}${"O9p0A1s2D3f4G5h6"}`;
const AWS_TEMP_ID = `AS${"IA"}${"Q7RZM2PXK9TWV4BD"}`;
const PEM = (edge: string): string => `-----${edge} ${"RSA"} PRIVATE KEY-----`;
const url = (scheme: string, user: string, pw: string, host: string): string => `${scheme}://${user}:${pw}@${host}`;
const b64 = (s: string): string => Buffer.from(s).toString("base64");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** A deterministic high-entropy token (masked by the E19 ≥24-char rule). */
const mix = (n: number, seed: number): string => Array.from({ length: n }, (_, i) => ALNUM[(i * 7919 + seed * 31) % ALNUM.length]).join("");

/** The JSON state a shadow request would carry, for every rule the scan reports. */
function sentStates(text: string): string[] {
	const ids = [...new Set(scanSecrets(text).map((m) => m.rule_id))];
	expect(ids.length).toBeGreaterThan(0);
	return ids.map((id) => JSON.stringify(buildSecretHitState(text, [id], "tool_output")));
}
/** Neither the value nor, for a value under 12 characters, its first 4 characters. */
function expectAbsent(out: string, ...values: string[]): void {
	for (const v of values) {
		expect(out).not.toContain(v);
		if (v.length < 12) expect(out).not.toContain(v.slice(0, 4));
	}
}

describe("maskCredentialAssignments — positive (must mask)", () => {
	it("P1: a value under 12 characters keeps no character", () => {
		expect(maskCredentialAssignments('ADMIN_PW="letmein42" SMTP_PASSWORD="mailpass77"')).toBe('ADMIN_PW="…" SMTP_PASSWORD="…"');
	});
	it("P2: JSON and YAML credential keys are masked", () => {
		const out = maskCredentialAssignments('{"apiKey": "short-key-9", "client_secret": "s3cretval"} token: abcd1234');
		expectAbsent(out, "short-key-9", "s3cretval", "abcd1234");
	});
	it("P3: the live state for a .env write carries no neighbouring password", () => {
		const text = `DATABASE_URL="${url("postgres", "app", "Hunter2Pass", "db.internal:5432/app")}"\nSMTP_PASSWORD="mailpass77"\nADMIN_PW="letmein42"\n`;
		const st = buildSecretHitState(text, scanSecrets(text).map((m) => m.rule_id), "src_code");
		expect(st).not.toBeNull();
		const sent = JSON.stringify(st);
		expectAbsent(sent, "Hunter2Pass", "mailpass77", "letmein42");
		expect(sent).toContain("⟦");
	});
	it("P4: a value no longer swallows the next key (`env: KEY: v`, base64 `=` padding, `$env:`)", () => {
		const out = maskCredentialAssignments(`environment: POSTGRES_PASSWORD: C0mposePw data: username: ${b64("admin")} password: ${b64("K8sPw!93")} PS> $env:API_TOKEN="t0k3n-abc12"`);
		expectAbsent(out, "C0mposePw", b64("K8sPw!93"), "t0k3n-abc12");
		expect(out).toContain(`username: ${b64("admin")}`);
	});
	it("P5: a key removed by the ±150 cut no longer leaves its value raw", () => {
		for (let pad = 100; pad <= 170; pad++) {
			const text = `DB_PASSWORD=Sup3rS3cretValue9x\n${"x ".repeat(pad).slice(0, pad)}\nOPENAI_API_KEY=${OPENAI_LIKE}`;
			for (const sent of sentStates(text)) expect(sent).not.toMatch(/S3cretValue|p3rS3c/);
		}
	});
	it("P6: a line split by the raw ±550 window edge is masked whole", () => {
		const blob = mix(500, 3);
		for (let pad = 0; pad <= 34; pad++) {
			const text = `${"lorem ipsum ".repeat(25)}\nMY_PASSWORD=WinEdgePw9${" ".repeat(pad)}\nBLOB=${blob}\nOPENAI_API_KEY=${OPENAI_LIKE}`;
			for (const sent of sentStates(text)) expect(sent).not.toMatch(/WinE|dgePw9|EdgeP/);
		}
	});
	it("P7: `*_KEY`, `*Key` and `*.key` names are credential names", () => {
		const out = maskCredentialAssignments("ENCRYPTION_KEY=6f1c2a9e0b3d7c4a SIGNING_KEY=dyWAHq6Cvq5vPr1xbNHA masterKey: KEZAS6ULPfB2Di tls.key=Zk3x9QpL0mV7");
		expectAbsent(out, "6f1c2a9e0b3d7c4a", "dyWAHq6Cvq5vPr1xbNHA", "KEZAS6ULPfB2Di", "Zk3x9QpL0mV7");
	});
	it("P8: a quoted value is masked to its closing quote (spaces, `;`, `,`)", () => {
		const out = maskCredentialAssignments(`DB_PASS='p4ss w0rd!x' SMTP_PASS='mail;pass,77' password = "T0ml Pass;1"`);
		expect(out).not.toMatch(/w0rd|pass,77|Pass;1|p4ss|T0ml/);
	});
	it("P9: Makefile `:=` and `?=` assignments are masked", () => {
		expectAbsent(maskCredentialAssignments("DB_PASSWORD := MakePw!9x\nAPI_TOKEN ?= mk-WjRiW00vNcMS"), "MakePw!9x", "mk-WjRiW00vNcMS");
	});
	it("P10: the value of a name/value pair whose name is a credential is masked", () => {
		const out = maskCredentialAssignments(
			[
				"- name: DB_PASSWORD",
				'  value: "N4meVal!x"',
				JSON.stringify({ Name: "/prod/db/password", Type: "SecureString", Value: "Ssm!Pa55w" }),
				'<add key="DbPassword" value="NetCfgPw!9" />',
				JSON.stringify({ db_password: { sensitive: true, type: "string", value: "TfOutPw!9" } }),
			].join("\n"),
		);
		expectAbsent(out, "N4meVal!x", "Ssm!Pa55w", "NetCfgPw!9", "TfOutPw!9");
	});
	it("P11: YAML block scalars, heredocs and triple-quoted values are masked", () => {
		const out = maskCredentialAssignments(
			["password: |-", "    BlockPw!93", "  next: 1", "password = <<-EOT", "    H3red0cPw!", "  EOT", 'API_SECRET = """', "TripleQ!Pw9", '"""', "unseal_key: >-", "    Fold3dKey", "    PartTwo99"].join("\n"),
		);
		expectAbsent(out, "BlockPw!93", "H3red0cPw!", "TripleQ!Pw9", "Fold3dKey", "PartTwo99");
	});
	it("P12: an escaped JSON string (`\\\"password\\\":\\\"…\\\"`) is masked", () => {
		const out = maskCredentialAssignments(JSON.stringify({ SecretString: JSON.stringify({ username: "admin", password: "Esc4ped!Pw" }) }));
		expectAbsent(out, "Esc4ped!Pw");
	});
	it("P13: URL userinfo is masked for every scheme, and a token-only userinfo too", () => {
		const out = maskCredentialAssignments(
			[url("redis", "default", "R3dPw!x9", "cache:6379"), url("amqp", "rabbit", "Rabb1tPw", "mq"), url("postgresql+psycopg2", "app", "Alch3myPw", "db/app"), url("rediss", "", "R3disTls9", "ec2:6380"), "https://ROGLO3qBL5DitkcAdyWO@code.example.org/r.git"].join("\n"),
		);
		expectAbsent(out, "R3dPw!x9", "Rabb1tPw", "Alch3myPw", "R3disTls9", "ROGLO3qBL5DitkcAdyWO");
		expect(out).toContain("redis://default:…@cache");
	});
	it("P14: an auth header keeps its scheme word and masks the credential after it", () => {
		const out = maskCredentialAssignments(`-H "Authorization: Basic ${b64("admin:BasicPw!9")}" -H "Authorization: Bearer gpztVQjj7SNrSGrw" -H "X-API-Key: k3y-a1b2c3"`);
		expectAbsent(out, b64("admin:BasicPw!9"), "gpztVQjj7SNrSGrw", "k3y-a1b2c3");
		expect(out).toContain('"Authorization: Basic ');
	});
	it("P15: CLI credentials are masked (curl -u / --user, --password, mysql -p, docker login, sshpass, htpasswd, net use)", () => {
		const out = maskCredentialAssignments(
			[
				"curl -u deploy:CurlPw!93 https://ci.example.com",
				"curl --user 'admin:p4ss w0rd!' https://h.example.com",
				"./deploy --password Fl4gPw!x --api-token tok_bTUIEO2O9H --region us-east-1",
				"mysql -h db -uroot -pMyR00tPw! app",
				"docker login -u deployer -p D0ckerPw! registry.example.com",
				"sshpass -p 'Sshp4ss!' ssh deploy@10.0.0.5",
				"htpasswd -b .htpasswd admin Htp4ss!x",
				"net use \\\\fs\\share /user:ACME\\svc N3tUs3Pw!",
			].join("\n"),
		);
		expectAbsent(out, "CurlPw!93", "p4ss w0rd!", "Fl4gPw!x", "tok_bTUIEO2O9H", "MyR00tPw!", "D0ckerPw!", "Sshp4ss!", "Htp4ss!x", "N3tUs3Pw!");
		expect(out).toContain("--region us-east-1");
	});
	it("P16: a legacy Dockerfile `ENV KEY value` is masked", () => {
		expectAbsent(maskCredentialAssignments("ENV API_SECRET s3cr3tLegacy1\nENV DB_PASSWORD Dock3rPw!"), "s3cr3tLegacy1", "Dock3rPw!");
	});
	it("P17: separator-less rows are masked (.netrc, vault table, pgpass, prose `password is`)", () => {
		const out = maskCredentialAssignments(
			["machine api.heroku.com", "  login jdoe@example.com", "  password NetrcPw!9x", "password    V4ultPw!x9", "db.internal:5432:app:app:PgP4ss!x", "For the demo the password is hunter2 today."].join("\n"),
		);
		expectAbsent(out, "NetrcPw!9x", "V4ultPw!x9", "PgP4ss!x", "hunter2");
	});
	it("P18: a credential-named XML element is masked", () => {
		const out = maskCredentialAssignments("<smtp><password>XmlPw!x9</password></smtp>");
		expectAbsent(out, "XmlPw!x9");
		expect(out).toContain("<password>…</password>");
	});
	it("P19: a temporary AWS key id is masked like an AKIA key", () => {
		const out = maskCredentialAssignments(`assumed role: ${AWS_TEMP_ID} (expires 13:00)`);
		expect(out).not.toContain(AWS_TEMP_ID);
		expect(out).toContain(`${AWS_TEMP_ID.slice(0, 4)}…${AWS_TEMP_ID.slice(-2)}`);
	});
	it("P20: the short last line of a PEM key is masked in the live state", () => {
		const lines = [mix(64, 5), mix(64, 6), mix(64, 7)];
		const text = [PEM("BEGIN"), ...lines, "BLDe4SARHikF6Ya0fP==", PEM("END"), "DEPLOY_KEY_PASSPHRASE=c0rrect-h0rse"].join("\n");
		for (const sent of sentStates(text)) expectAbsent(sent, ...lines, "BLDe4SARHikF6Ya0fP", "c0rrect-h0rse");
	});
	it("P21: a value truncated with `…` is not mistaken for a mask", () => {
		expectAbsent(maskCredentialAssignments("API_SECRET=7f3a9c2e… DB_PASSWORD=Trunc8d!x…"), "7f3a9c2e", "Trunc8d!x");
	});
	it("P22: a value joined to more parameters by `&` or `;` keeps no character", () => {
		const out = maskCredentialAssignments(
			["jdbc:mysql://db/app?user=app&password=Jdbc!Pw9&useSSL=true", "username=admin&password=F0rmPw!x&remember=1", "Server=db;User ID=sa;Password=Azur3Sql!9;Encrypt=True;"].join("\n"),
		);
		expectAbsent(out, "Jdbc!Pw9", "F0rmPw!x", "Azur3Sql!9");
	});
});

describe("maskCredentialAssignments — negative (must not mask)", () => {
	it("N1: non-credential assignments are untouched", () => {
		const s = "PATH=/usr/bin:/bin GITHUB_USER=quentin PORT=5432 region: us-east-1 image: postgres:16 LOG_LEVEL=debug - name: LOG_LEVEL value: info";
		expect(maskCredentialAssignments(s)).toBe(s);
	});
	it("N2: an already-masked value and the highlighted target are preserved", () => {
		const s = 'DATABASE_URL="⟦post…s@⟧db.internal:5432/app" SLACK_TOKEN="xoxb…jk"';
		expect(maskCredentialAssignments(s)).toBe(s);
	});
	it("N3: values shorter than four characters are left alone", () => {
		const s = "password: no auth=1";
		expect(maskCredentialAssignments(s)).toBe(s);
	});
	it("N4: prose is untouched, including a credential word with no secret-shaped value", () => {
		const s = "The build passed in 42s; the token count is 4096 and the session ended at 10:42. If the password is required, ask the admin; secrets are rotated monthly. See https://example.com/docs:install.";
		expect(maskCredentialAssignments(s)).toBe(s);
	});
	it("N5: placeholders and booleans stay readable", () => {
		const s = "DB_PASSWORD=${DB_PASSWORD} api_key: <your-key> password_auth: true token: {{ .Values.token }}";
		expect(maskCredentialAssignments(s)).toBe(s);
	});
	it("N6: a name/value pair does not reach the next, unrelated value", () => {
		const out = maskCredentialAssignments(["- name: REDIS_PASSWORD", "  valueFrom:", "    secretKeyRef:", "      name: redis", "      key: password", "- name: LOG_LEVEL", "  value: info"].join("\n"));
		expect(out).toContain("value: info");
	});
	it("N7: a window with no neighbouring credential keeps the exact E19 render", () => {
		const text = `config line one\nOPENAI_API_KEY="${OPENAI_LIKE}"\nother text`;
		const hit = firstSecretMatch(text, "sig-secret-openai");
		expect(hit).not.toBeNull();
		if (!hit) return;
		expect(maskedSecretContext(text, hit.start, hit.end)).toBe(`config line one OPENAI_API_KEY="⟦${OPENAI_LIKE.slice(0, 4)}…${OPENAI_LIKE.slice(-2)}⟧" other text`);
	});
});
