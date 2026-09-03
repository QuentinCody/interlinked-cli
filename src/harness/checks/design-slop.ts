// ===========================================================================
// Design-slop detector — AI-generated frontend "tells"
// ===========================================================================
// Flags the recognizable signatures of AI-generated UI: overused fonts (Inter
// & friends), side-tab accent borders, gradient text, purple/violet AI
// palettes, bounce/elastic easing, gray text on colored backgrounds, broken
// images, plus two copy tells (em-dash overuse, marketing buzzwords).
//
// This is a brand-new domain for the harness — every other check family is
// code-correctness / security / complexity; none look at design quality. The
// rules + their false-positive guards (`isSafeElement`, `isNeutralBorderColor`,
// `stripHtmlToText`) are ported from Impeccable's deterministic regex engine
// (github.com/pbakaus/impeccable, Apache-2.0). Intake:
// docs/external-pulse/impeccable.md. We deliberately port only the PURE-REGEX
// rules — the cascade/rendered-DOM rules need css-tree/puppeteer and reach us
// via the `interlinked design` subprocess command, not as inline checks.
//
// Check id: design_slop
// Phase:    post (advisory) — these are taste levers, not correctness bugs, so
//           they live in the deep-audit tier (DEFAULT_ADVISORY_SKIPS), never
//           the default gate. Aesthetic findings must not break a turn.
// Scope:    design-surface files only (.html/.css/.jsx/.tsx/.vue/.svelte/...).
//           Plain .ts/.js are excluded — they are rarely UI and matching
//           CSS-shaped strings there would be noisy.

import { getExtension, type InlineMatch } from "./shared.js";

// ─── Scope ──────────────────────────────────────────────────────────────────

/** Design-surface extensions. Mirrors Impeccable's ALLOWED_EXTS minus .ts/.js
 *  (we keep backend source out to avoid CSS-shaped-string false positives). */
const DESIGN_EXTS = new Set([
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
	".jsx",
	".tsx",
	".vue",
	".svelte",
	".astro",
]);

const MAX_MATCHES_PER_FILE = 12;
const EXCERPT_TRUNC = 120;

// ─── Data ────────────────────────────────────────────────────────────────────

/** Fonts so common across AI-generated UIs they no longer read as a choice. */
const OVERUSED_FONTS =
	"Inter|Roboto|Open Sans|Lato|Montserrat|Fraunces|Geist Sans|Geist Mono|Geist|Mona Sans|Plus Jakarta Sans|Space Grotesk|Recoleta|Instrument Sans|Instrument Serif";

/** Google-Fonts URL form of the same list (`family=Inter`, `family=Plus+Jakarta+Sans`). */
const OVERUSED_FONTS_URL = OVERUSED_FONTS.replace(/ /g, "\\+");

/** SaaS marketing phrases that read as AI copy. Multi-word to stay low-FP
 *  (a bare "leverage" is fine; "leverage the power" is the tell). */
const BUZZWORDS = [
	"streamline your",
	"empower your",
	"supercharge your",
	"unleash your",
	"unleash the power",
	"leverage the power",
	"harness the power",
	"built for the modern",
	"trusted by leading",
	"best-in-class",
	"industry-leading",
	"world-class",
	"enterprise-grade",
	"next-generation",
	"cutting-edge",
	"transform your business",
	"revolutionize",
	"game-changer",
	"mission-critical",
	"future-proof",
	"seamless experience",
	"seamlessly integrate",
];

// ─── False-positive guards (ported from Impeccable detect-text.mjs) ──────────

const hasRounded = (line: string): boolean => /\brounded(?:-\w+)?\b/.test(line);
const hasBorderRadius = (line: string): boolean => /border-radius/i.test(line);

/** Inline / structural elements where a thick side border is normal (quote
 *  bars, nav rails, code blocks) rather than the AI accent-stripe tell. */
const isSafeElement = (line: string): boolean =>
	/<(?:blockquote|nav[\s>]|pre[\s>]|code[\s>]|a\s|input[\s>]|span[\s>])/i.test(line);

/** A gray/silver/black/white/transparent border isn't an "accent" stripe —
 *  only a saturated color counts. Returns true for low-chroma borders. */
