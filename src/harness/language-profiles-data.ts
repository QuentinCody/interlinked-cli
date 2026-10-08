// interlinked-tdd: exempt · @codegen-data — pure data table; the per-file LOC cap targets code complexity (n/a to a logic-free data table; consuming logic lives in language-profiles.ts). tsc/lint still run.
// ===========================================
// Language Profile Data — extension map + per-language profiles
// ===========================================
// Pure data tables extracted from language-profiles.ts: the extension→language
// lookup and the canonical per-language toolchain profiles. No logic lives here;
// the helper functions that consume these tables stay in language-profiles.ts.

import type { LanguageId, LanguageProfile } from "./types.js";

// ===========================================
// Extension → Language fast-lookup table
// ===========================================

/** Maps every known file extension to its LanguageId for O(1) lookup at runtime. */
export const LANGUAGE_EXTENSION_MAP: Record<string, LanguageId> = {
	// TypeScript / JavaScript
	".ts": "typescript",
	".tsx": "typescript",
	".js": "typescript",
	".jsx": "typescript",
	".mjs": "typescript",
	".cjs": "typescript",

	// Python
	".py": "python",
	".pyi": "python",

	// Rust
	".rs": "rust",

	// Go
	".go": "go",

	// C / C++
	".c": "c_cpp",
	".cpp": "c_cpp",
	".cc": "c_cpp",
	".cxx": "c_cpp",
	".h": "c_cpp",
	".hpp": "c_cpp",
	".hxx": "c_cpp",

	// Java
	".java": "java",

	// Swift
	".swift": "swift",

	// GPU / shading languages
	".cu": "cuda",
	".cuh": "cuda",
	".cl": "opencl",
	".metal": "metal",
	".hlsl": "hlsl",
	".wgsl": "wgsl",
};

// ===========================================
// Language Profile Definitions
// ===========================================

/**
 * Canonical language profiles keyed by LanguageId.
 *
 * Each profile declares:
 *  - file extensions and project-root markers for detection
 *  - optional type-checker, linter, and test runner commands
 *  - inline code-quality checks (pattern-based, no external tool)
 */
