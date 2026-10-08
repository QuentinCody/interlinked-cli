// ===========================================
// Runtime effects of one module, per operation (H1)
// ===========================================
// What executing a module may depend on, split by what each kind means for TEST EVIDENCE:
//
//   opaque            it may read inputs the check identity does not hash (a filesystem read, a process / network /
//                     VM builtin, package code, dynamic loading, eval, the network, a computed global access). A
//                     test whose closure is opaque runs on ANY change and its result is never reused.
//   nondeterministic  its result may differ between two runs of the same bytes (the clock, randomness, timers,
//                     process state, the checkout path). It reads no repository input, so it is selected only by its
//                     real dependencies, but its passing result is never reused.
//   (neither)         the reference is PROVEN pure: an exact (root, member) pair on an allowlist below, or an
//                     identifier that is neither a tracked global nor a binding imported from a builtin.
//
// The rule is an allowlist, not a blocklist (round 2, 2026-10-06). Every access chain is resolved to its ROOT
// identifier. If the root is a tracked global (globalThis, Date, Math, process, vi, fetch, ...) or a binding imported
// from a builtin module, the chain is pure only when its first member is on that root's pure list; a computed
// access, an escape of the root as a value (`const m = Math`, `const load = vi.importActual`) and every unlisted
// member are not reusable. The environment (`process.env`, `platform`) is part of every check identity; the checkout
// path (`process.cwd()`, `import.meta.url`, `path.resolve`) is NOT (receipts are shared across byte-identical
// checkouts at different paths). Package code stays opaque on purpose: a package handed a path can read it.

import type * as TS from "typescript";
import { analyzeSyntax, type ImportReference } from "../lib/metrics/analysis-syntax.js";
import type { ParsedTsSource } from "./checks/cyclomatic-ast.js";

export interface FileEffects {
    /** Why the module may read unhashed inputs; empty when it cannot. */
    opaque: string[];
    /** Why the module's result may not repeat; empty when it repeats. */
    nondeterministic: string[];
    /** Literal RELATIVE module specifiers it loads (static, dynamic literal, `vi.mock`, `vi.importActual`), for the graph to resolve. */
    specifiers: string[];
}

type Kind = "opaque" | "nondeterministic";
/** What one root (a global or a builtin module) may do: its proven-pure members and how every other use is classified. */
interface Rule {
    /** Members proven pure. Everything else on this root is not. */
    pure: ReadonlySet<string>;
    kind: Kind;
    /** Members that are `opaque` although the root's kind is nondeterministic. */
    opaque?: ReadonlySet<string>;
    prefix: string;
    /** `Math.random` (dotted) versus `os: uptime`. */
    dotted?: boolean;
    /** One fixed reason whatever the member (the clock, timers, the network). */
    fixed?: string;
    /** The bare root is callable and pure (`assert(x)`). */
    bareOk?: boolean;
    /** Word for a bare or computed use of a module namespace. */
    bareWord?: string;
    /** A namespace import of this module is opaque at once (a filesystem namespace is judged as reading). */
    eagerNamespace?: boolean;
}

const names = (list: string): ReadonlySet<string> => new Set(list.split(" "));
const globalRule = (prefix: string, pure: string, kind: Kind, extra: Partial<Rule> = {}): Rule => ({ prefix, pure: names(pure), kind, dotted: true, ...extra });
const moduleRule = (prefix: string, pure: string, kind: Kind, extra: Partial<Rule> = {}): Rule => ({ prefix, pure: names(pure), kind, bareWord: "namespace", ...extra });
const fixedRule = (reason: string, kind: Kind): Rule => ({ prefix: reason, pure: new Set(), kind, fixed: reason });