function isNeutralBorderColor(str: string): boolean {
	const m = str.match(
		/solid\s+((?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^)]*\)|#[0-9a-f]{3,8}\b|[a-z]+)/i,
	);
	if (!m || m[1] === undefined) return false;
	const c = m[1].toLowerCase();
	if (["gray", "grey", "silver", "white", "black", "transparent", "currentcolor"].includes(c)) {
		return true;
	}
	const hex6 = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
	if (hex6?.[1] && hex6[2] && hex6[3]) {
		const r = parseInt(hex6[1], 16);
		const g = parseInt(hex6[2], 16);
		const b = parseInt(hex6[3], 16);
		return Math.max(r, g, b) - Math.min(r, g, b) < 30;
	}
	const hex3 = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
	if (hex3?.[1] && hex3[2] && hex3[3]) {
		const r = parseInt(hex3[1] + hex3[1], 16);
		const g = parseInt(hex3[2] + hex3[2], 16);
		const b = parseInt(hex3[3] + hex3[3], 16);
		return Math.max(r, g, b) - Math.min(r, g, b) < 30;
	}
	return false;
}

/** Drop scripts/styles/comments/tags so copy analyzers see only rendered text. */
function stripHtmlToText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");
}

// ─── Per-line matchers ───────────────────────────────────────────────────────

interface LineMatcher {
	/** Sub-rule id (shown to the agent). */
	rule: string;
	/** Global regex run against each raw line. */
	regex: RegExp;
	/** Extra predicate on the match + line; return false to suppress. */
	test?: (m: RegExpExecArray, line: string) => boolean;
	/** Human message for a confirmed hit. */
	message: string;
}

const LINE_MATCHERS: LineMatcher[] = [
	// ── Overused fonts ──
	{
		rule: "overused-font",
		regex: new RegExp(`font-family\\s*:\\s*['"]?(${OVERUSED_FONTS})\\b`, "gi"),
		message: "overused font — pick a face with more personality",
	},
	{
		rule: "overused-font",
		regex: new RegExp(`fonts\\.googleapis\\.com/css2?\\?family=(${OVERUSED_FONTS_URL})\\b`, "gi"),
		message: "overused font loaded from Google Fonts",
	},
	// ── Side-tab accent border (the single most recognizable AI tell) ──
	{
		rule: "side-tab",
		regex: /\bborder-[lrse]-(\d+)\b/g,
		test: (m, line) => {
			const n = Number(m[1]);
			return hasRounded(line) ? n >= 2 : n >= 4;
		},
		message: "thick side accent border — a top AI-UI tell; subtle it or drop it",
	},
	{
		rule: "side-tab",
		regex: /border-(?:left|right)\s*:\s*(\d+)px\s+solid[^;]*/gi,
		test: (m, line) => {
			if (isSafeElement(line) || isNeutralBorderColor(m[0])) return false;
			const n = Number(m[1]);
			return hasBorderRadius(line) ? n >= 2 : n >= 3;
		},
		message: "thick colored side border — a top AI-UI tell; subtle it or drop it",
	},
	// ── Gradient text ──
	{
		rule: "gradient-text",
		regex: /background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/gi,
		test: (_m, line) => /gradient/i.test(line),
		message: "gradient text (background-clip: text + gradient) — use a solid color",
	},
	{
		rule: "gradient-text",
		regex: /\bbg-clip-text\b/g,
		test: (_m, line) => /\bbg-gradient-to-/i.test(line),
		message: "gradient text (bg-clip-text + bg-gradient) — use a solid color",
	},
	// ── AI color palette (purple/violet/indigo gradient) ──
	{
		rule: "ai-color-palette",
		regex: /\bfrom-(?:purple|violet|indigo)-\d+\b/g,
		test: (_m, line) => /\bto-(?:purple|violet|indigo|blue|cyan|pink|fuchsia)-\d+\b/.test(line),
		message: "purple/violet AI gradient — choose a distinctive, intentional palette",
	},
	// ── Bounce / elastic easing ──
	{
		rule: "bounce-easing",
		regex: /\banimate-bounce\b/g,
		message: "bounce easing feels dated — use exponential ease-out instead",
	},
	{
		rule: "bounce-easing",
		regex: /animation(?:-name)?\s*:\s*[^;{}]*(?:bounce|elastic|wobble|jiggle|spring)[^;{}]*/gi,
		message: "bounce/elastic easing feels dated — use exponential ease-out instead",
	},
	{
		rule: "bounce-easing",
		regex: /cubic-bezier\(\s*[\d.-]+\s*,\s*([\d.-]+)\s*,\s*[\d.-]+\s*,\s*([\d.-]+)\s*\)/g,
		test: (m) => {
			// The capture class is `[\d.-]+`, NOT digit-only, so it also admits "-",
			// ".", "-." — and `parseFloat("-.")` is NaN. Guard PER COORDINATE, not
			// over both: rejecting the whole match when EITHER side is NaN throws
			// away a real overshoot on the other side. `cubic-bezier(0, -., 0, 5)`
			// is the case that proves it — y2 = 5 genuinely overshoots, and an
			// all-or-nothing guard silently stops reporting it (measured 2026-08-04,
			// caught only because the "fix" was diffed against the original).
			const overshoots = (v: number): boolean => Number.isFinite(v) && (v < -0.1 || v > 1.1);
			return overshoots(parseFloat(m[1] ?? "0")) || overshoots(parseFloat(m[2] ?? "0"));
		},
		message: "overshoot cubic-bezier (bounce) — real objects decelerate smoothly",
	},
	// ── Gray text on colored background (Tailwind) ──
	{
		rule: "gray-on-color",
		regex: /\btext-(?:gray|slate|zinc|neutral|stone)-\d+\b/g,
		test: (_m, line) =>
			/\bbg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+\b/.test(
				line,
			),
		message: "gray text on a colored background looks washed out — use a tint of the bg or white",
	},
	// ── Broken / placeholder image ──
	{
		rule: "broken-image",
		regex: /<img\b[^>]*?\bsrc\s*=\s*(?:""|''|"\s+"|'\s+'|"#"|'#')/gi,
		message: "image with empty/placeholder src ships as a broken-image box",
	},
];

