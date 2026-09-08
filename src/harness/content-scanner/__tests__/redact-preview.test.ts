import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync as fsWriteFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import {
	buildAskReason,
	buildRedactedPreview,
	writePendingPrompt,
} from "../redact-preview.js";
import type { ContentScanRequest, ScanFinding } from "../types.js";

interface FindingArgs {
	label: string;
	start: number;
	text: string;
	source?: string;
}

function finding(args: FindingArgs): ScanFinding {
	return {
		label: args.label,
		start: args.start,
		end: args.start + args.text.length,
		text: args.text,
		source: args.source ?? "Test.field",
	};
}

describe("buildRedactedPreview", () => {
	it("replaces each span with a <LABEL> placeholder", () => {
		const text = "Contact Alice at alice@example.com please";
		const spans = [
			finding({ label: "private_person", start: 8, text: "Alice" }),
			finding({ label: "private_email", start: 17, text: "alice@example.com" }),
		];
		const preview = buildRedactedPreview(text, spans);
		expect(preview).toBe("Contact <PRIVATE_PERSON> at <PRIVATE_EMAIL> please");
	});

	it("never contains any matched-span substring (no leakage contract)", () => {
		const text = "email alice.jones@example.com phone 555-867-5309";
		const spans = [
			finding({ label: "private_email", start: 6, text: "alice.jones@example.com" }),
			finding({ label: "private_phone", start: 36, text: "555-867-5309" }),
		];
		const preview = buildRedactedPreview(text, spans);
		expect(preview).not.toContain("alice.jones@example.com");
		expect(preview).not.toContain("555-867-5309");
	});

	it("handles multiple adjacent spans by splicing from the end", () => {
		const text = "aaa bbb ccc";
		const spans = [
			finding({ label: "X", start: 0, text: "aaa" }),
			finding({ label: "Y", start: 4, text: "bbb" }),
			finding({ label: "Z", start: 8, text: "ccc" }),
		];
		expect(buildRedactedPreview(text, spans)).toBe("<X> <Y> <Z>");
	});

	it("truncates long inputs around the first hit", () => {
		const text = "prefix ".repeat(50) + "alice@example.com" + " suffix".repeat(50);
		const hitStart = text.indexOf("alice@example.com");
		const spans = [finding({ label: "private_email", start: hitStart, text: "alice@example.com" })];
		const preview = buildRedactedPreview(text, spans);
		expect(preview).toContain("<PRIVATE_EMAIL>");
		expect(preview.length).toBeLessThanOrEqual(205);
		expect(preview).not.toContain("alice@example.com");
	});

	it("passes short clean text through when no spans exist", () => {
		expect(buildRedactedPreview("hello world", [])).toBe("hello world");
	});

	it("truncates long clean text from the beginning when no spans exist", () => {
		const text = "x".repeat(201);
		expect(buildRedactedPreview(text, [])).toBe(`${"x".repeat(200)}…`);
	});

	it("keeps a short hit near the end intact instead of centering a window", () => {
		const text = `${"prefix ".repeat(16)}alice@example.com`;
		const expected = `${"prefix ".repeat(16)}<PRIVATE_EMAIL>`;
		expect(buildRedactedPreview(text, [finding({
			label: "private_email",
			start: text.indexOf("alice@example.com"),
			text: "alice@example.com",
		})])).toBe(expected);
	});

	it("centers truncation on the earliest hit when there are multiple hits", () => {
		const firstValue = "alice@example.com";
		const secondValue = "bob@example.com";
		const text = `${"A".repeat(100)}${firstValue}${"B".repeat(500)}${secondValue}${"C".repeat(500)}`;
		const spans = [
			finding({ label: "first_hit", start: text.indexOf(firstValue), text: firstValue }),
			finding({ label: "later_hit", start: text.indexOf(secondValue), text: secondValue }),
		];
		const preview = buildRedactedPreview(text, spans);
		expect(preview.startsWith("…")).toBe(false);
		expect(preview).toContain("<FIRST_HIT>");
		expect(preview).not.toContain("<LATER_HIT>");
	});
});

