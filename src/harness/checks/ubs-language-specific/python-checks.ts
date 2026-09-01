// UBS language-specific detectors — Python-language checks. Extracted from
// ubs-language-specific.ts during the 1500-line decomposition. Each function
// returns InlineMatch[]. Ext-gated to .py / .pyi.

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	lineHasNoqaSuppression,
	stripCommentsAndStrings,
} from "../shared.js";
import { isNoqaSuppressedInRange, isPyFile, MATCH_LIMIT } from "./_shared.js";

// ===========================================
// Row 23 — `ubs_subprocess_shell_true` (Python)
// ===========================================

/**
 * Detect `subprocess.<fn>(... shell=True ...)` — command-injection vector.
 *
 * Plan 04 §4.1 regex: `\bsubprocess\.[a-z_]+\s*\([\s\S]{0,500}?\bshell\s*=\s*True\b`.
 * Widened to `[A-Za-z_]+` so `subprocess.Popen(...)` (uppercase entry point)
 * participates — the spec's lowercase form misses Popen, which is the most
 * common subprocess constructor in production code.
 *
 * The 500-char window covers calls split across many keyword-arg lines.
 */
export function checkSubprocessShellTrue(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".pyi") return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\bsubprocess\.[A-Za-z_]+\s*\([\s\S]{0,500}?\bshell\s*=\s*True\b/g;

	for (const m of stripped.matchAll(re)) {
		if (matches.length >= 10) break;
		// Anchor at `shell` so the warning points at the dangerous keyword.
		const shellIdx = m.index + m[0].lastIndexOf("shell");
		const lineNum = stripped.slice(0, shellIdx).split("\n").length;
		// 139-repo audit: respect Bandit `# noqa: S602 / S603` on any
		// line within the matched call (the suppression typically sits
		// on the opening line of a multi-line subprocess.run(...)).
		// Scan original lines from the call start to the match end.
		const callStartLine = stripped.slice(0, m.index).split("\n").length;
		if (
			isNoqaSuppressedInRange(
				originalLines,
				callStartLine,
				lineNum,
				"ubs_subprocess_shell_true",
			)
		) {
			continue;
		}
		matches.push({
			line: lineNum,
			text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150),
		});
	}
	return matches;
}

// ===========================================
// Row 25 — `ubs_py_none_equality` (Python)
// ===========================================

/**
 * Detect `x == None` / `x != None` in Python — should be `is None` / `is not None`.
 *
 * Per PEP 8: comparisons to singletons (`None`, `True`, `False`) must use
 * `is`/`is not`, never `==`/`!=`. The latter triggers `__eq__` which can
 * return surprising results for proxy/mock objects.
 *
 * Plan 04 §4.1 regex: `\b\w+\s*[!=]=\s*None\b` (matches `x == None` / `x != None`).
 * Yoda style (`None == x` / `None != x`) is also flagged.
 */
