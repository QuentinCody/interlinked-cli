// interlinked-tdd: exempt
// @codegen-data — embedded Python program, part 2 of 2 (joined in check-python-script.ts).
// Data only; behaviour is tested through check-python-run.test.ts and check-python-imports.test.ts.
// Import resolution, candidate construction and the entry point. The program reads one JSON
// object on stdin ({"root": "<dir>"}), writes one JSON object on stdout and starts no child
// process: the git-ignore filter runs on the TypeScript side.
// Keep backticks and dollar-brace sequences out of this text: it is a template literal.

export const PYTHON_RESOLVE_PART = String.raw`

# --- candidate construction --------------------------------------------------------------


TEST_FOLDER_SUFFIX = re.compile(r"[-_]tests?$")
EXAMPLE_WORDS = {"example", "examples", "demo", "demos", "sample", "samples", "tutorial", "tutorials", "cookbook", "notebooks"}


def importer_role(path):
    parts = path.lower().split("/")
    name = parts[-1]
    folders = set(parts[:-1])
    if folders & {"test", "tests", "testing", "unittests", "integration_tests", "e2e"} or any(TEST_FOLDER_SUFFIX.search(f) for f in folders) or name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py":
        return "test"
    if any(set(re.split(r"[-_]", f)) & EXAMPLE_WORDS for f in folders):
        return "example"
    if folders & {"doc", "docs", "documentation"}:
        return "docs"
    if folders & {"script", "scripts", "tools", "bin", "benchmark", "benchmarks", "ci"} or name in ("setup.py", "noxfile.py", "tasks.py", "fabfile.py"):
        return "script"
    return "other"


def listing_of(tree, directory):
    entries = tree.entries(directory)
    return sorted(name + "/" if kind == "dir" else name for name, kind in entries.items())[:LIST_CAP]


def deepest_existing(tree, directory):
    while directory != "." and not tree.entries(directory):
        directory = posixpath.dirname(directory) or "."
    return directory


class Probe:
    def __init__(self, root, blast_min=5):
        self.blast_min = blast_min
        self.dependents = {}
        self.consumed = set()
        self.dead_skips = {}
        self.tree = Tree(root)
        self.summaries = {}
        self.unparsed = []
        self.skips = {}
        self.stats = {"imports_total": 0, "relative": 0, "absolute_first_party_checked": 0, "absolute_not_first_party": 0, "absolute_multi_root": 0, "absolute_found_elsewhere": 0, "unchecked_stub_or_ext": 0}
        self.module_names = set()
        self.edges = {}
        self.last_outcome = None
        self.own_roots = set()
        self.pending = []
        self.lines_cache = (None, [])
        self.graph_edges = []
        self.graph_bindings = []
        self.last_base = None
        self.current_alias = None

    def skip(self, reason):
        self.skips[reason] = self.skips.get(reason, 0) + 1

    def parse_all(self, listed):
        self.tree.walk(listed)
        for path in self.tree.py_files:
            full = self.tree.abs(path)
            try:
                info = os.lstat(full)
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                    raise ValueError("symlink_or_special_file")
                if info.st_size > MAX_FILE_BYTES:
                    raise ValueError("too_large")
                with open(full, "rb") as handle:
                    data = handle.read()
                self.summaries[path] = analyse_file(data, importer_role(path) == "test")
            except (SyntaxError, ValueError, RecursionError, MemoryError, OSError, UnicodeError) as error:
                self.unparsed.append({"path": path, "reason": type(error).__name__ + ": " + str(error)[:100]})
            except Exception as error:  # a probe bug stays visible as internal_error, never a finding
                self.unparsed.append({"path": path, "reason": "internal_error " + type(error).__name__ + ": " + str(error)[:100]})

    # -- module resolution --

    def resolve(self, directory, parts):
        """Walk the parts from a directory. Returns ('ok', kind, path) or ('missing', parent_dir, part, tried, parent_kind)."""
        kind = "pkg" if self.tree.entries(directory).get("__init__.py") == "file" else "namespace"
        current = directory
        path = directory
        for index, part in enumerate(parts):
            parent_kind = kind
            found, value = lookup(self.tree, current, part)
            if found is None:
                return ("missing", current, part, value, parent_kind)
            kind, path = found, value
            if index < len(parts) - 1:
                if kind == "module":
                    raise Skip("parent_is_module")
                if kind == "stub_ext":
                    raise Skip("stub_or_ext_target")
                current = path
        return ("ok", kind, path)

    # -- checks --

    def check_statement(self, importer, node, ctx, roots):
        self.stats["imports_total"] += 1
        if isinstance(node, ast.Import):
            for alias in node.names:
                self.current_alias = alias
                self.check_absolute(importer, node, ctx, alias.name.split("."), [], roots)
            return
        level = node.level
        module_parts = node.module.split(".") if node.module else []
        names = [alias.name for alias in node.names if alias.name != "*"]
        if level == 0:
            self.check_absolute(importer, node, ctx, module_parts, names, roots)
            return
        self.stats["relative"] += 1
        base = posixpath.dirname(importer) or "."
        for _ in range(level - 1):
            if base == ".":
                self.skip("above_root")
                return
            base = posixpath.dirname(base) or "."
        found, skips = self.evaluate(importer, node, ctx, base, module_parts, names, level)
        self.record_edges(importer, node, ctx, names)
        self.pending.extend(found)
        for reason in skips:
            self.skip(reason)

    def homes_of(self, roots, first):
        homes = []
        regular = []
        for root in roots:
            kind, _ = lookup(self.tree, root, first)
            if kind in ("pkg", "module", "stub_ext") or (kind == "namespace" and join(root, first) in self.tree.has_py):
                homes.append(root)
            if kind in ("pkg", "module", "stub_ext"):
                regular.append(root)
        # Python picks a regular package over a namespace directory of the same name.
        if len(homes) > 1 and len(regular) == 1:
            return regular
        return homes

    def check_absolute(self, importer, node, ctx, parts, names, roots):
        homes = self.homes_of(roots, parts[0])
        if homes and parts[0] in STDLIB_NAMES:
            # The standard library comes before site-packages and before an installed or declared project
            # root: only a directory that is first on sys.path (the importer's own roots) can shadow it.
            homes = [home for home in homes if home in self.own_roots]
            if not homes:
                self.skip("stdlib_name_not_shadowed")
        if not homes:
            self.stats["absolute_not_first_party"] += 1
            if parts[0] in self.tree.aliases:
                # A build file maps this package name to a directory of another name: not judged.
                self.skip("package_dir_alias")
            if parts[0] in self.module_names:
                # Diagnostic only: the name exists somewhere in the tree, but under no resolution root.
                self.stats["absolute_found_elsewhere"] += 1
            return
        self.stats["absolute_first_party_checked"] += 1
        outcomes = [self.evaluate(importer, node, ctx, home, parts, names, 0) for home in homes]
        if len(homes) > 1:
            self.stats["absolute_multi_root"] += 1
            # A name that resolves in ANY valid root is not broken; when no root resolves it, the
            # statement is ambiguous and is not reported.
            if not any(not found and not skips for found, skips in outcomes):
                self.skip("ambiguous_root")
            return
        found, skips = outcomes[0]
        self.record_edges(importer, node, ctx, names)
        for reason in skips:
            self.skip(reason)
        if found and self.summaries[importer]["sys_path_edit"]:
            self.skip("importer_sys_path_edit")
            return
        self.pending.extend(found)

    def record_edges(self, importer, node, ctx, names):
        """Import edges of one statement. The dependents map (blast radius) takes every static import of a parsed
        first-party module; the edges map (cycle scan) only the load-time ones: top-level, not type-only."""
        outcome = self.last_outcome
        if outcome is None or outcome[0] != "ok":
            return
        _, kind, path = outcome
        if kind not in ("pkg", "module"):
            return
        submodules = []
        has_bound_name = False
        if kind == "pkg":
            for name in names:
                found, value = lookup(self.tree, path, name)
                if found == "module":
                    submodules.append(value)
                elif found == "pkg":
                    submodules.append(join(value, "__init__.py"))
                else:
                    has_bound_name = True
            init = join(path, "__init__.py")
            dependent_targets = submodules + ([init] if has_bound_name or not names else [])
            # Loading a submodule of the package you already sit in does not re-enter its __init__.
            inside = path == "." or importer.startswith(path + "/")
            edge_targets = submodules + ([init] if not inside or has_bound_name else [])
        else:
            dependent_targets = edge_targets = [path]
        for target in dependent_targets:
            if target != importer and target in self.summaries:
                self.dependents.setdefault(target, set()).add(importer)
        if GRAPH_MODE:
            graph_record(self, importer, node, ctx, names, kind, path)
        if ctx.in_function or ctx.type_only:
            return
        for target in edge_targets:
            if target != importer and target in self.summaries:
                self.edges.setdefault(importer, []).append((target, node.lineno))

    def find_cycles(self):
        """Strongly connected components of size > 1 over the load-time edges (iterative Tarjan)."""
        graph = {source: sorted({target for target, _ in edges}) for source, edges in self.edges.items()}
        index, low, stack, on_stack, groups, counter = {}, {}, [], set(), [], 0
        for start in sorted(graph):
            if start in index:
                continue
            index[start] = low[start] = counter
            counter += 1
            stack.append(start)
            on_stack.add(start)
            work = [(start, iter(graph.get(start, [])))]
            while work:
                node, children = work[-1]
                descended = False
                for child in children:
                    if child not in index:
                        index[child] = low[child] = counter
                        counter += 1
                        stack.append(child)
                        on_stack.add(child)
                        work.append((child, iter(graph.get(child, []))))
                        descended = True
                        break
                    if child in on_stack:
                        low[node] = min(low[node], index[child])
                if descended:
                    continue
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[node])
                if low[node] == index[node]:
                    members = []
                    while True:
                        member = stack.pop()
                        on_stack.discard(member)
                        members.append(member)
                        if member == node:
                            break
                    if len(members) > 1:
                        groups.append(sorted(members))
        return [self.cycle_group(members) for members in sorted(groups)]

    def find_duplicates(self):
        """Groups of non-test functions that share one parameter list and one body (names and comments aside)."""
        by_hash = {}
        for path, summary in sorted(self.summaries.items()):
            if importer_role(path) == "test":
                continue
            for digest, weight, name, line in summary["functions"]:
                by_hash.setdefault(digest, []).append({"path": path, "line": line, "name": name, "size": weight})
        groups = []
        for members in by_hash.values():
            if len(members) > 1:
                groups.append({"size": members[0]["size"], "members_total": len(members), "members": members[:LIST_CAP]})
        return sorted(groups, key=lambda g: (-g["size"], g["members"][0]["path"], g["members"][0]["line"]))

    def dead_skip(self, reason):
        self.dead_skips[reason] = self.dead_skips.get(reason, 0) + 1

    def collect_dead(self):
        """Unused import bindings per module, after the path-level and cross-module exemptions."""
        entries, total = [], 0
        for path, summary in sorted(self.summaries.items()):
            kept = []
            base = posixpath.basename(path)
            for item in summary["dead"]:
                reason = item["reason"]
                if reason is None and base == "__init__.py":
                    reason = "package_init"
                elif reason is None and base == "conftest.py":
                    reason = "conftest"
                elif reason is None and (path, item["name"]) in self.consumed:
                    reason = "imported_by_other_module"
                if reason:
                    self.dead_skip(reason)
                    continue
                kept.append({key: value for key, value in item.items() if key != "reason"})
            if kept:
                total += len(kept)
                entries.append({"path": path, "count": len(kept), "imports": [self.with_statement(path, item) for item in kept[:LIST_CAP]]})
        return entries, total

    def with_statement(self, path, item):
        try:
            lines = self.statement_lines(path)
            item["statement"] = "\n".join(line.rstrip() for line in lines[item["line"] - 1:item["end_line"]]).strip()[:STATEMENT_CAP]
        except OSError:
            item["statement"] = ""
        return item

    def blast_entries(self):
        found = [{"path": target, "dependents": len(importers), "importers": sorted(importers)[:10]} for target, importers in self.dependents.items() if len(importers) >= self.blast_min]
        return sorted(found, key=lambda entry: (-entry["dependents"], entry["path"]))[:CANDIDATE_CAP]

    def cycle_group(self, members):
        inside = set(members)
        edges = [{"from": source, "to": target, "line": line} for source in members for target, line in self.edges.get(source, []) if target in inside]
        through_init = any(posixpath.basename(member) == "__init__.py" for member in members)
        return {"files": members[:LIST_CAP], "files_total": len(members), "through_package_init": through_init, "edges": edges[:LIST_CAP]}

    def evaluate(self, importer, node, ctx, base, parts, names, level):
        found, skips = [], []
        self.last_outcome = None
        self.last_base = base
        try:
            outcome = self.resolve(base, parts)
            self.last_outcome = outcome
            if outcome[0] == "missing":
                self.on_missing_module(found, importer, node, ctx, level, parts, outcome)
            else:
                self.on_resolved(found, skips, importer, node, ctx, parts, names, level, outcome)
        except Skip as skip:
            skips.append(skip.reason)
        return found, skips

    def on_missing_module(self, found, importer, node, ctx, level, parts, outcome):
        _, parent_dir, part, tried, parent_kind = outcome
        if ctx.guarded:
            raise Skip("try_importerror_guard")
        if GENERATED_NAME.search(part):
            raise Skip("generated_name")
        if parent_kind != "pkg":
            raise Skip("namespace_target")
        parent_summary = self.summaries.get(join(parent_dir, "__init__.py"))
        if parent_summary and any(token in parent_summary["dynamic"] for token in ("sys.modules[", "__path__", "setattr(", "globals()", "exec(")):
            raise Skip("parent_dynamic")
        spec_tried = tried + [join(parent_dir, part + ".pyi")] + [join(parent_dir, part + suffix) for suffix in EXT_SUFFIXES]
        found.append(self.candidate(importer, node, ctx, "missing_module", None, level, parts, [join(parent_dir, part + ".py"), join(parent_dir, part, "__init__.py")], spec_tried, deepest_existing(self.tree, parent_dir), None, None))

    def on_resolved(self, found, skips, importer, node, ctx, parts, names, level, outcome):
        _, kind, path = outcome
        if not names:
            return
        if kind == "stub_ext":
            self.stats["unchecked_stub_or_ext"] += 1
            return
        if kind == "namespace":
            for name in names:
                if lookup(self.tree, path, name)[0] is None:
                    skips.append("namespace_target")
            return
        package_dir = path if kind == "pkg" else None
        module_file = join(path, "__init__.py") if kind == "pkg" else path
        summary = self.summaries.get(module_file)
        if summary is None:
            skips.append("target_unparsed")
            return
        for name in names:
            self.judge_name(found, skips, importer, node, ctx, parts, level, name, package_dir, module_file, summary)

    def judge_name(self, found, skips, importer, node, ctx, parts, level, name, package_dir, module_file, summary):
        self.consumed.add((module_file, name))
        if package_dir is not None and lookup(self.tree, package_dir, name)[0] is not None:
            return
        if name in summary["names"]:
            return
        reason = None
        if ctx.guarded:
            reason = "try_importerror_guard"
        elif summary["star"]:
            reason = "target_star_import"
        elif summary["getattr"]:
            reason = "target_getattr"
        elif summary["dynamic"]:
            reason = "target_dynamic_surface"
        elif GENERATED_NAME.search(name):
            reason = "generated_name"
        if reason:
            skips.append(reason)
            return
        tried = [join(package_dir, name + ".py"), join(package_dir, name, "__init__.py")] if package_dir is not None else []
        listing_dir = package_dir if package_dir is not None else (posixpath.dirname(module_file) or ".")
        names = sorted(n for n in summary["names"] if not (n.startswith("__") and n.endswith("__")))
        found.append(self.candidate(importer, node, ctx, "missing_name", name, level, parts, tried, tried, listing_dir, module_file, names))

    def candidate(self, importer, node, ctx, kind, name, level, parts, ignore_paths, tried, listing_dir, target_file, target_names):
        return {
            "kind": kind,
            "importer": importer,
            "line": node.lineno,
            "end_line": getattr(node, "end_lineno", node.lineno),
            "level": level,
            "module": ("." * level) + ".".join(parts),
            "name": name,
            "tags": {"type_only": ctx.type_only, "in_function": ctx.in_function, "importer_role": importer_role(importer), "version_or_platform_guard": ctx.version_guard},
            "tried": tried,
            "ignore_paths": ignore_paths,
            "listing_dir": listing_dir,
            "target_file": target_file,
            "target_names": target_names,
        }

    # -- evidence --

    def statement_lines(self, importer):
        cached_path, cached_lines = self.lines_cache
        if cached_path == importer:
            return cached_lines
        with open(self.tree.abs(importer), "rb") as handle:
            lines = decode(handle.read()).splitlines()
        self.lines_cache = (importer, lines)
        return lines

    def has_owner_ignore(self, item):
        """The author silenced a type checker on this statement (pyright or type: ignore): the import is expected to fail to resolve."""
        try:
            lines = self.statement_lines(item["importer"])
        except OSError:
            return False
        return any(OWNER_IGNORE.search(line) for line in lines[item["line"] - 1:item["end_line"]])

    def declared_native(self, item):
        """A build file (maturin module-name, ext-modules, Extension, cffi, meson) names the missing module as a native extension."""
        for tried in item["ignore_paths"]:
            stem = tried[:-12] if tried.endswith("/__init__.py") else tried[:-3] if tried.endswith(".py") else tried
            if any(stem == path or stem.endswith("/" + path) for path in self.tree.native_paths):
                return True
        return False

    def evidence(self, item):
        try:
            lines = self.statement_lines(item["importer"])
            statement = "\n".join(line.rstrip() for line in lines[item["line"] - 1:item["end_line"]]).strip()[:STATEMENT_CAP]
        except OSError:
            statement = ""
        last = (item["name"] or item["module"].lstrip(".").split(".")[-1]) or ""
        item["tags"]["underscore_target"] = last.startswith("_")
        item["tags"]["repo_native_build"] = self.tree.native_build
        item["statement"] = statement
        item["listing"] = listing_of(self.tree, item["listing_dir"])
        if item["target_names"] is not None:
            item["target_names"] = item["target_names"][:LIST_CAP]
        return item

    def run(self, listed):
        self.parse_all(listed)
        for path in self.tree.py_files:
            stem = posixpath.basename(path)[:-3]
            holder = posixpath.basename(posixpath.dirname(path))
            self.module_names.add(holder if stem == "__init__" else stem)
        for importer in sorted(self.summaries):
            summary = self.summaries[importer]
            roots, self.own_roots = self.tree.roots_for(importer, importer_role(importer), summary["main_guard"])
            for node, ctx in summary["imports"]:
                self.check_statement(importer, node, ctx, roots)
        ordered = []
        for item in sorted(self.pending, key=lambda c: (c["importer"], c["line"], c["kind"], c["name"] or "")):
            if self.has_owner_ignore(item):
                self.skip("owner_ignore_comment")
            elif self.declared_native(item):
                self.skip("declared_native_extension")
            else:
                ordered.append(item)
        cycle_groups = self.find_cycles()
        any_types = [
            {"path": path, "count": len(summary["any_lines"]), "lines": sorted(set(summary["any_lines"]))[:LIST_CAP]}
            for path, summary in sorted(self.summaries.items())
            if summary["any_lines"] and importer_role(path) != "test"
        ]
        duplicate_groups = self.find_duplicates()
        dead_entries, dead_total = self.collect_dead()
        graph = graph_payload(self) if GRAPH_MODE else None
        return {
            "graph": graph,
            "dead_imports": dead_entries[:CANDIDATE_CAP],
            "dead_imports_total": dead_total,
            "dead_skips": dict(sorted(self.dead_skips.items())),
            "blast_radius": self.blast_entries(),
            "blast_min": self.blast_min,
            "duplicate_groups_total": len(duplicate_groups),
            "duplicate_groups": duplicate_groups[:CANDIDATE_CAP],
            "any_types": any_types,
            "cycle_groups_total": len(cycle_groups),
            "cycle_groups": cycle_groups[:CANDIDATE_CAP],
            "python": sys.version.split()[0],
            "import_roots": sorted(self.tree.roots),
            "files_py": len(self.tree.py_files),
            "files_parsed": len(self.summaries),
            "files_truncated": self.tree.files_truncated,
            "unparsed_total": len(self.unparsed),
            "unparsed": self.unparsed[:50],
            "native_build_signal": self.tree.native_build,
            "pyproject_unread": self.tree.pyproject_unread,
            "stats": self.stats,
            "skips": dict(sorted(self.skips.items())),
            "candidates_total": len(ordered),
            "candidates": [self.evidence(item) for item in ordered[:CANDIDATE_CAP]],
        }


def main():
    request = json.loads(sys.stdin.read())
    root = request.get("root")
    if not isinstance(root, str) or not os.path.isdir(root):
        sys.stderr.write("root is not a directory\n")
        return 2
    listed = request.get("files")
    blast_min = request.get("blast_min")
    global GRAPH_MODE
    GRAPH_MODE = request.get("graph") is True
    probe = Probe(os.path.abspath(root), blast_min if isinstance(blast_min, int) and blast_min > 0 else 5)
    result = probe.run(listed if isinstance(listed, list) else None)
    result["discovery"] = "git" if isinstance(listed, list) else "walk"
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


sys.exit(main())
`;
