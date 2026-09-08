// ===========================================
// Language-parameterized detector corpus
// ===========================================
//
// The language-agnostic inline detectors (PII, hardcoded credentials, TLS
// bypass, weak hash, AES-ECB, SQL injection) are supposed to fire the same
// way regardless of source language. Historically they were tested almost
// entirely against TypeScript fixtures and "assumed portable via regex
// inspection". This corpus pins that portability against REAL snippets in
// Python / Go / Node / Swift / PHP / Java / YAML, in four buckets
// (true_positive / false_positive / edge_case), run through the actual
// detectors. Meta-assertions guarantee every detector keeps a TP+FP pair and
// that multiple languages stay covered, so a future regex tweak can't quietly
// drop a language. Generalizes the DCG guard-corpus pattern to the detector
// layer (see docs/external-pulse/destructive-command-guard.md).

import { describe, expect, it } from "vitest";
import type { InlineMatch } from "../checks/shared.js";
import {
	checkAesEcbMode,
	checkHardcodedCredentials,
	checkPiiInSource,
	checkSqlInjection,
	checkTlsVerifyDisabled,
	checkWeakHash,
} from "../generic-checks.js";

type DetectorId = "pii" | "credentials" | "tls" | "weak_hash" | "aes_ecb" | "sql";

const DETECTORS: Record<DetectorId, (content: string, filePath: string) => InlineMatch[]> = {
	pii: checkPiiInSource,
	credentials: checkHardcodedCredentials,
	tls: checkTlsVerifyDisabled,
	weak_hash: checkWeakHash,
	aes_ecb: checkAesEcbMode,
	sql: checkSqlInjection,
};

type Bucket = "true_positive" | "false_positive" | "edge_case";

interface DetectorCase {
	id: string;
	detector: DetectorId;
	language: string;
	bucket: Bucket;
	file: string;
	content: string;
	/** "fires" → at least one match; "clean" → no match. */
	expect: "fires" | "clean";
}

const SECRET = "a8f2e9b1c3d4567890abcdef12345678";

