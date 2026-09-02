#!/usr/bin/env node
// =====================================================================
// Doc accuracy check / build
// =====================================================================
//
// Modes:
//   --check (default)  Compare every <!-- gen:NAME -->...<!-- /gen:NAME -->
//                      block in the docs to the facts extracted by
//                      scripts/extract-doc-facts.mjs. Run hand-written
//                      assertions. Exit 1 on any drift. Used by CI.
//
//   --build            Rewrite gen-markers in place from the facts.
//                      Use after editing the codebase to keep numeric
//                      claims in sync. Should produce no diff if --check
//                      already passes.
//
// Documents covered:
//   - landing/public/index.html
//   - README.md
//
// Add a new gen marker:
//   1. Surround the value in the doc with `<!-- gen:NAME -->VALUE<!-- /gen:NAME -->`.
//   2. Add NAME → fact-key entry to GEN_MARKERS below.
//   3. (Optional) Add a hand-written ASSERTION below if the value's
//      shape needs more than gen-marker checking.
//
// Add a new hand-written assertion:
//   - Push to ASSERTIONS array. Each entry: { name, run(facts, docs) }.
//     Throw on failure. The thrown message becomes the CI error.
//
// Receipts staleness:
//   The `data_as_of` gen-marker on the landing page is checked for
//   staleness (warns at >30 days). Refreshing is a two-step manual
//   process — `npm run docs:audit-receipts` re-derives the counts, then
//   the `data_as_of` marker is hand-edited. Not automated in CI because
//   it depends on the maintainer's local activity.jsonl.
//   (An earlier note here named `npm run docs:refresh-receipts`, which
//   has never existed as a package script — the advice was unrunnable.)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DOCS = [
	join(ROOT, "landing/public/index.html"),
	join(ROOT, "README.md"),
	join(ROOT, "CLAUDE.md"),
	join(ROOT, "docs/harness.md"),
];

// Map gen-marker NAME → how to compute its expected value from
// `{ facts, receipts }`. Each entry returns the canonical string that
// should appear inside the marker. Missing key here = the marker is
// unknown and triggers an error.
//
// Code-derived markers use `facts` (from extract-doc-facts.mjs).
// Receipt-derived markers use `receipts` (from landing/receipts.json,
// produced by `npm run docs:audit-receipts` against the maintainer's
// local activity.jsonl + Claude Code transcripts).
const GEN_MARKERS = {
	builtin_rule_count: ({ facts }) => String(facts.builtin_rule_count),
	builtin_rule_category_count: ({ facts }) => String(facts.builtin_rule_category_count),
	quality_check_count: ({ facts }) => String(facts.quality_check_count),
	structural_check_count: ({ facts }) => String(facts.structural_check_count),
	runner_count: ({ facts }) => String(facts.runner_count),
	runners_inline: ({ facts }) => facts.runners_inline,
	mode_names_inline: ({ facts }) => facts.mode_names_inline,
	node_min_version: ({ facts }) => `${facts.node_min_version}+`,
	line_cap: ({ facts }) => String(facts.line_cap),

	// Receipts headline + per-row counts. Each row pulls from
	// receipts.json's verified_rows array, keyed by rule_id.
	receipts_verified: ({ receipts }) => String(receipts.total_verified),
	receipts_logged: ({ receipts }) => String(receipts.total_logged),
	receipts_residual: ({ receipts }) => String(receipts.residual_unverified),
	receipts_window_days: ({ receipts }) => String(receipts.window_days),
	receipts_collapsed: ({ receipts }) => String(receipts.dedup_collapsed),
	receipts_grep_accel: ({ receipts }) => String(receipts.grep_accel_answers_excluded),
	row_tsc_diff_overlay: ({ receipts }) => String(receiptCount(receipts, "tsc-diff-overlay")),
	row_bash_redirect_bypass: ({ receipts }) => String(receiptCount(receipts, "bash-code-file-write-bypass")),
	row_tdd_new_file: ({ receipts }) => String(receiptCount(receipts, "tdd_new_file_gate")),
	row_empty_catch: ({ receipts }) => String(receiptCount(receipts, "empty_catch")),
	row_repo_confinement: ({ receipts }) => String(receiptCount(receipts, "builtin-repo-confinement")),
	row_process_kill: ({ receipts }) => String(receiptCount(receipts, "process-kill")),
	row_reservation_conflict: ({ receipts }) => String(receiptCount(receipts, "reservation-conflict")),
	row_git_destructive: ({ receipts }) => String(receiptCount(receipts, "git-destructive")),
	row_secrets_in_source: ({ receipts }) => String(receiptCount(receipts, "secrets_in_source")),
	row_supply_chain: ({ receipts }) => String(receiptCount(receipts, "supply-chain")),

	// data_as_of is hand-edited; the build script does NOT regenerate it.
	// CI checks staleness separately (see DATA_AS_OF_MAX_AGE_DAYS).
	data_as_of: null,
};