// ─── Whole-file copy analyzers ───────────────────────────────────────────────

/** ≥5 em-dashes (or `--` before non-space) in rendered text reads as AI cadence. */
function detectEmDashOveruse(content: string): { message: string } | null {
	const text = stripHtmlToText(content);
	const re = /—|--(?=\S)/g;
	let count = 0;
	while (re.exec(text) !== null) count++;
	if (count < 5) return null;
	return { message: `${count} em-dashes in body text — an AI cadence tell; vary the punctuation` };
}

/** SaaS buzzword phrases in rendered text. */
function detectMarketingBuzzwords(content: string): { message: string } | null {
	const lower = stripHtmlToText(content).toLowerCase();
	const hits = BUZZWORDS.filter((w) => lower.includes(w));
	if (hits.length === 0) return null;
	return {
		message: `marketing buzzword(s): ${hits.slice(0, 4).join(", ")} — say what the product literally does`,
	};
}

/** True when `matcher` has at least one hit on `line` that survives its own `test`. */
function lineMatcherFires(matcher: LineMatcher, line: string): boolean {
	const re = new RegExp(matcher.regex.source, matcher.regex.flags);
	let hit: RegExpExecArray | null;
	while ((hit = re.exec(line)) !== null) {
		if (matcher.test && !matcher.test(hit, line)) continue;
		return true;
	}
	return false;
}

/** Records one finding per (rule, line) into `matches`, capped at {@link MAX_MATCHES_PER_FILE}. */
function createMatchRecorder(
	matches: InlineMatch[],
): (rule: string, lineNo: number, message: string, excerpt: string) => void {
	const seen = new Set<string>();
	return (rule, lineNo, message, excerpt) => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		const key = `${rule}:${lineNo}`;
		if (seen.has(key)) return;
		seen.add(key);
		matches.push({
			line: lineNo,
			text: `[${rule}] ${message} — ${excerpt.trim().slice(0, EXCERPT_TRUNC)}`,
		});
	};
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect AI-generated design "slop" in a frontend file.
 *
 * Check id: `design_slop` (advisory). Returns up to {@link MAX_MATCHES_PER_FILE}
 * `InlineMatch` findings; each `text` is prefixed with the firing sub-rule
 * (e.g. `[overused-font] …`) so the agent sees which signature tripped.
 *
 * Only fires on design-surface files ({@link DESIGN_EXTS}); returns `[]` for
 * everything else (including plain `.ts`/`.js`).
 */
export function detectDesignSlop(content: string, filePath: string): InlineMatch[] {
	if (!DESIGN_EXTS.has(getExtension(filePath))) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	const record = createMatchRecorder(matches);

	// Per-line matchers.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const matcher of LINE_MATCHERS) {
			if (matches.length >= MAX_MATCHES_PER_FILE) break;
			// one finding per (rule, line) is enough
			if (lineMatcherFires(matcher, line)) record(matcher.rule, i + 1, matcher.message, line);
		}
	}

	// Whole-file copy analyzers (report on line 1).
	const emDash = detectEmDashOveruse(content);
	if (emDash) record("em-dash-overuse", 1, emDash.message, lines[0] ?? "");
	const buzz = detectMarketingBuzzwords(content);
	if (buzz) record("marketing-buzzword", 1, buzz.message, lines[0] ?? "");

	return matches;
}