describe("writePendingPrompt", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-scanner-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function simpleRequest(): {
		request: ContentScanRequest;
		findingsBySource: Map<string, ScanFinding[]>;
	} {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: "email alice@example.com" }],
		};
		const findingsBySource = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[
					finding({
						label: "private_email",
						start: 6,
						text: "alice@example.com",
						source: "Write.content",
					}),
				],
			],
		]);
		return { request, findingsBySource };
	}

	it("returns a relative path under .interlinked/scanner/pending/", () => {
		const { request, findingsBySource } = simpleRequest();
		const relPath = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		expect(relPath?.startsWith(".interlinked/scanner/pending/")).toBe(true);
	});

	it("creates exactly one file on disk", () => {
		const { request, findingsBySource } = simpleRequest();
		writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		const files = readdirSync(join(tmp, ".interlinked", "scanner", "pending"));
		expect(files).toHaveLength(1);
	});

	it("uses an ISO-safe timestamp, a 12-character content hash, and mode 0600", () => {
		const { request, findingsBySource } = simpleRequest();
		const relPath = nonNull(writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" }));
		expect(relPath).toMatch(
			/^\.interlinked\/scanner\/pending\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{12}\.json$/,
		);
		expect(statSync(join(tmp, relPath)).mode & 0o777).toBe(0o600);
	});

	it("changes the filename hash when request content changes at the same timestamp", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-13T20:00:00.000Z"));
		try {
			const firstRequest: ContentScanRequest = {
				hook: "pre_write_edit",
				parts: [{ source: "Write.content", text: "first value" }],
			};
			const secondRequest: ContentScanRequest = {
				hook: "pre_write_edit",
				parts: [{ source: "Write.content", text: "second value" }],
			};
			const first = writePendingPrompt({
				cwd: tmp,
				request: firstRequest,
				findingsBySource: new Map(),
				toolName: "Write",
			});
			const second = writePendingPrompt({
				cwd: tmp,
				request: secondRequest,
				findingsBySource: new Map(),
				toolName: "Write",
			});
			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(first).not.toBe(second);
		} finally {
			vi.useRealTimers();
		}
	});

	it("defaults a part's spans to [] when it has no entry in findingsBySource", () => {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [
				{ source: "Write.content", text: "email alice@example.com" },
				{ source: "Write.otherField", text: "no findings here" },
			],
		};
		// findingsBySource only has an entry for the first part -> the second
		// part's `findingsBySource.get(...) ?? []` fallback is exercised.
		const findingsBySource = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[
					finding({
						label: "private_email",
						start: 6,
						text: "alice@example.com",
						source: "Write.content",
					}),
				],
			],
		]);
		const relPath = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		const raw = readFileSync(join(tmp, nonNull(relPath)), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.parts[1].source).toBe("Write.otherField");
		expect(parsed.parts[1].spans).toEqual([]);
	});

	it("writes the full unmasked content with a LOCAL-ONLY note", () => {
		const { request, findingsBySource } = simpleRequest();
		writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		const files = readdirSync(join(tmp, ".interlinked", "scanner", "pending"));
		const raw = readFileSync(join(tmp, ".interlinked", "scanner", "pending", nonNull(files[0])), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.tool_name).toBe("Write");
		expect(parsed.parts[0].text).toBe("email alice@example.com");
		expect(parsed.note).toBe(
			"LOCAL-ONLY — this file contains the unmasked content the privacy-filter " +
			"flagged. It was NOT sent to Anthropic. Review before approving the tool " +
			"call in Claude Code; delete when done.",
		);
		expect(raw.endsWith("\n")).toBe(true);
	});
});