const CORPUS: DetectorCase[] = [
	// ---- TLS verification disabled (cross-language) ----
	{ id: "tls-py-verify-false", detector: "tls", language: "python", bucket: "true_positive", file: "client.py", content: "requests.get(url, verify=False)", expect: "fires" },
	{ id: "tls-go-insecure-skip", detector: "tls", language: "go", bucket: "true_positive", file: "client.go", content: "cfg := &tls.Config{InsecureSkipVerify: true}", expect: "fires" },
	{ id: "tls-node-reject-unauth", detector: "tls", language: "node", bucket: "true_positive", file: "https.js", content: "https.request({ rejectUnauthorized: false })", expect: "fires" },
	{ id: "tls-py-unverified-ctx", detector: "tls", language: "python", bucket: "true_positive", file: "ssl_setup.py", content: "ctx = ssl._create_unverified_context()", expect: "fires" },
	{ id: "tls-py-verify-true", detector: "tls", language: "python", bucket: "false_positive", file: "client.py", content: "requests.get(url, verify=True)", expect: "clean" },
	{ id: "tls-py-string-mention", detector: "tls", language: "python", bucket: "false_positive", file: "doc.py", content: 'note = "never set verify=False in prod"', expect: "clean" },
	{ id: "tls-comment-mention", detector: "tls", language: "go", bucket: "edge_case", file: "client.go", content: "// InsecureSkipVerify: true is dangerous", expect: "clean" },

	// ---- Weak hash (md5 / sha1) ----
	{ id: "hash-py-md5", detector: "weak_hash", language: "python", bucket: "true_positive", file: "digest.py", content: "h = hashlib.md5(data)", expect: "fires" },
	{ id: "hash-node-createhash", detector: "weak_hash", language: "node", bucket: "true_positive", file: "hash.js", content: 'crypto.createHash("md5").update(x)', expect: "fires" },
	{ id: "hash-php-md5", detector: "weak_hash", language: "php", bucket: "true_positive", file: "Hash.php", content: "$h = md5($payload);", expect: "fires" },
	{ id: "hash-py-sha256", detector: "weak_hash", language: "python", bucket: "false_positive", file: "digest.py", content: "h = hashlib.sha256(data)", expect: "clean" },
	{ id: "hash-string-mention", detector: "weak_hash", language: "node", bucket: "false_positive", file: "doc.js", content: 'const algo = "md5 is weak"', expect: "clean" },

	// ---- AES-ECB ----
	{ id: "aes-py-mode-ecb", detector: "aes_ecb", language: "python", bucket: "true_positive", file: "crypto.py", content: "cipher = AES.new(key, AES.MODE_ECB)", expect: "fires" },
	{ id: "aes-node-string", detector: "aes_ecb", language: "node", bucket: "true_positive", file: "crypto.js", content: 'crypto.createCipheriv("aes-128-ecb", key, null)', expect: "fires" },
	{ id: "aes-go-ecb", detector: "aes_ecb", language: "go", bucket: "true_positive", file: "crypto.go", content: "enc := cipher.NewECBEncrypter(block)", expect: "fires" },
	{ id: "aes-node-gcm", detector: "aes_ecb", language: "node", bucket: "false_positive", file: "crypto.js", content: 'crypto.createCipheriv("aes-256-gcm", key, iv)', expect: "clean" },

	// ---- PII in source ----
	{ id: "pii-py-ssn", detector: "pii", language: "python", bucket: "true_positive", file: "seed.py", content: 'ssn = "456-78-9012"', expect: "fires" },
	{ id: "pii-go-ssn", detector: "pii", language: "go", bucket: "true_positive", file: "seed.go", content: 'ssn := "456-78-9012"', expect: "fires" },
	{ id: "pii-version", detector: "pii", language: "python", bucket: "false_positive", file: "version.py", content: 'VERSION = "1.2.3"', expect: "clean" },

	// ---- Hardcoded credentials (cross-language; ungated 2026-06-12) ----
	{ id: "cred-py", detector: "credentials", language: "python", bucket: "true_positive", file: "settings.py", content: `api_key = "${SECRET}"`, expect: "fires" },
	{ id: "cred-php", detector: "credentials", language: "php", bucket: "true_positive", file: "Config.php", content: `$apiSecret = "${SECRET}";`, expect: "fires" },
	{ id: "cred-yaml", detector: "credentials", language: "yaml", bucket: "true_positive", file: "values.yaml", content: `password: "${SECRET}"`, expect: "fires" },
	{ id: "cred-java", detector: "credentials", language: "java", bucket: "true_positive", file: "Db.java", content: `String authToken = "${SECRET}";`, expect: "fires" },
	{ id: "cred-placeholder", detector: "credentials", language: "python", bucket: "false_positive", file: "settings.py", content: 'password = "changeme"', expect: "clean" },
	{ id: "cred-suffix", detector: "credentials", language: "go", bucket: "false_positive", file: "validate.go", content: 'passwordPattern := "^[A-Za-z0-9]{8,}$"', expect: "clean" },

	// ---- SQL injection ----
	{ id: "sql-py-fstring", detector: "sql", language: "python", bucket: "true_positive", file: "dao.py", content: 'cursor.execute(f"SELECT * FROM users WHERE id={uid}")', expect: "fires" },
	{ id: "sql-ts-template", detector: "sql", language: "typescript", bucket: "true_positive", file: "dao.ts", content: "db.query(`SELECT * FROM users WHERE id=${uid}`)", expect: "fires" },
	{ id: "sql-swift-interp", detector: "sql", language: "swift", bucket: "true_positive", file: "Dao.swift", content: 'try db.execute("SELECT * FROM users WHERE id=\\(uid)")', expect: "fires" },
	{ id: "sql-py-param", detector: "sql", language: "python", bucket: "false_positive", file: "dao.py", content: 'cursor.execute("SELECT * FROM users WHERE id=?", [uid])', expect: "clean" },
	{ id: "sql-ts-static", detector: "sql", language: "typescript", bucket: "false_positive", file: "dao.ts", content: 'db.query("SELECT * FROM users")', expect: "clean" },
];

describe("detector language corpus — meta", () => {
	it("case ids are unique", () => {
		const ids = CORPUS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("holds at least 25 cases (deletion sentinel)", () => {
		expect(CORPUS.length).toBeGreaterThanOrEqual(25);
	});

	it("every detector keeps both a true-positive and a false-positive case", () => {
		for (const detector of Object.keys(DETECTORS)) {
			const cases = CORPUS.filter((c) => c.detector === detector);
			expect(cases.some((c) => c.expect === "fires"), `${detector} has a TP`).toBe(true);
			expect(cases.some((c) => c.expect === "clean"), `${detector} has an FP`).toBe(true);
		}
	});

	it("covers at least six distinct languages", () => {
		expect(new Set(CORPUS.map((c) => c.language)).size).toBeGreaterThanOrEqual(6);
	});
});

describe("detector language corpus — behavior", () => {
	for (const c of CORPUS) {
		it(`[${c.detector}/${c.language}] ${c.id}`, () => {
			const matches = DETECTORS[c.detector](c.content, c.file);
			if (c.expect === "fires") {
				expect(matches.length).toBeGreaterThan(0);
			} else {
				expect(matches).toEqual([]);
			}
		});
	}
});