export const LANGUAGE_PROFILES: Record<LanguageId, LanguageProfile> = {
	// -----------------------------------------
	// TypeScript / JavaScript
	// -----------------------------------------
	typescript: {
		id: "typescript",
		display_name: "TypeScript",
		file_extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		project_root_markers: ["tsconfig.json", "package.json"],
		type_check: {
			command: "npx tsc --noEmit --pretty false",
			append_file: false,
			config_files: ["tsconfig.json"],
			timeout_ms: 15_000,
			severity: "error",
			description: "TypeScript type checker (tsc --noEmit)",
		},
		linter: null, // handled by separate biome/eslint quality checks
		test_runner: {
			command: "npx vitest run",
			timeout_ms: 15_000,
			severity: "error",
			description: "Vitest test runner",
		},
		inline_checks: [], // strong_typing is handled separately in quality-checks.ts
	},

	// -----------------------------------------
	// Python
	// -----------------------------------------
	python: {
		id: "python",
		display_name: "Python",
		file_extensions: [".py", ".pyi"],
		project_root_markers: [
			"pyproject.toml",
            "pytest.ini",
            ".pytest.ini",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
		],
		type_check: {
			command: "python -m mypy --no-error-summary",
			append_file: true,
			config_files: ["mypy.ini", "pyproject.toml", "setup.cfg"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "mypy static type checker",
		},
		linter: {
			command: "ruff check",
			append_file: true,
			config_files: ["ruff.toml", "pyproject.toml", ".ruff.toml"],
			timeout_ms: 5_000,
			severity: "warning",
			description: "Ruff linter",
		},
		test_runner: {
			command: "python -m pytest -x --tb=short -q",
			timeout_ms: 15_000,
			severity: "error",
			description: "pytest test runner",
		},
		inline_checks: [
			{
				name: "python_bare_except",
				description: "Detect bare `except:` without exception type",
				file_types: [".py"],
				severity: "warning",
				fix_instruction: "Catch specific exceptions instead of bare except",
				pattern: "^\\s*except\\s*:",
			},
			{
				name: "python_mutable_default",
				description: "Detect mutable default arguments (def foo(x=[]) or def foo(x={}))",
				file_types: [".py"],
				severity: "warning",
				fix_instruction: "Use None as default and assign mutable in function body",
				// Match =[] or ={} appearing inside a def signature's parens.
				pattern: "def\\s+\\w+\\s*\\([^)]*=\\s*(?:\\[\\s*\\]|\\{\\s*\\})",
			},
		],
	},

	// -----------------------------------------
	// Rust
	// -----------------------------------------
	rust: {
		id: "rust",
		display_name: "Rust",
		file_extensions: [".rs"],
		project_root_markers: ["Cargo.toml"],
		// Note: type_check / linter `command` fields are descriptive metadata
		// only — the real cargo invocation lives in
		// `check-engine/tool-runners/rust.ts` (runCargoCheck / runCargoClippy)
		// and already uses `--message-format=json` parsed by parseCargoJson.
		// Keep this string aligned with the runner's argv so the two surfaces
		// don't drift in `interlinked harness status` / docs output.
		type_check: {
			command: "cargo check --message-format=json",
			append_file: false,
			config_files: ["Cargo.toml"],
			timeout_ms: 30_000,
			severity: "error",
			description: "cargo check (type and borrow checker, NDJSON output)",
		},
		linter: {
			command: "cargo clippy --message-format=json -- -W clippy::all",
			append_file: false,
			config_files: ["Cargo.toml"],
			timeout_ms: 30_000,
			severity: "warning",
			description: "Clippy lint suite (NDJSON output, parsed by parseCargoJson)",
		},
		test_runner: {
			command: "cargo test --no-run",
			timeout_ms: 30_000,
			severity: "error",
			description: "cargo test (compile-only, no execution)",
		},
		inline_checks: [
			{
				name: "rust_unsafe_blocks",
				description: "Detect `unsafe {` or `unsafe fn` blocks",
				file_types: [".rs"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction: "Document safety invariants with // SAFETY: comment",
				// `unsafe {` or `unsafe fn`. Word boundary prevents matching `unsafety`
				// and similar identifiers.
				pattern: "\\bunsafe\\s+(?:\\{|fn\\b)",
				// Allow documented unsafe blocks — previous line contains `SAFETY:`
				// comment or current line is preceded by one.
				exempt_if_line_matches: "//\\s*SAFETY:",
			},
			{
				name: "rust_unwrap_usage",
				description: "Detect .unwrap() in non-test code",
				file_types: [".rs"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction: "Use .expect() with a message or handle the error with ?",
				pattern: "\\.unwrap\\s*\\(\\s*\\)",
			},
			{
				name: "rust_todo_macro",
				description: "Detect todo!() or unimplemented!() macros",
				file_types: [".rs"],
				severity: "warning",
				fix_instruction: "Replace with actual implementation or proper error handling",
				pattern: "\\b(?:todo|unimplemented)!\\s*\\(",
			},
			{
				name: "rust_panic_in_lib",
				description: "Detect panic!() in non-test code — rarely intentional in library code",
				file_types: [".rs"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Return Result<T, E> with a meaningful error variant instead of panicking. " +
					"If this is genuinely unrecoverable, document why with a comment.",
				// `panic!(` with word boundary so we don't match identifiers like
				// `my_panic!` or `panicking`.
				pattern: "\\bpanic!\\s*\\(",
			},
			{
				name: "rust_expect_empty_msg",
				description: "Detect `.expect(\"\")` — empty message is .unwrap() with extra steps",
				file_types: [".rs"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Provide a descriptive message in .expect(\"reason this can't be None/Err\"), " +
					"or use ? to propagate the error.",
				// `.expect("")` or `.expect( "" )` — empty string content (no chars
				// at all between matching quotes). Allow single or double quotes.
				pattern: "\\.expect\\s*\\(\\s*(?:\"\"|'')\\s*\\)",
			},
			{
				name: "rust_box_dyn_error_in_pub_return",
				description:
					"Detect `pub fn ... -> Result<_, Box<dyn Error>>` — primitive error type in public API",
				file_types: [".rs"],
				severity: "warning",
				fix_instruction:
					"Define a typed error enum with thiserror or anyhow::Error for downstream consumers. " +
					"Box<dyn Error> erases information callers need to handle specific failures.",
				// `pub fn <ident>(...) -> Result<_, Box<dyn Error...`. The `[^,>]+`
				// captures the Ok type up to the comma; `[^{]*` lets the signature
				// span typed parameters and trait bounds on the same line.
				pattern:
					"pub\\s+fn\\s+\\w+[^{]*->\\s*Result\\s*<[^,>]+,\\s*Box\\s*<\\s*dyn\\s+Error",
			},
			{
				name: "rust_dbg_macro",
				description: "Detect `dbg!()` — debug print left in code",
				file_types: [".rs"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Remove the dbg!() call. Use `tracing` / `log` macros if you need observability, " +
					"or `eprintln!` for one-off debugging — then clean up before committing.",
				// `dbg!(` with word boundary. Matches `dbg!()` and `dbg!(value)`.
				pattern: "\\bdbg!\\s*\\(",
			},
		],
	},

	// -----------------------------------------
	// Go
	// -----------------------------------------
	go: {
		id: "go",
		display_name: "Go",
		file_extensions: [".go"],
		project_root_markers: ["go.mod"],
		type_check: {
			command: "go build ./...",
			append_file: false,
			config_files: ["go.mod"],
			timeout_ms: 15_000,
			severity: "error",
			description: "go build (compile check)",
		},
		linter: {
			command: "golangci-lint run",
			append_file: false,
			config_files: ["go.mod", ".golangci.yml", ".golangci.yaml"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "golangci-lint meta-linter",
		},
		test_runner: {
			command: "go test ./...",
			timeout_ms: 15_000,
			severity: "error",
			description: "go test runner",
		},
		inline_checks: [
			{
				name: "go_error_ignored",
				description: "Detect ignored errors (err assigned to _ or discarded)",
				file_types: [".go"],
				severity: "warning",
				fix_instruction: "Handle errors explicitly \u2014 don't discard with _",
				pattern: "^\\s*(?:_\\s*,\\s*_|[a-zA-Z_][a-zA-Z_0-9]*\\s*,\\s*_|_)\\s*(?::?=)",
			},
		],
	},

	// -----------------------------------------
	// C / C++
	// -----------------------------------------
	c_cpp: {
		id: "c_cpp",
		display_name: "C/C++",
		file_extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
		project_root_markers: ["CMakeLists.txt", "Makefile", "meson.build", "configure.ac"],
		type_check: {
			command: "make",
			append_file: false,
			config_files: ["Makefile", "CMakeLists.txt"],
			timeout_ms: 30_000,
			severity: "error",
			description: "make (compile check)",
		},
		linter: {
			command: "clang-tidy",
			append_file: true,
			config_files: [".clang-tidy"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "clang-tidy static analyzer",
		},
		test_runner: {
			command: "ctest --output-on-failure",
			timeout_ms: 30_000,
			severity: "error",
			description: "CTest runner",
		},
		inline_checks: [
			{
				name: "c_unsafe_functions",
				description:
					"Detect unsafe C functions: strcpy, strcat, gets, sprintf (not snprintf)",
				file_types: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
				severity: "warning",
				fix_instruction: "Use safer alternatives: strncpy, strncat, fgets, snprintf",
				pattern: "\\b(?:strcpy|strcat|gets|sprintf)\\s*\\(",
			},
			{
				name: "c_include_guard",
				description: "Detect header files missing #pragma once or #ifndef guard",
				file_types: [".h", ".hpp", ".hxx"],
				severity: "warning",
				fix_instruction: "Add #pragma once or include guard",
				// Header-guard check is absence-of-pattern; runner handles specially.
				pattern: "__C_INCLUDE_GUARD_NEVER_MATCH__",
			},
		],
	},

	// -----------------------------------------
	// Java
	// -----------------------------------------
	java: {
		id: "java",
		display_name: "Java",
		file_extensions: [".java"],
		project_root_markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
		type_check: null, // compile check via build tool is too slow for per-edit
		linter: null, // checkstyle is heavy; rely on inline checks
		test_runner: null, // mvn test / gradle test too slow for per-edit
		inline_checks: [
			{
				name: "java_wildcard_import",
				description: "Detect wildcard imports (import .*.*)",
				file_types: [".java"],
				severity: "warning",
				fix_instruction: "Use explicit imports instead of wildcards",
				pattern: "^\\s*import\\s+(?:static\\s+)?[\\w.]+\\.\\*;",
			},
			{
				name: "java_system_exit",
				description: "Detect System.exit() calls in non-main files",
				file_types: [".java"],
				severity: "warning",
				fix_instruction: "Throw an exception instead of calling System.exit()",
				pattern: "\\bSystem\\.exit\\s*\\(",
			},
		],
	},
	// -----------------------------------------
	// Swift
	// -----------------------------------------
	swift: {
		id: "swift",
		display_name: "Swift",
		file_extensions: [".swift"],
		project_root_markers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
		type_check: {
			command: "swift build --skip-update 2>&1",
			append_file: false,
			config_files: ["Package.swift"],
			timeout_ms: 30_000,
			severity: "error",
			description: "swift build (SPM type/compile check)",
		},
		linter: {
			command: "swiftlint lint --quiet --reporter json",
			append_file: true,
			config_files: [".swiftlint.yml", ".swiftlint.yaml"],
			timeout_ms: 10_000,
			severity: "warning",
			description: "SwiftLint linter",
		},
		test_runner: {
			command: "swift test --skip-build",
			timeout_ms: 30_000,
			severity: "error",
			description: "swift test runner",
		},
		inline_checks: [
			// --- Apple API Design Guidelines ---
			{
				name: "swift_force_cast",
				description: "Detect force casts (as!) — runtime crash risk",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Use conditional cast (as?) with optional binding instead of force cast (as!)",
				pattern: "\\bas\\s*!",
			},
			{
				name: "swift_force_try",
				description: "Detect force try (try!) — runtime crash risk",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction: "Use do/catch or try? instead of try!",
				pattern: "\\btry\\s*!",
			},
			{
				name: "swift_force_unwrap",
				description: "Detect force unwrap (!) on optionals — runtime crash risk",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Use optional binding (if let/guard let) or nil-coalescing (??) instead of force unwrap",
				pattern: "[A-Za-z_][A-Za-z0-9_\\])\\]]*!(?![=!])",
			},
			{
				name: "swift_implicitly_unwrapped_optional",
				description: "Detect implicitly unwrapped optionals (Type!) outside @IBOutlet",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Use regular optionals (Type?) with proper unwrapping instead of implicitly unwrapped optionals",
				pattern: ":\\s*[A-Z][A-Za-z0-9_<>?]*!",
				exempt_if_line_matches: "@IBOutlet",
			},
			// --- Memory Safety (Apple Swift Book) ---
			{
				name: "swift_delegate_not_weak",
				description: "Detect delegate properties not declared as weak — retain cycle risk",
				file_types: [".swift"],
				severity: "warning",
				fix_instruction:
					"Declare delegate properties as weak: `weak var delegate: SomeDelegate?`",
				pattern: "^(?!\\s*weak\\s)\\s*var\\s+\\w*[dD]elegate\\b",
			},
			{
				name: "swift_legacy_random",
				description: "Detect legacy arc4random() usage — use modern Swift random APIs",
				file_types: [".swift"],
				severity: "warning",
				fix_instruction:
					"Use Int.random(in:), Bool.random(), or Collection.randomElement() instead of arc4random",
				pattern: "\\barc4random(?:_uniform)?\\s*\\(",
			},
			{
				name: "swift_legacy_hashvalue",
				description: "Detect legacy hashValue implementation — use hash(into:) instead",
				file_types: [".swift"],
				severity: "warning",
				fix_instruction:
					"Implement hash(into hasher: inout Hasher) instead of var hashValue: Int",
				pattern: "\\bvar\\s+hashValue\\s*:\\s*Int",
			},
		],
	},
	// -----------------------------------------
	// CUDA (.cu / .cuh)
	// -----------------------------------------
	// CUDA files mix host (CPU) and device (GPU) code. We deliberately ship
	// no type_check / linter — nvcc availability is too brittle for a
	// default-on check, and clang's CUDA mode requires the toolkit. The
	// inline checks below catch a few common foot-guns that don't need
	// nvcc to flag.
	cuda: {
		id: "cuda",
		display_name: "CUDA",
		file_extensions: [".cu", ".cuh"],
		project_root_markers: ["CMakeLists.txt", "Makefile"],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks: [
			{
				// Advisory: any kernel launch should be followed by an error
				// check (cudaGetLastError / cudaPeekAtLastError). We can't
				// see "followed by" without lookahead beyond a single line,
				// so we fire on every launch and rely on the agent (or a
				// human reviewer) to confirm a check exists nearby. Heuristic.
				name: "cuda_kernel_launch_unchecked",
				description:
					"CUDA kernel launch — pair with `cudaGetLastError()` to catch launch failures",
				file_types: [".cu", ".cuh"],
				severity: "warning",
				fix_instruction:
					"After every `kernel<<<grid, block>>>(...)` launch, call `cudaGetLastError()` " +
					"(non-blocking) or `cudaDeviceSynchronize()` + error check (blocking). " +
					"Kernel-launch failures are otherwise silent until the next CUDA API call.",
				// `<<<...>>>(...);` — the triple-angle-bracket execution
				// configuration syntax is unique to CUDA, so this is highly
				// CUDA-specific. `[^<>]+` forbids nested angle brackets to
				// avoid catastrophic backtracking on template-heavy code.
				pattern: "<<<[^<>]+>>>\\s*\\([^)]*\\)\\s*;",
			},
			{
				name: "cuda_device_synchronize_debug",
				description: "`cudaDeviceSynchronize()` — often a debug leftover, prefer per-stream sync",
				file_types: [".cu", ".cuh"],
				severity: "warning",
				fix_instruction:
					"Replace global `cudaDeviceSynchronize()` with `cudaStreamSynchronize(stream)` " +
					"to avoid serializing across all streams. If global sync is intentional " +
					"(e.g. shutdown, debugging), add a comment explaining why.",
				pattern: "\\bcudaDeviceSynchronize\\s*\\(\\s*\\)",
			},
			{
				// Advisory: `printf` is fine in __host__ functions but very
				// expensive in __device__/__global__ code (uses GPU printf
				// buffer, can serialize the warp). Single-regex can't tell
				// host from device context, so this surfaces every printf
				// in a .cu/.cuh file. Heuristic.
				name: "cuda_printf_in_device_code",
				description: "`printf()` in CUDA file — expensive if called from device code",
				file_types: [".cu", ".cuh"],
				severity: "warning",
				fix_instruction:
					"In __device__/__global__ code, prefer copying data back to host before printing, " +
					"or guard with `if (threadIdx.x == 0 && blockIdx.x == 0)` to limit output volume. " +
					"In __host__ code, this is fine — the check fires across the whole .cu file " +
					"and cannot distinguish host from device context.",
				pattern: "\\bprintf\\s*\\(",
			},
			{
				// `if/while/for/switch` on the same line as `__syncthreads()` is
				// a classic CUDA deadlock — threads that don't enter the branch
				// never reach the barrier, hanging the warp. The single-line
				// regex catches the common idiom; multi-line conditionals are
				// missed (acceptable — those are rarer and need AST anyway).
				name: "cuda_syncthreads_in_conditional",
				description:
					"`__syncthreads()` inside a single-line conditional — divergent threads cause deadlock",
				file_types: [".cu", ".cuh"],
				severity: "warning",
				fix_instruction:
					"Move `__syncthreads()` outside the conditional so every thread in the block " +
					"reaches the barrier. Divergent paths to a barrier deadlock the warp.",
				pattern: "\\b(?:if|while|for|switch)\\s*\\([^)]*\\)[^{]*__syncthreads\\s*\\(",
			},
		],
	},
	// -----------------------------------------
	// OpenCL (.cl) — stub
	// -----------------------------------------
	// Recognized so files route to the right LanguageId, but no inline
	// checks yet. Add anti-patterns here when there's a concrete bug class
	// worth gating on.
	opencl: {
		id: "opencl",
		display_name: "OpenCL",
		file_extensions: [".cl"],
		project_root_markers: ["CMakeLists.txt", "Makefile"],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks: [],
	},
	// -----------------------------------------
	// Apple Metal (.metal) — stub
	// -----------------------------------------
	metal: {
		id: "metal",
		display_name: "Metal Shading Language",
		file_extensions: [".metal"],
		project_root_markers: ["Package.swift", "*.xcodeproj"],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks: [],
	},
	// -----------------------------------------
	// HLSL (.hlsl) — stub
	// -----------------------------------------
	hlsl: {
		id: "hlsl",
		display_name: "HLSL",
		file_extensions: [".hlsl"],
		project_root_markers: ["CMakeLists.txt", "Makefile"],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks: [],
	},
	// -----------------------------------------
	// WGSL (.wgsl) — stub
	// -----------------------------------------
	wgsl: {
		id: "wgsl",
		display_name: "WGSL",
		file_extensions: [".wgsl"],
		project_root_markers: ["Cargo.toml", "package.json"],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks: [],
	},
};
