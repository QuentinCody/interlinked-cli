// interlinked-tdd: exempt
// @codegen-data — embedded Python program, part 1 of 2 (joined in check-python-script.ts).
// Data only; behaviour is tested through check-python-run.test.ts and check-python-imports.test.ts.
// Parsing, per-file summaries, tree index and resolution-root discovery. Standard
// library `ast` only; the analysed source is read as bytes and never imported or run.
// Keep backticks and dollar-brace sequences out of this text: it is a template literal.

export const PYTHON_PARSE_PART = String.raw`
import ast
import configparser
import hashlib
import io
import json
import os
import posixpath
import re
import stat
import sys
import tokenize
import warnings

if sys.version_info < (3, 8):
    sys.stdout.write(json.dumps({"unsupported": sys.version.split()[0]}))
    sys.exit(0)

MAX_FILE_BYTES = 3 * 1024 * 1024
MAX_PY_FILES = 40000
LIST_CAP = 60
STATEMENT_CAP = 400
CANDIDATE_CAP = 3000
MIN_DUPLICATE_NODES = 40
PRUNE_DIRS = {".git", "node_modules", "__pycache__", ".venv", ".tox", ".nox", ".eggs", ".mypy_cache", "site-packages"}
GUARD_EXCEPTIONS = {"ImportError", "ModuleNotFoundError", "Exception", "BaseException"}
EXT_SUFFIXES = (".pyx", ".pxd", ".so", ".pyd", ".pyc", ".dylib")
DYNAMIC_TEXT = ("globals()", "sys.modules[", "setattr(", "exec(", "vars(", ".__dict__.update")
PATH_TEXT = re.compile(r"\b__path__\b")
SYS_PATH_EDIT = re.compile(r"\bsys\.path\s*(\.\s*(insert|append|extend)\b|\+=|\[)|\baddsitedir\b|\bPYTHONPATH\b")
OWNER_IGNORE = re.compile(r"#\s*(pyright|type)\s*:\s*ignore\b")
GENERATED_NAME = re.compile(r"(_pb2|_pb2_grpc)$|^(_version|version)$")
MANIFESTS = ("pyproject.toml", "setup.py", "setup.cfg")
NATIVE_BUILD_NAMES = ("CMakeLists.txt", "Cargo.toml", "meson.build", "binding.gyp")
NATIVE_SOURCE_SUFFIXES = (".pyx", ".c", ".cc", ".cpp", ".cxx", ".rs")
DECLARING_NAMES = ("pytest.ini", "tox.ini", "setup.cfg", "setup.py", "pytest.toml", ".pytest.toml", "meson.build")
STDLIB_NAMES = frozenset(getattr(sys, "stdlib_module_names", ()))
DECLARING_SUFFIXES = (".pth", ".egg-link")
DECLARATION_READ_BYTES = 1024 * 1024

warnings.simplefilter("ignore")
sys.setrecursionlimit(6000)


class Skip(Exception):
    """A potential defect that is counted under a named reason and never reported."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class Context:
    __slots__ = ("guarded", "type_only", "in_function", "version_guard")

    def __init__(self, guarded=False, type_only=False, in_function=False, version_guard=False):
        self.guarded = guarded
        self.type_only = type_only
        self.in_function = in_function
        self.version_guard = version_guard

    def but(self, **changes):
        values = {name: getattr(self, name) for name in self.__slots__}
        values.update(changes)
        return Context(**values)


# --- per-file analysis -------------------------------------------------------------------


def handler_catches(handler):
    node = handler.type
    if node is None:
        return True
    candidates = node.elts if isinstance(node, ast.Tuple) else [node]
    for item in candidates:
        if isinstance(item, ast.Name) and item.id in GUARD_EXCEPTIONS:
            return True
        if isinstance(item, ast.Attribute) and item.attr in GUARD_EXCEPTIONS:
            return True
    return False


def is_type_checking(test):
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING")


def is_version_guard(test):
    for node in ast.walk(test):
        if isinstance(node, ast.Attribute) and node.attr in ("version_info", "platform") and isinstance(node.value, ast.Name) and node.value.id == "sys":
            return True
        if isinstance(node, ast.Attribute) and node.attr == "name" and isinstance(node.value, ast.Name) and node.value.id == "os":
            return True
    return False


def is_main_guard(test):
    if not isinstance(test, ast.Compare) or not isinstance(test.left, ast.Name) or test.left.id != "__name__":
        return False
    return any(isinstance(item, ast.Constant) and item.value == "__main__" for item in test.comparators)


def collect_imports(stmts, ctx, out):
    """Record every import statement with the context it sits in. Function bodies reset the guard."""
    for stmt in stmts:
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            out.append((stmt, ctx))
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            collect_imports(stmt.body, ctx.but(in_function=True, guarded=False), out)
        elif isinstance(stmt, ast.ClassDef):
            collect_imports(stmt.body, ctx, out)
        elif isinstance(stmt, ast.If):
            inner = ctx.but(version_guard=True) if is_version_guard(stmt.test) else ctx
            collect_imports(stmt.body, inner.but(type_only=True) if is_type_checking(stmt.test) else inner, out)
            collect_imports(stmt.orelse, inner, out)
        elif isinstance(stmt, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            guarded = ctx.guarded or any(handler_catches(handler) for handler in stmt.handlers)
            collect_imports(stmt.body, ctx.but(guarded=guarded), out)
            for handler in stmt.handlers:
                collect_imports(handler.body, ctx, out)
            collect_imports(stmt.orelse, ctx, out)
            collect_imports(stmt.finalbody, ctx, out)
        elif isinstance(stmt, (ast.With, ast.AsyncWith, ast.For, ast.AsyncFor, ast.While)):
            collect_imports(stmt.body, ctx, out)
            collect_imports(getattr(stmt, "orelse", []), ctx, out)
        elif hasattr(ast, "Match") and isinstance(stmt, ast.Match):
            for case in stmt.cases:
                collect_imports(case.body, ctx, out)


def literal_strings(node):
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [item.value for item in node.elts if isinstance(item, ast.Constant) and isinstance(item.value, str)]
    if isinstance(node, ast.BinOp):
        return literal_strings(node.left) + literal_strings(node.right)
    return []


class Bindings:
    """Module-scope bindings: never descends into function or class bodies."""

    def __init__(self):
        self.names = set()
        self.star = False

    def add_import(self, node):
        for alias in node.names:
            if alias.name == "*":
                self.star = True
            elif alias.asname:
                self.names.add(alias.asname)
            elif isinstance(node, ast.Import):
                self.names.add(alias.name.split(".")[0])
            else:
                self.names.add(alias.name)

    def walrus_only(self, node):
        for child in ast.walk(node):
            if isinstance(child, ast.NamedExpr) and isinstance(child.target, ast.Name):
                self.names.add(child.target.id)

    def visit(self, node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            self.names.add(node.name)
            for item in getattr(node, "decorator_list", []):
                self.walrus_only(item)
            return
        if isinstance(node, ast.Lambda):
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            self.walrus_only(node)
            return
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            self.add_import(node)
            return
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            self.names.add(node.id)
        for field in ("name", "rest"):
            value = getattr(node, field, None)
            if isinstance(value, str) and type(node).__name__.startswith("Match"):
                self.names.add(value)
        if isinstance(node, ast.Global):
            self.names.update(node.names)
        for child in ast.iter_child_nodes(node):
            self.visit(child)


def all_names(tree):
    found = []
    for stmt in ast.walk(tree):
        targets = []
        if isinstance(stmt, ast.Assign):
            targets = stmt.targets
        elif isinstance(stmt, (ast.AugAssign, ast.AnnAssign)):
            targets = [stmt.target]
        if any(isinstance(target, ast.Name) and target.id == "__all__" for target in targets) and getattr(stmt, "value", None) is not None:
            found.extend(literal_strings(stmt.value))
        elif isinstance(stmt, ast.Call) and isinstance(stmt.func, ast.Attribute) and stmt.func.attr in ("extend", "append"):
            if isinstance(stmt.func.value, ast.Name) and stmt.func.value.id == "__all__":
                for arg in stmt.args:
                    found.extend(literal_strings(arg) + ([arg.value] if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else []))
    return found


def global_declared(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Global):
            names.update(node.names)
    return names


def decode(data):
    try:
        encoding = tokenize.detect_encoding(io.BytesIO(data).readline)[0]
    except (SyntaxError, LookupError):
        encoding = "utf-8"
    return data.decode(encoding, errors="replace")


TYPING_MODULES = ("typing", "typing_extensions")


def annotations_of(tree):
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.append(node.returns)
            args = node.args
            for arg in args.posonlyargs + args.args + args.kwonlyargs + [args.vararg, args.kwarg]:
                if arg is not None:
                    found.append(arg.annotation)
        elif isinstance(node, ast.AnnAssign):
            found.append(node.annotation)
    return [item for item in found if item is not None]


def any_annotation_lines(tree):
    """One line number per explicit typing.Any inside an annotation (parameter, return, annotated assignment)."""
    any_names = set()
    module_aliases = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module in TYPING_MODULES:
            any_names.update(alias.asname or "Any" for alias in node.names if alias.name == "Any")
        elif isinstance(node, ast.Import):
            module_aliases.update(alias.asname or alias.name for alias in node.names if alias.name in TYPING_MODULES)
    if not any_names and not module_aliases:
        return []
    lines = []
    for annotation in annotations_of(tree):
        for item in ast.walk(annotation):
            if isinstance(item, ast.Name) and item.id in any_names:
                lines.append(item.lineno)
            elif isinstance(item, ast.Attribute) and item.attr == "Any" and isinstance(item.value, ast.Name) and item.value.id in module_aliases:
                lines.append(item.lineno)
    return lines


def without_docstring(body):
    first = body[0] if body else None
    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
        return body[1:]
    return body


def function_fingerprints(tree):
    """(hash, node count, qualified name, line) per function whose parameters and body are big enough to compare."""
    found = []

    def visit(node, scope):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qualified = scope + [child.name]
                body = without_docstring(child.body)
                weight = sum(1 for stmt in body for _ in ast.walk(stmt))
                dunder = child.name.startswith("__") and child.name.endswith("__")
                if weight >= MIN_DUPLICATE_NODES and not dunder:
                    text = type(child).__name__ + ast.dump(child.args) + "|".join(ast.dump(stmt) for stmt in body)
                    found.append((hashlib.sha1(text.encode("utf-8")).hexdigest()[:16], weight, ".".join(qualified), child.lineno))
                visit(child, qualified)
            elif isinstance(child, ast.ClassDef):
                visit(child, scope + [child.name])
            else:
                visit(child, scope)

    visit(tree, [])
    return found


def analyse_file(data, is_test=False):
    """Parse bytes; return a summary dict. Raises on a parse failure (the caller records it as unparsed)."""
    tree = ast.parse(data)
    text = decode(data)
    lines = text.splitlines()
    bindings = Bindings()
    for stmt in tree.body:
        bindings.visit(stmt)
    bindings.names.update(global_declared(tree))
    bindings.names.update(all_names(tree))
    imports = []
    collect_imports(tree.body, Context(), imports)
    dynamic = [token for token in DYNAMIC_TEXT if token in text]
    if PATH_TEXT.search(text):
        dynamic.append("__path__")
    summary = {
        "names": bindings.names,
        "star": bindings.star,
        "getattr": "__getattr__" in bindings.names,
        "dynamic": dynamic,
        "imports": imports,
        "main_guard": any(isinstance(stmt, ast.If) and is_main_guard(stmt.test) for stmt in tree.body),
        "sys_path_edit": bool(SYS_PATH_EDIT.search(text)),
        "any_lines": any_annotation_lines(tree),
        "functions": function_fingerprints(tree),
        "dead": unused_imports(imports, used_names(tree, lines, is_test), lines, text),
    }
    if GRAPH_MODE:
        summary.update(graph_facts(tree))
    return summary


# --- tree index and resolution roots -------------------------------------------------------


def strings_of(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    if isinstance(value, dict):
        return [item for item in value.values() if isinstance(item, str)]
    return []


def section(data, *keys):
    for key in keys:
        data = data.get(key) if isinstance(data, dict) else None
    return data


class Tree:
    def __init__(self, root):
        self.root = root
        self.real_root = os.path.realpath(root)
        self.listing = {}
        self.has_py = set()
        self.py_files = []
        self.roots = {".": "."}
        self.project_dirs = set()
        self.conftest_dirs = set()
        self.manifests = []
        self.native_build = False
        self.native_paths = set()
        self.files_truncated = False
        self.pyproject_unread = 0
        self.aliases = set()
        self.declared = []
        self.egg_info_parents = set()

    def abs(self, rel):
        return self.root if rel in ("", ".") else os.path.join(self.root, *rel.split("/"))

    def entries(self, rel):
        """name -> 'dir' | 'file' for one directory, exact case. A symlink that leaves the repo lists as empty."""
        cached = self.listing.get(rel)
        if cached is not None:
            return cached
        found = {}
        try:
            if not (os.path.realpath(self.abs(rel)) + os.sep).startswith(self.real_root + os.sep):
                raise OSError("outside_root")
            with os.scandir(self.abs(rel)) as scan:
                for entry in scan:
                    try:
                        is_dir = entry.is_dir(follow_symlinks=True)
                    except OSError:
                        is_dir = False
                    found[entry.name] = "dir" if is_dir else "file"
        except OSError:
            found = {}
        self.listing[rel] = found
        return found

    def is_dir(self, rel):
        if rel == ".":
            return True
        return self.entries(posixpath.dirname(rel) or ".").get(posixpath.basename(rel)) == "dir"

    def directories(self, listed):
        """(directory, file names) pairs. From the git file list when given; else a walk that skips dot-directories."""
        if listed is None:
            for current, dirs, files in os.walk(self.root, followlinks=False):
                rel = os.path.relpath(current, self.root).replace(os.sep, "/")
                rel = "." if rel == "." else rel
                if "pyvenv.cfg" in files and rel != ".":
                    dirs[:] = []
                    continue
                dirs[:] = sorted(name for name in dirs if name not in PRUNE_DIRS and not name.startswith("."))
                self.listing[rel] = {**{name: "dir" for name in dirs}, **{name: "file" for name in files}}
                yield rel, files
            return
        grouped = {}
        for path in listed:
            parts = path.split("/")
            if not any(part in PRUNE_DIRS for part in parts[:-1]):
                grouped.setdefault("/".join(parts[:-1]) or ".", []).append(parts[-1])
        for rel in list(grouped):
            parent = posixpath.dirname(rel)
            while rel != ".":
                rel = parent or "."
                parent = posixpath.dirname(rel)
                grouped.setdefault(rel, [])
        for rel in sorted(grouped):
            yield rel, grouped[rel]

    def walk(self, listed=None):
        for rel, files in self.directories(listed):
            # A directory that is itself a package is never an import root: Python imports a package from the
            # directory above it, and its sub-packages are reached through the package.
            is_package = rel != "." and "__init__.py" in files
            # In a package, setup.py and setup.cfg are modules (modal_dojo/cli/setup.py is a CLI command), not
            # build files; a pyproject.toml there belongs to the project whose import root is the directory above.
            manifests_here = [name for name in MANIFESTS if name in files and (not is_package or name == "pyproject.toml")]
            if manifests_here:
                home = (posixpath.dirname(rel) or ".") if is_package else rel
                self.roots[home] = home
                self.project_dirs.add(home)
            if posixpath.basename(rel) == "src" and not is_package:
                self.roots.setdefault(rel, posixpath.dirname(rel) or ".")
            for name in manifests_here:
                self.manifests.append(posixpath.join(rel, name) if rel != "." else name)
            if "conftest.py" in files:
                self.conftest_dirs.add(rel)
            if rel.endswith(".egg-info"):
                self.egg_info_parents.add(posixpath.dirname(rel) or ".")
            for name in files:
                if name in DECLARING_NAMES or name.endswith(DECLARING_SUFFIXES):
                    self.declared.append(posixpath.join(rel, name) if rel != "." else name)
            if any(name in files for name in NATIVE_BUILD_NAMES) or any(name.endswith(NATIVE_SOURCE_SUFFIXES) for name in files):
                self.native_build = True
            for name in sorted(files):
                if name.endswith(".py"):
                    if len(self.py_files) >= MAX_PY_FILES:
                        self.files_truncated = True
                        break
                    self.py_files.append(posixpath.join(rel, name) if rel != "." else name)
                    parent = rel
                    while True:
                        self.has_py.add(parent)
                        if parent == ".":
                            break
                        parent = posixpath.dirname(parent) or "."
        self.add_pyproject_roots()

    def read_declaration(self, rel):
        """Bytes of a declaring file (size bound), or None when it cannot be read."""
        try:
            info = os.lstat(self.abs(rel))
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > DECLARATION_READ_BYTES:
                return None
            with open(self.abs(rel), "rb") as handle:
                return handle.read()
        except OSError:
            return None

    def declare_roots(self, base, values, scope):
        """Directories that a static file names, relative to the base directory; only existing directories inside the repository count."""
        for value in values:
            if posixpath.isabs(value):
                prefix = self.real_root + os.sep
                if not value.startswith(prefix) and not value.startswith(self.root + os.sep):
                    continue
                value = os.path.relpath(value, self.real_root if value.startswith(prefix) else self.root).replace(os.sep, "/")
            joined = posixpath.normpath(posixpath.join(base, value))
            if joined.startswith("..") or posixpath.isabs(joined) or not self.is_dir(joined):
                continue
            self.roots.setdefault(joined, scope)

    def add_toml_roots(self, rel, values_of, scope, tomllib, natives_of=None):
        if tomllib is None:
            self.pyproject_unread += 1
            return
        try:
            with open(self.abs(rel), "rb") as handle:
                document = tomllib.load(handle)
            dirs, aliases = values_of(document)
            natives = natives_of(document) if natives_of else []
        except (OSError, ValueError, UnicodeError):
            self.pyproject_unread += 1
            return
        self.declare_roots(posixpath.dirname(rel) or ".", dirs, scope)
        self.aliases.update(aliases)
        self.add_native(natives)

    def add_native(self, names):
        """Dotted module names that a build file names as native extensions, kept as path stems (a.b._x -> a/b/_x)."""
        for name in names:
            if isinstance(name, str) and all(part.isidentifier() for part in name.split(".")):
                self.native_paths.add(name.replace(".", "/"))

    def add_cffi_sources(self, base, builders):
        for builder in builders:
            data = self.read_declaration(posixpath.normpath(posixpath.join(base, builder)))
            if data is not None:
                self.add_native(set_source_names(data))

    def add_pyproject_roots(self):
        try:
            import tomllib
        except ImportError:
            tomllib = None
        for manifest in self.manifests:
            if posixpath.basename(manifest) == "pyproject.toml":
                base = posixpath.dirname(manifest) or "."
                self.add_toml_roots(manifest, pyproject_dirs, base, tomllib, native_names_pyproject)
        for rel in sorted(self.declared):
            base = posixpath.dirname(rel) or "."
            name = posixpath.basename(rel)
            data = None if name in ("pytest.toml", ".pytest.toml") else self.read_declaration(rel)
            if name in ("pytest.toml", ".pytest.toml"):
                self.add_toml_roots(rel, lambda doc: (strings_of(section(doc, "pytest", "pythonpath")), []), base, tomllib)
            elif data is None:
                continue
            elif name in ("pytest.ini", "tox.ini", "setup.cfg"):
                dirs, aliases = cfg_dirs(name, decode(data))
                self.declare_roots(base, dirs, base)
                self.aliases.update(aliases)
            elif name == "setup.py":
                dirs, aliases = setup_call_dirs(data)
                self.declare_roots(base, dirs, base)
                self.aliases.update(aliases)
                natives, builders = setup_native(data)
                self.add_native(natives)
                self.add_cffi_sources(base, builders)
            elif name == "meson.build":
                self.add_native(meson_native_names(decode(data)))
            elif name.endswith(".pth"):
                self.declare_roots(base, path_lines(decode(data)), self.project_of(base))
            elif name.endswith(".egg-link"):
                self.declare_roots(base, path_lines(decode(data))[:1], self.project_of(base))
        for parent in sorted(self.egg_info_parents):
            if parent != ".":
                self.roots.setdefault(parent, self.project_of(parent))

    def project_of(self, directory):
        """Nearest directory at or above this one that holds a manifest; the repository root when none does."""
        while directory != "." and directory not in self.project_dirs:
            directory = posixpath.dirname(directory) or "."
        return directory

    def roots_for(self, importer, role, main_guard):
        """(roots, own roots) that hold for this importer. A project root serves only importers inside its project;
        a root scoped to the repository root serves only importers that sit in no nested project. The own roots
        are the ones that hold for this importer alone (pytest conftest, own directory, test base directory);
        they are first on sys.path, so they are the only ones that can shadow a standard-library name."""
        directory = posixpath.dirname(importer) or "."
        project = self.project_of(directory)
        found = set()
        for root, scope in self.roots.items():
            inside = scope == "." or directory == scope or directory.startswith(scope + "/")
            if inside and (scope != "." or project == "."):
                found.add(root)
        extra = set()
        for conftest_dir in self.conftest_dirs:
            if conftest_dir == "." or directory == conftest_dir or directory.startswith(conftest_dir + "/"):
                extra.add(conftest_dir)
        # pytest puts the first directory above the package chain on sys.path for each module it collects
        # (test_*.py, *_test.py, conftest.py); a helper script in a tests package is not collected.
        if role == "test" and is_collected_by_pytest(importer):
            base = directory
            while base != "." and self.entries(base).get("__init__.py") == "file":
                base = posixpath.dirname(base) or "."
            extra.add(base)
        # A package directory is not a place Python looks for top-level packages: its child packages are
        # sub-packages, reached only through the package itself.
        extra = {root for root in extra if self.entries(root).get("__init__.py") != "file"}
        # Python puts a file's own directory on the import path only when the file runs as a script
        # (sys.path[0]). A plain directory of tests, examples, scripts or docs, or a file with a __main__
        # guard, is taken to run that way. A module inside a package is imported from the root above the
        # package chain, so its directory is a root only for a file that is run by path: an example, script,
        # doc or test file WITH a __main__ guard (a guard on any other module means python -m).
        in_package = self.entries(directory).get("__init__.py") == "file"
        by_role = role in ("test", "example", "script", "docs")
        if (by_role and main_guard) if in_package else (by_role or main_guard):
            extra.add(directory)
        return sorted(found | extra), extra


def is_collected_by_pytest(path):
    name = posixpath.basename(path)
    return name == "conftest.py" or (name.startswith("test_") and name.endswith(".py")) or name.endswith("_test.py")


def join(rel, *names):
    path = "/".join(names)
    return path if rel == "." else rel + "/" + path


def lookup(tree, directory, part):
    """Resolve one import component inside a directory. Returns (kind, path) or (None, tried)."""
    entries = tree.entries(directory)
    tried = [join(directory, part + ".py"), join(directory, part, "__init__.py")]
    here = join(directory, part)
    if entries.get(part) == "dir":
        inside = tree.entries(here)
        if inside.get("__init__.py") == "file":
            return "pkg", here
    if entries.get(part + ".py") == "file":
        return "module", join(directory, part + ".py")
    if entries.get(part) == "dir":
        if inside.get("__init__.pyi") == "file":
            return "stub_ext", here
        return "namespace", here
    if entries.get(part + ".pyi") == "file":
        return "stub_ext", join(directory, part + ".pyi")
    for name, kind in entries.items():
        if kind != "file" or not name.startswith(part):
            continue
        rest = name[len(part):]
        if rest.endswith(EXT_SUFFIXES) and (rest.startswith(".") and (rest.count(".") == 1 or rest.startswith((".cpython-", ".abi3", ".cp3", ".pypy")))):
            return "stub_ext", join(directory, name)
    return None, tried
`;