describe("buildAskReason", () => {
	it("joins summary + per-source preview + local file pointer", () => {
		const request: ContentScanRequest = {
			hook: "pre_external_egress",
			parts: [
				{ source: "WebFetch.url", text: "https://x.com/u?email=alice@example.com" },
				{ source: "WebFetch.prompt", text: "fetch Alice's profile" },
			],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"WebFetch.url",
				[
					finding({
						label: "private_email",
						start: 22,
						text: "alice@example.com",
						source: "WebFetch.url",
					}),
				],
			],
			[
				"WebFetch.prompt",
				[
					finding({
						label: "private_person",
						start: 6,
						text: "Alice",
						source: "WebFetch.prompt",
					}),
				],
			],
		]);
		const { reason } = buildAskReason({
			policySummary:
				"privacy-filter detected sensitive content [private_email(1), private_person(1)].",
			request,
			findingsBySource: findings,
			pendingPromptPath: ".interlinked/scanner/pending/xyz.json",
		});
		expect(reason).toContain("[private_email(1), private_person(1)]");
		expect(reason).toContain('"private_email": "alice@example.com"');
		expect(reason).toContain('"private_person": "Alice"');
		expect(reason).toContain(
			"Full unmasked content: .interlinked/scanner/pending/xyz.json  (local-only — not sent to Anthropic)",
		);
		expect(reason).toContain(
			"privacy-filter detected sensitive content [private_email(1), private_person(1)].\n\nFlagged PII",
		);
		expect(reason).toContain(
			'"private_email": "alice@example.com"\n\nFull unmasked content:',
		);
	});

	it("renders one `\"category\": \"value\"` row per finding so users can spot false positives", () => {
		// Regression: the original design hid spans behind <CATEGORY> placeholders,
		// which made true positives and false positives indistinguishable. The
		// raw values echoed here come from the tool_input the model itself
		// generated (Bash.command, Write.content, etc.), so repeating them in
		// the reason adds no new information to Anthropic's context.
		const request: ContentScanRequest = {
			hook: "pre_bash_command",
			parts: [
				{
					source: "Bash.command",
					text: "echo 'scanner status file:'\ncat .interlinked/content-scanner.status",
				},
			],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"Bash.command",
				[
					finding({
						label: "private_person",
						start: 28,
						text: "cat .interlinked/content-scanner",
						source: "Bash.command",
					}),
				],
			],
		]);
		const { reason } = buildAskReason({
			policySummary: "privacy-filter detected sensitive content [private_person(1)].",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(reason).toContain("Flagged PII");
		expect(reason).toContain('"private_person": "cat .interlinked/content-scanner"');
	});

	it("sorts rows per-source by start offset (numeric, not lexicographic)", () => {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: "A".repeat(50) }],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[
					finding({ label: "secret", start: 30, text: "LATE", source: "Write.content" }),
					finding({
						label: "private_person",
						start: 5,
						text: "EARLY",
						source: "Write.content",
					}),
				],
			],
		]);
		const { reason } = buildAskReason({
			policySummary:
				"privacy-filter detected sensitive content [secret(1), private_person(1)].",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(reason.indexOf("EARLY")).toBeGreaterThanOrEqual(0);
		expect(reason.indexOf("LATE")).toBeGreaterThan(reason.indexOf("EARLY"));
	});

	it("sorts findings from different sources lexically before comparing offsets", () => {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [
				{ source: "B.source", text: "B" },
				{ source: "A.source", text: "A" },
			],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"B.source",
				[finding({ label: "from_b", start: 1, text: "B", source: "B.source" })],
			],
			[
				"A.source",
				[finding({ label: "from_a", start: 50, text: "A", source: "A.source" })],
			],
		]);
		const { reason } = buildAskReason({
			policySummary: "summary",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(reason.indexOf('"from_a": "A"')).toBeLessThan(reason.indexOf('"from_b": "B"'));
	});

	it("omits the Flagged PII block entirely when there are zero findings", () => {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: "no pii here" }],
		};
		const { reason } = buildAskReason({
			policySummary: "(no findings)",
			request,
			findingsBySource: new Map(),
			pendingPromptPath: undefined,
		});
		expect(reason).not.toContain("Flagged PII");
	});

	// systemMessage is the user-only channel: Claude Code renders it in the
	// permission UI but does NOT include it in the model's context window.
	// These tests share a fixture because they exercise the same call — one
	// assertion per test so a failure points straight at the broken invariant.
	function buildAliceFixture() {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [
				{ source: "Write.content", text: "Email Alice at alice@example.com by Friday" },
			],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[
					finding({ label: "private_person", start: 6, text: "Alice", source: "Write.content" }),
					finding({
						label: "private_email",
						start: 15,
						text: "alice@example.com",
						source: "Write.content",
					}),
				],
			],
		]);
		return buildAskReason({
			policySummary:
				"privacy-filter detected sensitive content [private_email(1), private_person(1)].",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
	}

	it("includes the same raw spans in `reason` so the user sees them before deciding", () => {
		// Per the post-2026-04 design change: the model already saw these
		// exact characters in the tool_input it generated, so echoing them
		// in the reason adds no new info to Anthropic's context — and the
		// user needs them visible in the ask card to judge FPs/TPs pre-click.
		const { reason } = buildAliceFixture();
		expect(reason).toMatch(/Alice.*alice@example\.com/s);
	});

	it("includes raw span values in systemMessage (the user-only rejection-feedback channel)", () => {
		const { systemMessage } = buildAliceFixture();
		expect(systemMessage).toMatch(/Alice.*alice@example\.com/s);
	});

	it("formats each systemMessage row as `\"category\": \"value\"` (lowercase OPF label)", () => {
		const { systemMessage } = buildAliceFixture();
		expect(systemMessage).toContain('"private_person": "Alice"');
	});

	it("uses the user-only header and newline-separated rows exactly", () => {
		const { systemMessage } = buildAliceFixture();
		expect(systemMessage).toBe(
			"🔒 Content scanner — flagged PII (user-only; NOT sent to the model):\n" +
			'  "private_person": "Alice"\n' +
			'  "private_email": "alice@example.com"',
		);
	});

	it("emits one systemMessage row per finding, in scan order", () => {
		const { systemMessage } = buildAliceFixture();
		expect(systemMessage).toMatch(
			/"private_person": "Alice"[\s\S]*"private_email": "alice@example\.com"/,
		);
	});

	it("returns an empty systemMessage when there are zero findings", () => {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: "no pii here" }],
		};
		const { systemMessage } = buildAskReason({
			policySummary: "(no findings)",
			request,
			findingsBySource: new Map(),
			pendingPromptPath: undefined,
		});
		expect(systemMessage).toBe("");
	});

	it("truncates systemMessage at the Claude Code 10K-char cap with a breadcrumb", () => {
		// A massive finding payload must not blow past the hook-reference cap.
		// We aim for ~8K to stay safely under the 10K limit that Claude Code
		// enforces on systemMessage / additionalContext / stdout.
		const spans: ScanFinding[] = [];
		const partText = "X".repeat(20_000);
		for (let i = 0; i < 500; i++) {
			spans.push(
				finding({
					label: "secret",
					start: i * 20,
					text: "X".repeat(10),
					source: "Write.content",
				}),
			);
		}
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: partText }],
		};
		const findings = new Map<string, ScanFinding[]>([["Write.content", spans]]);
		const { systemMessage } = buildAskReason({
			policySummary: "...",
			request,
			findingsBySource: findings,
			pendingPromptPath: ".interlinked/scanner/pending/huge.json",
		});
		expect(systemMessage.length).toBeLessThanOrEqual(8_000);
		expect(systemMessage).toContain("truncated");
	});

	it("does not truncate a systemMessage whose body is exactly at the cap", () => {
		const header = "🔒 Content scanner — flagged PII (user-only; NOT sent to the model):";
		const rowPrefix = '  "secret": "';
		const rowSuffix = '"';
		const filler = "x".repeat(10);
		let rowCount = 1;
		let valueLength = 0;
		while (rowCount < 500) {
			const fixedLength =
				header.length +
				(rowCount - 1) * (1 + rowPrefix.length + filler.length + rowSuffix.length) +
				1 +
				rowPrefix.length +
				rowSuffix.length;
			valueLength = 8_000 - fixedLength;
			if (valueLength >= 0 && valueLength <= 200) break;
			rowCount += 1;
		}
		expect(valueLength).toBeGreaterThanOrEqual(0);
		expect(valueLength).toBeLessThanOrEqual(200);
		const spans = Array.from({ length: rowCount }, (_, index) =>
			finding({
				label: "secret",
				start: index,
				text: index === rowCount - 1 ? "x".repeat(valueLength) : filler,
				source: "Write.content",
			}),
		);
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: "x".repeat(10_000) }],
		};
		const { systemMessage } = buildAskReason({
			policySummary: "...",
			request,
			findingsBySource: new Map([["Write.content", spans]]),
			pendingPromptPath: undefined,
		});
		expect(systemMessage.length).toBe(8_000);
		expect(systemMessage).not.toContain("(truncated; see pending file");
	});

	it("omits the file pointer when no pending-prompt path was written", () => {
		const request: ContentScanRequest = {
			hook: "pre_bash_command",
			parts: [{ source: "Bash.command", text: "echo alice@example.com" }],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"Bash.command",
				[
					finding({
						label: "private_email",
						start: 5,
						text: "alice@example.com",
						source: "Bash.command",
					}),
				],
			],
		]);
		const { reason } = buildAskReason({
			policySummary: "privacy-filter detected sensitive content [private_email(1)].",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(reason).not.toContain("Full unmasked content");
	});

	// escapeRowValue's per-row truncation (SYSTEM_MESSAGE_ROW_VALUE_MAX = 200),
	// exercised through the systemMessage row for one oversized finding.
	it("truncates an individual row value over 200 chars with a breadcrumb", () => {
		const longValue = "Y".repeat(250);
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: longValue }],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[finding({ label: "secret", start: 0, text: longValue, source: "Write.content" })],
			],
		]);
		const { systemMessage } = buildAskReason({
			policySummary: "...",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(systemMessage).toContain("(truncated)");
		expect(systemMessage).not.toContain(longValue);
		expect(systemMessage).toContain(`"secret": "${"Y".repeat(185)}… (truncated)"`);
	});

	it("does not truncate a row value at or under 200 chars", () => {
		const value = "Z".repeat(50);
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: value }],
		};
		const findings = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[finding({ label: "secret", start: 0, text: value, source: "Write.content" })],
			],
		]);
		const { systemMessage } = buildAskReason({
			policySummary: "...",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(systemMessage).toContain(`"secret": "${value}"`);
		expect(systemMessage).not.toContain("(truncated)");
	});

	it("does not truncate a row value of exactly 200 chars", () => {
		const value = "Q".repeat(200);
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: value }],
		};
		const findings = new Map<string, ScanFinding[]>([
			["Write.content", [finding({ label: "secret", start: 0, text: value, source: "Write.content" })]],
		]);
		const { systemMessage } = buildAskReason({
			policySummary: "...",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(systemMessage).toContain(`"secret": "${value}"`);
		expect(systemMessage).not.toContain("(truncated)");
	});

	it("escapes backslashes, quotes, and control characters in row values", () => {
		const value = 'a\\b"c\nd\re\tf';
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: value }],
		};
		const findings = new Map<string, ScanFinding[]>([
			["Write.content", [finding({ label: "secret", start: 0, text: value, source: "Write.content" })]],
		]);
		const { systemMessage } = buildAskReason({
			policySummary: "...",
			request,
			findingsBySource: findings,
			pendingPromptPath: undefined,
		});
		expect(systemMessage).toContain(`  "secret": ${JSON.stringify(value)}`);
	});
});