const FS_WRITES = "writeFileSync writeFile appendFileSync appendFile mkdirSync mkdir mkdtempSync mkdtemp rmSync rm rmdirSync rmdir unlinkSync unlink renameSync rename symlinkSync symlink linkSync link truncateSync truncate chmodSync chmod utimesSync utimes createWriteStream writeSync write writevSync writev fsyncSync fsync closeSync close";
const FS_RULE = moduleRule("fs read", FS_WRITES, "opaque", { dotted: false, eagerNamespace: true });
const PROCESS_RULE = globalRule("process", "env platform arch version versions", "nondeterministic", { opaque: names("stdin binding dlopen") });
const CRYPTO_RULE = moduleRule("crypto", "createHash createHmac timingSafeEqual pbkdf2Sync scryptSync hash getHashes createCipheriv createDecipheriv getCiphers getCurves", "nondeterministic");
const PATH_RULE = moduleRule("path", "join basename extname dirname normalize isAbsolute parse format sep delimiter", "nondeterministic");
const OS_RULE = moduleRule("os", "tmpdir homedir platform arch type EOL endianness devNull release version machine", "nondeterministic");
const ASSERT_RULE = moduleRule("assert", "ok equal strictEqual deepEqual deepStrictEqual notEqual notStrictEqual notDeepEqual notDeepStrictEqual throws doesNotThrow rejects doesNotReject match doesNotMatch fail ifError AssertionError strict", "opaque", { bareOk: true });

/** Builtin modules with a proven-pure member list. A builtin module not named here is opaque (or nondeterministic) as a whole. */
const MODULE_RULES = new Map<string, Rule>([
    ["fs", FS_RULE], ["fs/promises", FS_RULE], ["path", PATH_RULE], ["path/posix", PATH_RULE], ["path/win32", PATH_RULE], ["os", OS_RULE],
    ["process", PROCESS_RULE], ["crypto", CRYPTO_RULE], ["assert", ASSERT_RULE], ["assert/strict", ASSERT_RULE],
    ["url", moduleRule("url", "URL URLSearchParams fileURLToPath urlToHttpOptions domainToASCII domainToUnicode format parse resolve", "nondeterministic")],
    ["util", moduleRule("util", "inspect format promisify types isDeepStrictEqual deprecate inherits stripVTControlCharacters TextEncoder TextDecoder parseArgs callbackify", "opaque")],
    ["util/types", moduleRule("util/types", "isDate isRegExp isPromise isMap isSet isTypedArray isUint8Array isArrayBuffer", "opaque")],
    ["buffer", moduleRule("buffer", "Buffer Blob File atob btoa", "opaque")],
    ["events", moduleRule("events", "EventEmitter once errorMonitor", "opaque", { bareOk: true })],
    ["stream", moduleRule("stream", "Readable Writable Transform PassThrough Duplex pipeline finished", "opaque")],
    ["string_decoder", moduleRule("string_decoder", "StringDecoder", "opaque")],
    ["querystring", moduleRule("querystring", "parse stringify escape unescape", "opaque")],
    ["punycode", moduleRule("punycode", "toASCII toUnicode encode decode", "opaque")],
    ["zlib", moduleRule("zlib", "gzipSync gunzipSync deflateSync inflateSync deflateRawSync inflateRawSync unzipSync brotliCompressSync brotliDecompressSync crc32", "opaque")],
    ["async_hooks", moduleRule("async_hooks", "AsyncLocalStorage AsyncResource", "opaque")],
]);
/** Builtins whose use repeats only within one run. Any other builtin without a member list is opaque. */
const NONDETERMINISTIC_BUILTINS = new Set(["timers", "timers/promises", "perf_hooks"]);