function receiptCount(receipts, ruleId) {
	const row = receipts.verified_rows.find((r) => r.rule_id === ruleId);
	if (!row) {
		throw new Error(
			`receipts.json has no row for rule_id='${ruleId}'. Either rename the gen marker or rerun 'npm run docs:audit-receipts'.`,
		);
	}
	return row.count_verified;
}

const DATA_AS_OF_MAX_AGE_DAYS = 30;

// Hand-written assertions — claims that gen markers can't express.
// Each assertion gets `(facts, docs)` where `docs` is { [absPath]: text }.
// Throw an Error on failure; the message ends up in CI logs.
const ASSERTIONS = [
	{
		name: "hero terminal mockup quotes builtin-rm-rf-root reason verbatim",
		run(facts, docs) {
			const expected = facts.builtin_rule_reasons["builtin-rm-rf-root"];
			if (!expected) throw new Error("builtin-rm-rf-root has no `reason` in source");
			const landing = docs[join(ROOT, "landing/public/index.html")];
			// Strip HTML tags, collapse whitespace — the mockup wraps the reason
			// across multiple <span>s for visual layout.
			const flatLanding = landing.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
			const flatExpected = expected.replace(/\s+/g, " ");
			if (!flatLanding.includes(flatExpected)) {
				throw new Error(
					`Hero terminal mockup must quote rule reason verbatim (whitespace-normalized).\n` +
						`  expected to find: "${flatExpected}"\n` +
						`  in landing/public/index.html`,
				);
			}
		},
	},
	{
		name: "landing page lists every supported runner display name",
		run(facts, docs) {
			const landing = docs[join(ROOT, "landing/public/index.html")];
			for (const name of facts.runner_display) {
				if (!landing.includes(name)) {
					throw new Error(
						`Runner '${name}' is wired in CLIENT_INSTALL_REGISTRY but is not mentioned ` +
							`anywhere on the landing page. Either add it to the 'Works with' band ` +
							`or remove it from src/lib/hooks.ts.`,
					);
				}
			}
		},
	},
	{
		name: "landing page lists every user-facing enforcement mode",
		run(facts, docs) {
			const landing = docs[join(ROOT, "landing/public/index.html")];
			for (const mode of facts.mode_names_user_facing) {
				if (!landing.includes(`>${mode}<`) && !landing.includes(`>${mode} <`)) {
					throw new Error(
						`Mode '${mode}' is in ModeName but is not visible inside any tag on the ` +
							`landing page. Mention it in the FAQ ('What does it actually catch?') ` +
							`or remove it from src/harness/modes.ts.`,
					);
				}
			}
		},
	},
	{
		name: "FAQ does not claim the npm-registry update-check unless source backs it",
		run(facts, docs) {
			const landing = docs[join(ROOT, "landing/public/index.html")];
			const claimsCheck =
				landing.includes("INTERLINKED_NO_UPDATE_CHECK") ||
				landing.includes("registry.npmjs.org/interlinked") ||
				landing.includes("once-per-24-hours") ||
				landing.includes("npm view interlinked-cli");
			if (claimsCheck && !facts.update_check_in_source) {
				throw new Error(
					`The FAQ references the npm-registry update-check feature, but the source ` +
						`(REGISTRY_URL + INTERLINKED_NO_UPDATE_CHECK) is missing from src/. ` +
						`Either restore the feature in src/ or remove the FAQ entry.`,
				);
			}
		},
	},
	{
		name: "README rule count stays in sync with built-in rules",
		run(facts, docs) {
			const readme = docs[join(ROOT, "README.md")];
			// Look for orphan rule-count claims OUTSIDE gen markers.
			const orphan = readme.match(/\b(\d{2,4})\s+deterministic safety rules\b/);
			if (orphan) {
				const claimed = Number.parseInt(orphan[1], 10);
				if (claimed !== facts.builtin_rule_count) {
					throw new Error(
						`README claims '${claimed} deterministic safety rules' but the source has ` +
							`${facts.builtin_rule_count}. Either gen-marker the value or update the prose.`,
					);
				}
			}
		},
	},
	{
		name: "per-file line-cap claim stays in sync with DEFAULT_MAX_LINES",
		run(facts, docs) {
			// Catch a CURRENT-cap claim ("capped at N lines" / "N-line per-file
			// cap") that drifts from DEFAULT_MAX_LINES, in README or CLAUDE.md.
			// Historical ratchet arrows ("1500 → 500") aren't "capped at" /
			// "-line per-file cap" shaped, so they're left alone. The gen-markered
			// canonical value is validated by the marker loop; this is the
			// backstop for re-introduced un-markered prose.
			const re = /capped at\D*?(\d{3,4})\s+lines|\b(\d{3,4})-line per-file cap/gi;
			for (const path of [join(ROOT, "README.md"), join(ROOT, "CLAUDE.md")]) {
				const text = docs[path];
				if (!text) continue;
				for (const m of text.matchAll(re)) {
					const claimed = Number.parseInt(m[1] ?? m[2], 10);
					if (claimed !== facts.line_cap) {
						throw new Error(
							`${path.replace(`${ROOT}/`, "")} claims a ${claimed}-line per-file cap but ` +
								`DEFAULT_MAX_LINES is ${facts.line_cap}. Wrap it in ` +
								`<!-- gen:line_cap -->${facts.line_cap}<!-- /gen:line_cap --> or fix the prose.`,
						);
					}
				}
			}
		},
	},
];