describe("buildRedactedPreview — truncate() prefix/suffix ellipsis branches", () => {
	it("omits the leading ellipsis when the truncation window starts at offset 0", () => {
		// Hit near the very start of a long text -> centered window clamps to
		// start=0 (no leading "…") but still cuts off the tail (trailing "…").
		const text = `alice@example.com${"x".repeat(400)}`;
		const spans = [finding({ label: "private_email", start: 0, text: "alice@example.com" })];
		const preview = buildRedactedPreview(text, spans);
		expect(preview.startsWith("<PRIVATE_EMAIL>")).toBe(true);
		expect(preview.endsWith("…")).toBe(true);
	});

	it("omits the trailing ellipsis when the truncation window reaches the end of the text", () => {
		// Hit near the very end of a long text -> centered window clamps its end
		// to text.length (no trailing "…") but still cuts off the head (leading "…").
		const text = `${"x".repeat(400)}alice@example.com`;
		const hitStart = text.indexOf("alice@example.com");
		const spans = [finding({ label: "private_email", start: hitStart, text: "alice@example.com" })];
		const preview = buildRedactedPreview(text, spans);
		expect(preview.startsWith("…")).toBe(true);
		expect(preview.endsWith("<PRIVATE_EMAIL>")).toBe(true);
	});
});