const VI_RULE = globalRule("vi", "fn spyOn stubEnv unstubAllEnvs stubGlobal unstubAllGlobals useFakeTimers useRealTimers setSystemTime getMockedSystemTime getRealSystemTime advanceTimersByTime advanceTimersByTimeAsync advanceTimersToNextTimer runAllTimers runOnlyPendingTimers runAllTicks runAllTimersAsync runOnlyPendingTimersAsync clearAllTimers getTimerCount isFakeTimers clearAllMocks resetAllMocks restoreAllMocks mocked isMockFunction hoisted resetModules unmock doUnmock setConfig resetConfig", "opaque");
const MATH_PURE = "abs max min floor ceil round trunc sign sqrt cbrt pow exp expm1 log log1p log2 log10 hypot sin cos tan asin acos atan atan2 sinh cosh tanh asinh acosh atanh fround clz32 imul PI E LN2 LN10 LOG2E LOG10E SQRT2 SQRT1_2";
/** Tracked globals: each is judged by its first member; every other global identifier is not a root. */
const GLOBAL_RULES = new Map<string, Rule>([
    ["Date", fixedRule("Date", "nondeterministic")], ["performance", fixedRule("performance", "nondeterministic")],
    ["setTimeout", fixedRule("timer: setTimeout", "nondeterministic")], ["setInterval", fixedRule("timer: setInterval", "nondeterministic")],
    ["setImmediate", fixedRule("timer: setImmediate", "nondeterministic")],
    ["fetch", fixedRule("network: fetch", "opaque")], ["WebSocket", fixedRule("network: WebSocket", "opaque")],
    ["XMLHttpRequest", fixedRule("network: XMLHttpRequest", "opaque")], ["EventSource", fixedRule("network: EventSource", "opaque")],
    ["Math", globalRule("Math", MATH_PURE, "nondeterministic")], ["process", PROCESS_RULE], ["crypto", CRYPTO_RULE],
    ["Buffer", globalRule("Buffer", "from alloc concat isBuffer byteLength compare isEncoding", "nondeterministic")], ["vi", VI_RULE],
]);
/** The global object: its members are re-rooted onto the tracked globals above; these are pure; any other member is unknown state. */
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);
const SHADOWABLE_GLOBAL_OBJECTS = new Set(["self", "window"]);
const GLOBAL_PURE = names("Array Object JSON Map Set WeakMap WeakSet WeakRef Promise Symbol String Number Boolean BigInt RegExp Error TypeError RangeError Reflect Proxy console structuredClone URL URLSearchParams TextEncoder TextDecoder Intl queueMicrotask atob btoa isNaN isFinite parseInt parseFloat Uint8Array ArrayBuffer");
/** `import.meta` members that expose the checkout path, which the execution identity does not bind. */
const CHECKOUT_PATH_META = new Set(["url", "dirname", "filename"]);
/** Packages the test RUNNER provides; loading them reads nothing the run did not already bind. */
const RUNNER_PACKAGES = new Set(["vitest", "vitest/config"]);
/** `fast-check` picks a random seed unless the test pins one, so its passing result does not repeat. */
const isFastCheck = (specifier: string): boolean => specifier === "fast-check" || specifier.startsWith("fast-check/");
const MODULE_LOADERS = new Set(["mock", "doMock", "importActual", "importMock"]);

function builtinModule(specifier: string): string | null {
    if (specifier.startsWith("node:")) return specifier.slice("node:".length);
    return /^(fs|fs\/promises|path|path\/posix|path\/win32|url|util|util\/types|os|crypto|assert|assert\/strict|buffer|events|stream|string_decoder|querystring|punycode|zlib|async_hooks|timers|timers\/promises|perf_hooks|child_process|worker_threads|cluster|vm|module|inspector|net|http|https|http2|dgram|dns|tls|wasi|repl|readline|v8)$/.test(specifier) ? specifier : null;
}

/** A namespace, default or `require` binding exposes every member, so it is judged by use (when tracked) or as using all of them. */
function wholeModule(reference: ImportReference): boolean {
    return reference.names.length === 0 || reference.names.some(name => name === "*" || name === "default");
}

const importLabel = (rule: Rule, member: string): string => `${rule.prefix}: ${member}`;

/** `tracked`: a static `import x from` / `import * as x from` whose uses are judged one by one, so the import itself says nothing. */
function builtinEffect(module: string, reference: ImportReference, effects: FileEffects, tracked: boolean): void {
    const rule = MODULE_RULES.get(module);
    if (rule === undefined) {
        (NONDETERMINISTIC_BUILTINS.has(module) ? effects.nondeterministic : effects.opaque).push(`builtin: ${module}`);
        return;
    }
    if (wholeModule(reference) && (rule.eagerNamespace || !tracked)) effects[rule.eagerNamespace ? "opaque" : rule.kind].push(importLabel(rule, "namespace"));
    for (const name of reference.names.filter(entry => entry !== "*" && entry !== "default" && !rule.pure.has(entry))) effects[rule.opaque?.has(name) ? "opaque" : rule.kind].push(importLabel(rule, name));
}

function importEffect(reference: ImportReference, effects: FileEffects, tracked: ReadonlySet<string>): void {
    if (reference.typeOnly) return;
    const specifier = reference.specifier;
    if (specifier === null) {
        effects.opaque.push(reference.loader === "require" ? "dynamic require" : "dynamic import");
        return;
    }
    if (specifier.startsWith(".")) {
        effects.specifiers.push(specifier);
        return;
    }
    const module = builtinModule(specifier);
    if (module !== null) builtinEffect(module, reference, effects, tracked.has(`${specifier}@${reference.line}`));
    else packageEffect(specifier, effects);
}