// ---------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------

const MARKER_RE_CACHE = new Map();
function markerRe(name) {
	let re = MARKER_RE_CACHE.get(name);
	if (!re) {
		// (?:[\s\S]*?) so newlines inside the marker are fine. Marker is
		// non-greedy and bounded by the closing tag.
		re = new RegExp(`<!--\\s*gen:${name}\\s*-->([\\s\\S]*?)<!--\\s*/gen:${name}\\s*-->`, "g");
		MARKER_RE_CACHE.set(name, re);
	}
	re.lastIndex = 0;
	return re;
}

function loadDocs() {
	const docs = {};
	for (const path of DOCS) docs[path] = readFileSync(path, "utf8");
	return docs;
}

function loadFacts() {
	const json = execFileSync("node", [join(ROOT, "scripts/extract-doc-facts.mjs")], {
		encoding: "utf8",
	});
	try {
		return JSON.parse(json);
	} catch (err) {
		throw new Error(`extract-doc-facts.mjs produced invalid JSON: ${err.message}`, { cause: err });
	}
}

function loadReceipts() {
	const path = join(ROOT, "landing/receipts.json");
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(
			`landing/receipts.json missing or unreadable. Run 'npm run docs:audit-receipts' locally to regenerate it (requires .interlinked/activity.jsonl + Claude Code session transcripts).`,
		);
	}
}

function checkDataAsOfStaleness(docs) {
	const landing = docs[join(ROOT, "landing/public/index.html")];
	const m = markerRe("data_as_of").exec(landing);
	if (!m) return { ok: true, warn: "no data_as_of marker on landing page" };
	const stamp = m[1].trim();
	const stampDate = new Date(stamp);
	if (Number.isNaN(stampDate.getTime())) {
		return { ok: false, error: `data_as_of stamp '${stamp}' is not a parseable date` };
	}
	const ageDays = (Date.now() - stampDate.getTime()) / (1000 * 60 * 60 * 24);
	if (ageDays > DATA_AS_OF_MAX_AGE_DAYS) {
		return {
			ok: true,
			warn: `data_as_of is ${Math.round(ageDays)} days old (>${DATA_AS_OF_MAX_AGE_DAYS} day threshold). Re-derive the counts with \`npm run docs:audit-receipts\`, then hand-edit the data_as_of marker on the landing page (it is deliberately not generated).`,
		};
	}
	return { ok: true };
}

function findMarkers(text) {
	const found = [];
	const allRe = /<!--\s*gen:([\w_]+)\s*-->[\s\S]*?<!--\s*\/gen:[\w_]+\s*-->/g;
	let match = allRe.exec(text);
	while (match) {
		found.push({ name: match[1], full: match[0] });
		match = allRe.exec(text);
	}
	return found;
}