describe("writePendingPrompt — filesystem failure paths", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-scanner-fail-"));
	});
	afterEach(() => {
		// Restore perms before recursive cleanup in case a test locked a dir down.
		try {
			chmodSync(join(tmp, ".interlinked", "scanner", "pending"), 0o700);
		} catch {
			// dir may not exist in every test — fine.
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	function simpleRequest(): {
		request: ContentScanRequest;
		findingsBySource: Map<string, ScanFinding[]>;
	} {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text: "email alice@example.com" }],
		};
		const findingsBySource = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[
					finding({
						label: "private_email",
						start: 6,
						text: "alice@example.com",
						source: "Write.content",
					}),
				],
			],
		]);
		return { request, findingsBySource };
	}

	it("returns undefined and does not throw when the pending dir cannot be created", () => {
		// Make the ".interlinked" segment a plain FILE so mkdirSync(..., {recursive})
		// fails with ENOTDIR when trying to create scanner/pending underneath it.
		fsWriteFileSync(join(tmp, ".interlinked"), "not a directory");
		const { request, findingsBySource } = simpleRequest();
		const result = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		expect(result).toBeUndefined();
	});

	it("returns undefined and does not throw when writeFileSync fails (dir not writable)", () => {
		const dir = join(tmp, ".interlinked", "scanner", "pending");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o500); // read + execute, no write
		const { request, findingsBySource } = simpleRequest();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const result = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
			expect(result).toBeUndefined();
			expect(stderrSpy.mock.calls.map((call) => String(call[0])).join(""))
				.toContain("cannot write .interlinked/scanner/pending/");
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("does not skip creation when existsSync reports a missing directory as present", async () => {
		// Replace existsSync only for a fresh module import. The directory is
		// absent, so an unconditional mkdir is observable as a successful write.
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return { ...actual, existsSync: () => true };
		});
		try {
			const { writePendingPrompt: freshWritePendingPrompt } = await import("../redact-preview.js");
			const { request, findingsBySource } = simpleRequest();
			expect(
				freshWritePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" }),
			).toBeUndefined();
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("skips mkdirSync entirely (no throw) when the pending dir already exists", () => {
		const dir = join(tmp, ".interlinked", "scanner", "pending");
		mkdirSync(dir, { recursive: true });
		const { request, findingsBySource } = simpleRequest();
		const result = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		expect(result).toBeDefined();
	});

	it("stringifies a non-Error thrown value from mkdirSync (formatErr's non-Error branch)", async () => {
		// mkdirSync normally throws a real Error, but formatErr's ternary has a
		// String(e) fallback for a non-Error throw. node:fs's real exports are
		// non-configurable under ESM (vi.spyOn can't redefine them directly), so
		// mock the module for a scoped re-import of just this test instead.
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				mkdirSync: () => {
					// Deliberately non-Error to hit formatErr's String(e) branch.
					// eslint-style throw-only-Error rules don't fire here (biome
					// reported the previous suppression as unused).
					throw "boom-not-an-error";
				},
			};
		});
		const { writePendingPrompt: freshWritePendingPrompt } = await import("../redact-preview.js");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const { request, findingsBySource } = simpleRequest();
		try {
			const result = freshWritePendingPrompt({
				cwd: tmp,
				request,
				findingsBySource,
				toolName: "Write",
			});
			expect(result).toBeUndefined();
			const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
			expect(written).toContain("boom-not-an-error");
		} finally {
			stderrSpy.mockRestore();
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("still returns the path when pruneStale's readdirSync fails (GC is best-effort, never fatal)", () => {
		// write+execute (no read) lets writeFileSync create a new entry in the
		// dir but denies readdirSync — this is pruneStale's "directory doesn't
		// exist / can't be read" branch (the readErr catch), reached without
		// the directory being literally absent.
		const dir = join(tmp, ".interlinked", "scanner", "pending");
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o300);
		const { request, findingsBySource } = simpleRequest();
		const result = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		expect(result).toBeDefined();
		expect(result?.startsWith(".interlinked/scanner/pending/")).toBe(true);
	});
});