function packageEffect(specifier: string, effects: FileEffects): void {
    if (isFastCheck(specifier)) effects.nondeterministic.push("package: fast-check");
    else if (!RUNNER_PACKAGES.has(specifier)) effects.opaque.push(`package: ${specifier}`);
}

/** The member name a callee spells: `x.name` or `x["name"]`. */
function loaderName(ts: typeof TS, callee: TS.Expression): string | null {
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) return callee.argumentExpression.text;
    return null;
}

/** `vi.mock("./x")` / `vi.importActual("./x")` load that module; a non-literal argument names an unknown one. */
function moduleLoaderCall(ts: typeof TS, node: TS.CallExpression, effects: FileEffects): void {
    const name = loaderName(ts, node.expression);
    if (name === null || !MODULE_LOADERS.has(name)) return;
    const argument = node.arguments[0];
    if (argument && ts.isStringLiteralLike(argument)) {
        if (argument.text.startsWith(".")) effects.specifiers.push(argument.text);
        else {
            const module = builtinModule(argument.text);
            if (module !== null) builtinEffect(module, { specifier: argument.text, line: 0, names: [], typeOnly: false, loader: "import" }, effects, false);
            else packageEffect(argument.text, effects);
        }
    } else effects.opaque.push(`vi.${name} non-literal`);
}

function callEffect(ts: typeof TS, node: TS.CallExpression, effects: FileEffects): void {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === "eval") effects.opaque.push("eval");
    if (ts.isIdentifier(callee) && callee.text === "Function") effects.opaque.push("Function constructor");
    moduleLoaderCall(ts, node, effects);
}

/** `import.meta.*` and `require.resolve`: members of something that is not an identifier root. */
function memberEffect(ts: typeof TS, node: TS.PropertyAccessExpression, effects: FileEffects): void {
    const owner = node.expression, member = node.name.text;
    if (ts.isMetaProperty(owner)) {
        if (member === "glob") effects.opaque.push("import.meta.glob");
        else if (CHECKOUT_PATH_META.has(member)) effects.nondeterministic.push(`import.meta.${member}`);
    } else if (ts.isIdentifier(owner) && owner.text === "require" && member === "resolve") effects.opaque.push("require.resolve");
}

/** The identifier is not a value: a type, an import binding, or a signature. */
function nonValueParent(ts: typeof TS, parent: TS.Node): boolean {
    return ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)
        || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
}

/** The identifier names a property or declares a binding rather than reading one. */
function namesSomething(ts: typeof TS, parent: TS.Node, node: TS.Identifier): boolean {
    if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
    const named = ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
        || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent);
    return named && parent.name === node;
}

/** A VALUE reference: not a type, not a property name, not a declaration, object key or import binding. */
function valueReference(ts: typeof TS, node: TS.Identifier): boolean {
    return !nonValueParent(ts, node.parent) && !namesSomething(ts, node.parent, node);
}

interface Chain {
    /** Members read off the root in order; stops at the first computed one. */
    members: string[];
    /** The chain ends in a non-literal element access. */
    computed: boolean;
    /** The first step off the root was `[...]`. */
    firstElement: boolean;
    /** The whole chain is the callee of a call. */
    callee: boolean;
}

/** Climb from a root identifier through `.a`, `["a"]`, `!` and parentheses. */
function accessChain(ts: typeof TS, root: TS.Identifier): Chain {
    const chain: Chain = { members: [], computed: false, firstElement: false, callee: false };
    let top: TS.Node = root;
    for (;;) {
        const parent = top.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === top) chain.members.push(parent.name.text);
        else if (ts.isElementAccessExpression(parent) && parent.expression === top) {
            if (top === root) chain.firstElement = true;
            if (!ts.isStringLiteralLike(parent.argumentExpression)) {
                chain.computed = true;
                break;
            }
            chain.members.push(parent.argumentExpression.text);
        } else if (!ts.isNonNullExpression(parent) && !ts.isParenthesizedExpression(parent)) break;
        top = parent;
    }
    chain.callee = ts.isCallExpression(top.parent) && top.parent.expression === top;
    return chain;
}

function reason(rule: Rule, member: string | null, computed: boolean): string {
    if (rule.fixed !== undefined) return rule.fixed;
    if (member !== null) return rule.dotted ? `${rule.prefix}.${member}` : `${rule.prefix}: ${member}`;
    return `${rule.prefix}: ${rule.bareWord ?? (computed ? "computed" : "escape")}`;
}