// Push one error per marker name found in `docs` that has no entry in
// GEN_MARKERS. Pure collection step — no other side effects.
function collectUnknownMarkerErrors(docs, errors) {
	for (const [path, text] of Object.entries(docs)) {
		for (const { name } of findMarkers(text)) {
			if (!(name in GEN_MARKERS)) {
				errors.push(`${path}: unknown gen marker '${name}'. Add it to GEN_MARKERS in scripts/check-docs.mjs.`);
			}
		}
	}
}

// For one gen-marker NAME, push an error for every occurrence across `docs`
// whose content doesn't match the canonical value computed by `fn(ctx)`.
function collectMarkerDriftErrorsForName(name, fn, ctx, docs, errors) {
	let expected;
	try {
		expected = fn(ctx);
	} catch (err) {
		errors.push(`gen:${name} computation failed: ${err.message}`);
		return;
	}
	for (const [path, text] of Object.entries(docs)) {
		const re = markerRe(name);
		let m = re.exec(text);
		while (m) {
			const actual = m[1];
			if (actual !== expected) {
				errors.push(
					`${path}: gen:${name} drift\n` +
						`  expected: ${expected}\n` +
						`  actual:   ${actual}`,
				);
			}
			m = re.exec(text);
		}
	}
}

// Every gen marker's content matches the canonical value.
function collectMarkerDriftErrors(ctx, docs, errors) {
	for (const [name, fn] of Object.entries(GEN_MARKERS)) {
		if (fn === null) continue;
		collectMarkerDriftErrorsForName(name, fn, ctx, docs, errors);
	}
}

// Hand-written assertions.
function collectAssertionErrors(facts, docs, receipts, errors) {
	for (const a of ASSERTIONS) {
		try {
			a.run(facts, docs, receipts);
		} catch (err) {
			errors.push(`assertion "${a.name}":\n  ${err.message}`);
		}
	}
}

// Emit warnings/errors to stderr and exit(1) on failure; otherwise print the
// one-line OK summary to stdout.
function reportCheckResult(warnings, errors, facts, receipts) {
	if (warnings.length > 0) {
		for (const w of warnings) process.stderr.write(`[docs:warn] ${w}\n`);
	}
	if (errors.length > 0) {
		for (const e of errors) process.stderr.write(`[docs:fail] ${e}\n`);
		process.stderr.write(`\n${errors.length} doc-accuracy failure(s). Run 'npm run docs:build' to regenerate gen markers, then fix any remaining hand-written drift.\n`);
		process.exit(1);
	}
	process.stdout.write(
		`docs OK (${facts.builtin_rule_count} rules · ${facts.runner_count} runners · ${facts.mode_names_user_facing.length} modes · Node ${facts.node_min_version}+ · ${receipts.total_verified} verified blocks / ${receipts.total_logged} logged)\n`,
	);
}

function check() {
	const facts = loadFacts();
	const receipts = loadReceipts();
	const ctx = { facts, receipts };
	const docs = loadDocs();
	const errors = [];
	const warnings = [];

	// 1. Every marker has a known mapping or is hand-edited (data_as_of).
	collectUnknownMarkerErrors(docs, errors);

	// 2. Every gen marker's content matches the canonical value.
	collectMarkerDriftErrors(ctx, docs, errors);

	// 3. Hand-written assertions.
	collectAssertionErrors(facts, docs, receipts, errors);

	// 4. Receipts staleness — warn only.
	const stale = checkDataAsOfStaleness(docs);
	if (stale.warn) warnings.push(stale.warn);
	if (stale.error) errors.push(stale.error);

	// 5. Report.
	reportCheckResult(warnings, errors, facts, receipts);
}

function build() {
	const facts = loadFacts();
	const receipts = loadReceipts();
	const ctx = { facts, receipts };
	const docs = loadDocs();
	let totalChanges = 0;

	for (const [path, text] of Object.entries(docs)) {
		let updated = text;
		for (const [name, fn] of Object.entries(GEN_MARKERS)) {
			if (fn === null) continue;
			const expected = fn(ctx);
			updated = updated.replace(
				markerRe(name),
				`<!-- gen:${name} -->${expected}<!-- /gen:${name} -->`,
			);
		}
		if (updated !== text) {
			writeFileSync(path, updated);
			totalChanges += 1;
			process.stdout.write(`updated ${path.replace(`${ROOT}/`, "")}\n`);
		}
	}

	if (totalChanges === 0) {
		process.stdout.write("no changes — gen markers already in sync\n");
	}
}

const mode = process.argv[2] === "--build" ? "build" : "check";
if (mode === "build") build();
else check();