describe("writePendingPrompt — pruneStale GC", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-scanner-prune-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function simpleRequest(text: string): {
		request: ContentScanRequest;
		findingsBySource: Map<string, ScanFinding[]>;
	} {
		const request: ContentScanRequest = {
			hook: "pre_write_edit",
			parts: [{ source: "Write.content", text }],
		};
		const findingsBySource = new Map<string, ScanFinding[]>([
			[
				"Write.content",
				[finding({ label: "private_email", start: 0, text, source: "Write.content" })],
			],
		]);
		return { request, findingsBySource };
	}

	it("deletes a pending file older than the TTL but keeps a fresh one", () => {
		const { request, findingsBySource } = simpleRequest("old-one@example.com");
		const oldRel = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
		expect(oldRel).toBeDefined();
		const oldAbs = join(tmp, nonNull(oldRel));
		const wayPast = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago > 1h TTL
		utimesSync(oldAbs, wayPast, wayPast);

		// A broken symlink alongside it exercises the per-entry catch (statSync
		// throws ENOENT on a dangling symlink) without crashing the GC sweep.
		const dir = join(tmp, ".interlinked", "scanner", "pending");
		symlinkSync(join(dir, "does-not-exist.json"), join(dir, "broken-link.json"));

		const { request: req2, findingsBySource: fb2 } = simpleRequest("fresh@example.com");
		const freshRel = writePendingPrompt({ cwd: tmp, request: req2, findingsBySource: fb2, toolName: "Write" });
		expect(freshRel).toBeDefined();

		const remaining = readdirSync(dir);
		expect(remaining).not.toContain(oldRel?.split("/").pop());
		expect(remaining).toContain((nonNull(freshRel)).split("/").pop());
	});

	it("retains a file that is only two minutes old", () => {
		vi.useFakeTimers();
		const fixedNow = new Date("2026-08-13T20:00:00.000Z");
		vi.setSystemTime(fixedNow);
		try {
			const { request, findingsBySource } = simpleRequest("recent@example.com");
			const recentRel = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
			const recentAbs = join(tmp, nonNull(recentRel));
			const twoMinutesAgo = new Date(fixedNow.getTime() - 2 * 60 * 1000);
			utimesSync(recentAbs, twoMinutesAgo, twoMinutesAgo);

			const { request: freshRequest, findingsBySource: freshFindings } = simpleRequest("fresh@example.com");
			writePendingPrompt({ cwd: tmp, request: freshRequest, findingsBySource: freshFindings, toolName: "Write" });
			expect(readdirSync(join(tmp, ".interlinked", "scanner", "pending"))).toContain(
				(nonNull(recentRel)).split("/").pop(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a file exactly at the TTL boundary because pruning is strictly older-than", () => {
		vi.useFakeTimers();
		const fixedNow = new Date("2026-08-13T20:00:00.000Z");
		vi.setSystemTime(fixedNow);
		try {
			const { request, findingsBySource } = simpleRequest("boundary@example.com");
			const boundaryRel = writePendingPrompt({ cwd: tmp, request, findingsBySource, toolName: "Write" });
			const boundaryAbs = join(tmp, nonNull(boundaryRel));
			const exactlyAtCutoff = new Date(fixedNow.getTime() - 60 * 60 * 1000);
			utimesSync(boundaryAbs, exactlyAtCutoff, exactlyAtCutoff);

			const { request: freshRequest, findingsBySource: freshFindings } = simpleRequest("fresh@example.com");
			writePendingPrompt({ cwd: tmp, request: freshRequest, findingsBySource: freshFindings, toolName: "Write" });
			expect(readdirSync(join(tmp, ".interlinked", "scanner", "pending"))).toContain(
				(nonNull(boundaryRel)).split("/").pop(),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