/** Judge one chain against its root's rule: pure only when the first member is proven pure. */
function applyRule(rule: Rule, chain: Chain, effects: FileEffects): void {
    const member = chain.members[0] ?? null;
    if (member === null ? rule.bareOk === true : rule.pure.has(member)) return;
    // A direct `vi.mock(...)` / `vi.importActual(...)` call is judged by its literal argument (moduleLoaderCall); only an ESCAPED loader is unknown.
    if (rule === VI_RULE && chain.callee && chain.members.length === 1 && member !== null && MODULE_LOADERS.has(member)) return;
    effects[member !== null && rule.opaque?.has(member) ? "opaque" : rule.kind].push(reason(rule, member, chain.computed));
}

/** `globalThis.Date.now` is `Date.now`; an unlisted member of the global object is state the bytes do not pin. */
function globalObjectEffect(chain: Chain, effects: FileEffects): void {
    const [first, ...rest] = chain.members;
    if (chain.firstElement) effects.opaque.push("computed global access");
    else if (first === undefined) effects.opaque.push("global object escape");
    else if (GLOBAL_RULES.has(first)) applyRule(GLOBAL_RULES.get(first) as Rule, { ...chain, members: rest }, effects);
    else if (!GLOBAL_PURE.has(first)) effects.opaque.push(`globalThis.${first}`);
}

interface FileScope {
    /** Local name → builtin module, for default and namespace imports judged by use. */
    bindings: Map<string, string>;
    /** `specifier@line` of each such import declaration. */
    tracked: Set<string>;
    /** Names the file declares itself (a local `self` or `window` is not the global object). */
    declared: Set<string>;
}

function fileScope(parsed: ParsedTsSource): FileScope {
    const { ts, sf } = parsed;
    const scope: FileScope = { bindings: new Map(), tracked: new Set(), declared: new Set() };
    const visit = (node: TS.Node): void => {
        if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) scope.declared.add(node.name.text);
        ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const statement of sf.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
        const module = builtinModule(statement.moduleSpecifier.text), clause = statement.importClause;
        const local = clause?.name ?? (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name : undefined);
        if (module === null || !local || !MODULE_RULES.has(module)) continue;
        scope.bindings.set(local.text, module);
        scope.tracked.add(`${statement.moduleSpecifier.text}@${sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1}`);
    }
    return scope;
}

function identifierEffect(ts: typeof TS, node: TS.Identifier, scope: FileScope, effects: FileEffects): void {
    if (!valueReference(ts, node)) return;
    const parent = node.parent;
    if (node.text === "require" && !ts.isCallExpression(parent) && !ts.isPropertyAccessExpression(parent)) effects.opaque.push("require escapes");
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === node) return;
    const module = scope.bindings.get(node.text);
    const rule = module !== undefined ? MODULE_RULES.get(module) : GLOBAL_RULES.get(node.text);
    if (rule !== undefined) applyRule(rule, accessChain(ts, node), effects);
    else if (GLOBAL_OBJECTS.has(node.text) && !(SHADOWABLE_GLOBAL_OBJECTS.has(node.text) && scope.declared.has(node.text))) globalObjectEffect(accessChain(ts, node), effects);
}

function syntaxEffects(parsed: ParsedTsSource, scope: FileScope, effects: FileEffects): void {
    const { ts, sf } = parsed;
    const visit = (node: TS.Node): void => {
        if (ts.isCallExpression(node)) callEffect(ts, node, effects);
        else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") effects.opaque.push("Function constructor");
        else if (ts.isPropertyAccessExpression(node)) memberEffect(ts, node, effects);
        if (ts.isIdentifier(node)) identifierEffect(ts, node, scope, effects);
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

const unique = (values: string[]): string[] => [...new Set(values)];

/** Every runtime effect of one parsed module, with the literal relative specifiers it loads. */
export function fileEffects(parsed: ParsedTsSource): FileEffects {
    const effects: FileEffects = { opaque: [], nondeterministic: [], specifiers: [] };
    const scope = fileScope(parsed);
    for (const reference of analyzeSyntax(parsed).imports) importEffect(reference, effects, scope.tracked);
    syntaxEffects(parsed, scope, effects);
    return { opaque: unique(effects.opaque), nondeterministic: unique(effects.nondeterministic), specifiers: unique(effects.specifiers) };
}