export function checkPyNoneEquality(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".pyi") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `\b\w+\s*(==|!=)\s*None\b` — identifier ==/!= None. Also covers Yoda.
	// Written as a non-capturing alternation rather than `[!=]=` so the
	// `ubs_js_loose_equality` detector (which lacks regex-literal stripping)
	// doesn't FP on this regex source line.
	const re = /\b\w+\s*(?:==|!=)\s*None\b|\bNone\s*(?:==|!=)\s*\w+/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (re.test(nonNull(strippedLines[i]))) {
			matches.push({
				line: i + 1,
				text: nonNull(originalLines[i]).trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * `ubs_python_mutable_default_arg` — `def f(x=[])` / `def f(x={})`.
 * post / warning.
 *
 * Python's default-argument values are evaluated ONCE at function-def
 * time. A mutable default ([] or {}) is shared across every invocation —
 * one of Python's classic gotchas. The detector matches `def NAME(args... = [])`
 * with a literal list/dict/set as default value.
 */
export function checkPyMutableDefaultArg(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bdef\s+\w+\s*\([^)]*=\s*(\[\s*\]|\{\s*\}|set\(\))/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(nonNull(originalLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_tempfile_mktemp_race` — Python `tempfile.mktemp()` is a TOCTOU
 * race-condition vector; the file path is returned without holding the file
 * open, so an attacker can win the race and substitute a symlink. pre_warn /
 * error.
 */
export function checkTempfileMktempRace(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\btempfile\.mktemp\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_pickle_untrusted_load` — Python `pickle.load(...)` / `pickle.loads(...)`
 * and the equivalent third-party unpicklers (`cloudpickle`, `dill`) all
 * execute attacker-controlled `__reduce__` code when fed adversarial bytes.
 * pre_warn / error.
 */
export function checkPickleUntrustedLoad(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	// `pickle` / `Pickle` / `cPickle` / `cloudpickle` / `dill` — all share the
	// arbitrary-`__reduce__`-execution surface on `.load(s)`. `jsonpickle.decode`
	// (DW P0.5 class-breadth, 2026-07-17) is the same risk via a different API:
	// it reconstructs arbitrary Python objects from `py/object` tags.
	const re =
		/\b(?:c?[Pp]ickle|cPickle|cloudpickle|dill)\.loads?\s*\(|\bjsonpickle\.decode\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		// 139-repo audit: respect Bandit `# noqa: S301`.
		if (lineHasNoqaSuppression(nonNull(originalLines[i]), "ubs_pickle_untrusted_load")) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_xml_external_entity` — Python XML parsing without disabling external
 * entity resolution exposes the parser to XXE attacks. Fires when an unsafe
 * stdlib parser (`xml.etree`, `xml.dom`, `xml.sax`, `lxml.etree`) is BOTH
 * imported AND used to parse input (`ET.parse(...)`, `ET.fromstring(...)`,
 * `XMLParser(...)`, `XMLPullParser(...)`, `lxml.etree.parse(...)`,
 * `lxml.etree.fromstring(...)`). pre_warn / error.
 *
 * 139-repo audit (2026-05): an import-only gate produced 2 FPs in
 * Supermodel's `mcpbr/src/mcpbr/{junit_reporter,reporting}.py` — both
 * import `xml.etree.ElementTree as ET` only to BUILD/WRITE XML, never
 * to parse untrusted input. XXE risk requires actual parsing of
 * potentially-tainted input; writing XML is safe.
 */
const XML_PARSE_CALL_RE =
	/\b(?:ET|etree|xml\.etree(?:\.\w+)*|lxml\.etree)\s*\.\s*(?:parse|fromstring|XMLParser|XMLPullParser|iterparse)\s*\(|\bXMLPullParser\s*\(/;

export function checkXmlExternalEntity(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `import xml.etree...`, `from xml.etree...`, `from xml.dom...`,
	// `from xml.sax...`, or `from lxml import ...etree`.
	const re =
		/\b(?:import\s+xml\.(?:etree|dom|sax)|from\s+xml\.(?:etree|dom|sax)|from\s+lxml\b)/;

	// Skip files that already use defusedxml — the safe form.
	if (/\bdefusedxml\b/.test(stripped)) return [];

	// 139-repo audit: require an actual parse call somewhere in the
	// file. Import-only files (write-only XML reporters) are safe.
	if (!XML_PARSE_CALL_RE.test(stripped)) return [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		// 139-repo audit: respect Bandit `# noqa: S314 / S320`.
		if (lineHasNoqaSuppression(nonNull(originalLines[i]), "ubs_xml_external_entity")) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_os_system_tainted` — Python `os.system(x)` / `os.popen(x)` invoked with
 * a non-literal first argument (likely user input). Subprocess + shell=True
 * sibling: `os.system` always goes through `/bin/sh`, so any string
 * concatenation here is command-injection territory. pre_warn / error.
 */
export function checkOsSystemTainted(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// os.system(name) / os.popen(name) where the first arg is an identifier
	// (not a string literal — those were stripped by stripCommentsAndStrings).
	const re = /\bos\.(?:system|popen)\s*\(\s*[A-Za-z_]\w*/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_regex_in_loop_no_compile` — Python `re.match(pattern, ...)` /
 * `re.search(pattern, ...)` / `re.sub(pattern, ...)` invoked inside a `for`/
 * `while` loop without first calling `re.compile`. The regex is recompiled
 * on every iteration. post / warning.
 */
export function checkRegexInLoopNoCompile(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	let inLoop = false;
	let loopIndent = -1;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = nonNull(strippedLines[i]);
		const indent = line.search(/\S/);
		if (inLoop && indent !== -1 && indent <= loopIndent) {
			inLoop = false;
			loopIndent = -1;
		}
		if (/^\s*(?:for\b|while\b)/.test(line)) {
			inLoop = true;
			loopIndent = indent;
			continue;
		}
		if (inLoop && /\bre\.(?:match|search|sub|fullmatch|findall|finditer)\s*\(/.test(line)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * `ubs_marshal_load` — Python `marshal.load(...)` / `marshal.loads(...)`.
 * The `marshal` module is for internal-use bytecode caches; deserializing
 * untrusted bytes through it executes arbitrary code via the same surface
 * pickle exposes. pre_block / error.
 */
export function checkMarshalLoad(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bmarshal\.loads?\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		if (lineHasNoqaSuppression(nonNull(originalLines[i]), "ubs_marshal_load")) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_shelve_open` — Python `shelve.open(...)`. `shelve` is a pickle-backed
 * persistent dict; opening one from an untrusted path exposes the same
 * arbitrary-code-execution surface as `pickle.load`. pre_block / error.
 */
export function checkShelveOpen(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bshelve\.open\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		if (lineHasNoqaSuppression(nonNull(originalLines[i]), "ubs_shelve_open")) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_yaml_unsafe_load` — PyYAML's `yaml.load(...)` without a `Safe`-class
 * Loader, plus the explicit `yaml.unsafe_load(...)` alias. Both construct
 * arbitrary Python objects via `!!python/object` tags.
 *
 * The 200-char window after the open paren is long enough for typical
 * keyword-arg call shapes; multi-line YAML loads beyond that fall through
 * (false negative, acceptable since the unsafe shape is also detectable by
 * the missing `safe_load`). pre_block / error for `yaml.unsafe_load`;
 * pre_warn / error for the bare `yaml.load` form without a Safe loader.
 *
 * Returns matches in two buckets keyed by the kind via the source text;
 * the registry entries differentiate severity by ruleName.
 */
export function checkYamlUnsafeLoad(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// `yaml.unsafe_load(` — always unsafe by name.
	const unsafeRe = /\byaml\.unsafe_load\s*\(/g;
	for (const m of stripped.matchAll(unsafeRe)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (lineHasNoqaSuppression(nonNull(originalLines[lineNum - 1]), "ubs_yaml_unsafe_load")) continue;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}

	// `yaml.load(arg)` without a `Safe`-class Loader argument within the call.
	// Negative-lookahead window of 200 chars after the open paren: if `Safe`
	// appears anywhere (matches `SafeLoader`, `CSafeLoader`, `safe_load`-as-
	// string, `Loader=yaml.SafeLoader`), the call is the safe form. No word
	// boundary on `Safe` so `CSafeLoader` (where the C is a word-char prefix)
	// is recognized.
	// `yaml.load(` AND `yaml.load_all(` (the multi-document form) without a
	// Safe-class Loader (DW P0.5 class-breadth: load_all parity, 2026-07-17).
	// `yaml.safe_load_all` is exempt — "yaml." must sit immediately before "load".
	const loadRe = /\byaml\.load(?:_all)?\s*\((?![^)\n]{0,200}Safe)/g;
	for (const m of stripped.matchAll(loadRe)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (matches.some((mx) => mx.line === lineNum)) continue;
		if (lineHasNoqaSuppression(nonNull(originalLines[lineNum - 1]), "ubs_yaml_unsafe_load")) continue;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_torch_unsafe_load` — PyTorch `torch.load(...)` without
 * `weights_only=True`. Older torch defaults to `weights_only=False`, which
 * unpickles arbitrary Python objects from the checkpoint file — a documented
 * supply-chain RCE vector against model artifacts. pre_warn / error.
 *
 * `weights_only=True` within the same call (200-char window) suppresses the
 * warning. Multi-line calls past the window fall through.
 */
export function checkTorchUnsafeLoad(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// `torch.load(...)` whose 200-char arg window does NOT contain
	// `weights_only=True`. The negative lookahead is anchored after the
	// opening paren, so a same-line opt-in suppresses the finding.
	const re = /\btorch\.load\s*\((?![^)\n]{0,200}weights_only\s*=\s*True\b)/g;
	for (const m of stripped.matchAll(re)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (lineHasNoqaSuppression(nonNull(originalLines[lineNum - 1]), "ubs_torch_unsafe_load")) continue;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_pickle_wrapper_load` — library APIs that unpickle without saying
 * "pickle" in the call site: `joblib.load(...)`, `pandas.read_pickle(...)`
 * (and the `pd.` alias), and `numpy.load(..., allow_pickle=True)` (and the
 * `np.` alias; numpy defaults to `allow_pickle=False` since 1.16.3, so the
 * dangerous form must explicitly opt in). pre_warn / error.
 *
 * Each match anchors at the call line. `numpy.load` is flagged ONLY when
 * `allow_pickle=True` appears within the 200-char call window — bare
 * `np.load(arr.npy)` for `.npy` arrays is the safe form.
 */
export function checkPickleWrapperLoad(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isPyFile(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// joblib.load / pd.read_pickle / pandas.read_pickle — always pickle-backed.
	const directRe = /\bjoblib\.load\s*\(|\b(?:pd|pandas)\.read_pickle\s*\(/g;
	for (const m of stripped.matchAll(directRe)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (lineHasNoqaSuppression(nonNull(originalLines[lineNum - 1]), "ubs_pickle_wrapper_load")) continue;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}

	// numpy.load(..., allow_pickle=True) — only flagged with explicit opt-in.
	const numpyRe = /\b(?:np|numpy)\.load\s*\([^)\n]{0,200}\ballow_pickle\s*=\s*True\b/g;
	for (const m of stripped.matchAll(numpyRe)) {
		if (matches.length >= MATCH_LIMIT) break;
		const idx = m.index;
		const lineNum = stripped.slice(0, idx).split("\n").length;
		if (matches.some((mx) => mx.line === lineNum)) continue;
		if (lineHasNoqaSuppression(nonNull(originalLines[lineNum - 1]), "ubs_pickle_wrapper_load")) continue;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}
	return matches;
}
