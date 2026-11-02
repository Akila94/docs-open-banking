#!/usr/bin/env python3
"""Compare the MkDocs content model with the Docusaurus content model against a named allowlist.

Usage (run isolated; no network access is needed or used)::

    python -I compare.py <mk.jsonl> <docu.jsonl> --allow expected-diffs.master.yaml --report <out.md>

Exit status: 0 when every difference is explained by a listed rule AND every listed rule explained at
least one difference (so the allowlist cannot go stale); 1 when unexplained differences or unused rules
remain; 2 for unreadable inputs or an invalid allowlist.

Allowlist file format (``yaml.safe_load`` only)::

    rules:
      - name: ol-start                  # a built-in rule name, optionally with `pages: [...]`
      - id: some-fixup                  # one entry per converter fixup, rule name `fixup:some-fixup`
        pages: [learn/example/]         # base-relative page paths
        field: blocks                   # the one model field that changed
        from: "old wording"             # the change is pinned exactly: the Docusaurus value must equal
        to: "new wording"               # the MkDocs value with `from` replaced by `to` once
        reason: why the difference is accepted

All fixup keys are required. For list-valued fields the replacement is applied to the serialised text
(strings as they are, other elements as compact JSON with sorted keys) of each changed element.

h1 headings are compared by (level, text) only: MkDocs gives markdown H1s an id, Docusaurus never does.
"""

import argparse
import difflib
import itertools
import json
import logging
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field as dataclass_field
from pathlib import Path
from typing import Callable, Dict, FrozenSet, Iterator, List, Optional, Sequence, Tuple

import yaml

LOGGER = logging.getLogger("verify.compare")

MODEL_FIELDS = (
    "title", "headings", "blocks", "code", "tables", "lists",
    "admonitions", "images", "links", "tabs",
)
DEPRECATED_BANNER_PAGE = "includes/deprecated-banner/"
PAGE_FIELD = "(page)"
BUILTIN_RULE_NAMES = (
    "placeholder-visible", "ol-start", "nested-list", "list-not-paragraph",
    "admonition-title-markup", "deprecated-banner-page-removed",
)
_FIXUP_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_BUILTIN_RULE_KEYS = {"name", "reason", "pages"}
_FIXUP_KEYS = {"id", "pages", "field", "from", "to", "reason"}
# `<IDENT>` placeholders and generic-type text such as `<String, JSONObject>`; nothing else.
_PLACEHOLDER_TOKEN = re.compile(r"<[A-Za-z_][A-Za-z0-9_]*(?:, [A-Za-z_][A-Za-z0-9_]*)*>")
_MAX_TOKEN_OCCURRENCES = 12
_LIST_MARKER = re.compile(r"(?<!\S)(?:[-*+•]|\d+[.)])(?=\s|$)")
_MAX_DIFF_LINES = 40


class AllowlistError(Exception):
    """Raised when the allowlist file is unreadable or not valid."""


class ModelError(Exception):
    """Raised when a model file is unreadable or not valid JSON Lines of page models."""


@dataclass(frozen=True)
class Rule:
    """One allowlist rule; ``pages`` optionally restricts where it may apply.

    ``fixup:<id>`` rules also carry the pinned change: ``field``, ``replace_from`` and ``replace_to``.
    """

    name: str
    pages: Optional[FrozenSet[str]] = None
    reason: str = ""
    field: Optional[str] = None
    replace_from: Optional[str] = None
    replace_to: Optional[str] = None


@dataclass(frozen=True)
class FieldDiff:
    """An unexplained difference: one field of one page (or the whole page for missing/extra pages)."""

    path: str
    field: str
    mkdocs: object
    docusaurus: object


@dataclass
class Result:
    """Outcome of comparing two page sets."""

    pages_mkdocs: int = 0
    pages_docusaurus: int = 0
    identical_pages: int = 0
    explained_pages: int = 0
    rule_counts: Dict[str, int] = dataclass_field(default_factory=dict)
    unexplained: List[FieldDiff] = dataclass_field(default_factory=list)
    unused_rules: List[str] = dataclass_field(default_factory=list)

    @property
    def passed(self) -> bool:
        """True when nothing is unexplained and no listed rule is unused."""
        return not self.unexplained and not self.unused_rules


# ----------------------------------------------------------------- text helpers


def collapse(text: str) -> str:
    """Collapse all whitespace runs to single spaces and trim."""
    return " ".join(text.split())


def placeholder_removals(docusaurus_text: str, mkdocs_text: str) -> Iterator[str]:
    """Yield the ways to remove surplus placeholder tokens from the Docusaurus text.

    MkDocs swallows ``<IDENT>`` as unknown HTML while Docusaurus shows it. The Docusaurus text must
    contain every token of the MkDocs text (tokens may only be inserted, never lost); each yielded
    candidate has exactly the surplus tokens removed (all choices of which occurrence), whitespace collapsed.
    """
    mkdocs_tokens = Counter(_PLACEHOLDER_TOKEN.findall(mkdocs_text))
    occurrences: Dict[str, list] = defaultdict(list)
    for match in _PLACEHOLDER_TOKEN.finditer(docusaurus_text):
        occurrences[match.group()].append(match)
    if sum(len(found) for found in occurrences.values()) > _MAX_TOKEN_OCCURRENCES:
        return
    if any(len(occurrences[token]) < count for token, count in mkdocs_tokens.items()):
        return
    choices = [
        itertools.combinations(found, len(found) - mkdocs_tokens.get(token, 0))
        for token, found in occurrences.items()
    ]
    for picks in itertools.product(*choices):
        spans = sorted((match.start(), match.end()) for pick in picks for match in pick)
        pieces, position = [], 0
        for start, end in spans:
            pieces.append(docusaurus_text[position:start])
            position = end
        pieces.append(docusaurus_text[position:])
        yield collapse("".join(pieces))


def strip_title_markup(text: str) -> str:
    """Remove backticks and ``**`` (literal in MkDocs titles, rendered as markup by Docusaurus)."""
    return collapse(text.replace("`", "").replace("**", ""))


def strip_list_markers(text: str) -> str:
    """Remove list markers (``-``, ``*``, ``+``, ``1.``) that a MkDocs paragraph shows literally."""
    return collapse(_LIST_MARKER.sub("", text))


def map_text(field: str, value, transform: Callable[[str], str]):
    """Apply ``transform`` to the prose strings of a model field (never to code, ids, hashes or targets)."""
    if field == "title":
        return transform(value)
    if field == "blocks":
        return [transform(block) for block in value]
    if field == "headings":
        return [[level, transform(text), heading_id] for level, text, heading_id in value]
    if field == "tables":
        return [[[transform(cell) for cell in row] for row in table] for table in value]
    if field == "lists":
        return [{**entry, "items": [transform(item) for item in entry["items"]]} for entry in value]
    if field == "admonitions":
        return [{**entry, "title": transform(entry["title"])} for entry in value]
    if field == "images":
        return [{**entry, "alt": transform(entry["alt"])} for entry in value]
    if field == "links":
        return [{**entry, "text": transform(entry["text"])} for entry in value]
    if field == "tabs":
        return [{**entry, "label": transform(entry["label"])} for entry in value]
    return value


def _without_key(entries: Sequence[dict], key: str) -> List[dict]:
    """Copy list-of-dict entries with one key removed."""
    return [{k: v for k, v in entry.items() if k != key} for entry in entries]


# ------------------------------------------------------------------- rule logic


def _placeholder_visible(field: str, mkdocs: dict, docusaurus: dict) -> bool:
    """Docusaurus text equals the MkDocs text plus inserted ``<IDENT>`` tokens (never fewer tokens)."""
    if field == "code" or field not in MODEL_FIELDS:
        return False
    mkdocs_texts: List[str] = []
    map_text(field, mkdocs[field], lambda text: mkdocs_texts.append(text) or text)
    expected = iter(mkdocs_texts)

    def remove_inserted_tokens(docusaurus_text: str) -> str:
        mkdocs_text = next(expected)
        return next((c for c in placeholder_removals(docusaurus_text, mkdocs_text) if c == mkdocs_text),
                    docusaurus_text)

    try:
        return map_text(field, docusaurus[field], remove_inserted_tokens) == mkdocs[field]
    except (StopIteration, KeyError, TypeError, ValueError):
        return False


def _serialise(element: object) -> str:
    """Text form of one field element used by pinned fixups: strings verbatim, others compact JSON."""
    if isinstance(element, str):
        return element
    return json.dumps(element, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _fixup_explains(rule: Rule, field: str, mkdocs: dict, docusaurus: dict) -> bool:
    """The Docusaurus value equals the MkDocs value with ``from`` replaced by ``to`` exactly once.

    For list-valued fields every changed element must satisfy this and the lengths must match.
    """
    if field != rule.field:
        return False
    before, after = mkdocs[field], docusaurus[field]
    pairs = [(before, after)] if isinstance(before, str) else None
    if pairs is None:
        if not (isinstance(before, list) and isinstance(after, list) and len(before) == len(after)):
            return False
        pairs = [(old, new) for old, new in zip(before, after) if old != new]
    for old, new in pairs:
        old_text = _serialise(old)
        if old_text.count(rule.replace_from) != 1 or old_text.replace(rule.replace_from, rule.replace_to, 1) != _serialise(new):
            return False
    return bool(pairs)


def _ol_start(field: str, mkdocs: dict, docusaurus: dict) -> bool:
    """Only the ``start`` of ordered lists differs."""
    return field == "lists" and _without_key(mkdocs[field], "start") == _without_key(docusaurus[field], "start")


def _nested_list(field: str, mkdocs: dict, docusaurus: dict) -> bool:
    """The lists have the same item texts but a different nesting depth."""
    return field == "lists" and _without_key(mkdocs[field], "depth") == _without_key(docusaurus[field], "depth")


def _admonition_title_markup(field: str, mkdocs: dict, docusaurus: dict) -> bool:
    """Admonition titles differ only by backticks or ``**``."""
    return field == "admonitions" and (
        map_text(field, mkdocs[field], strip_title_markup) == map_text(field, docusaurus[field], strip_title_markup)
    )


def _list_not_paragraph(field: str, mkdocs: dict, docusaurus: dict) -> bool:
    """A paragraph became a list with the same text.

    Judged jointly on ``blocks`` and ``lists``: Docusaurus may only ADD lists; the MkDocs paragraphs
    that disappeared (list markers stripped) must read exactly like the Docusaurus paragraphs that
    appeared followed by the items of the added lists.
    """
    if field not in ("blocks", "lists"):
        return False
    list_ops = difflib.SequenceMatcher(
        None, [json.dumps(entry, sort_keys=True) for entry in mkdocs["lists"]],
        [json.dumps(entry, sort_keys=True) for entry in docusaurus["lists"]], autojunk=False,
    ).get_opcodes()
    if any(tag not in ("equal", "insert") for tag, *_ in list_ops):
        return False
    added_items = [
        item for tag, _, _, start, end in list_ops if tag == "insert"
        for entry in docusaurus["lists"][start:end] for item in entry["items"]
    ]
    if not added_items:
        return False
    removed: List[str] = []
    added: List[str] = []
    for tag, mk_start, mk_end, docu_start, docu_end in difflib.SequenceMatcher(
        None, mkdocs["blocks"], docusaurus["blocks"], autojunk=False
    ).get_opcodes():
        if tag != "equal":
            removed.extend(mkdocs["blocks"][mk_start:mk_end])
            added.extend(docusaurus["blocks"][docu_start:docu_end])
    if not removed:
        return False
    return strip_list_markers(" ".join(removed)) == collapse(" ".join(added + added_items))


_FIELD_RULES: Dict[str, Callable[[str, dict, dict], bool]] = {
    "placeholder-visible": _placeholder_visible,
    "ol-start": _ol_start,
    "nested-list": _nested_list,
    "list-not-paragraph": _list_not_paragraph,
    "admonition-title-markup": _admonition_title_markup,
}


def rule_explains_field(rule: Rule, field: str, mkdocs: dict, docusaurus: dict) -> bool:
    """True when ``rule`` accepts the difference in ``field`` between the two pages."""
    if rule.pages is not None and mkdocs["path"] not in rule.pages:
        return False
    if rule.name.startswith("fixup:"):
        return _fixup_explains(rule, field, mkdocs, docusaurus)
    predicate = _FIELD_RULES.get(rule.name)
    return predicate is not None and predicate(field, mkdocs, docusaurus)


def rule_explains_missing_page(rule: Rule, path: str) -> bool:
    """True when ``rule`` accepts a page that exists in MkDocs but not in Docusaurus."""
    if rule.pages is not None and path not in rule.pages:
        return False
    return rule.name == "deprecated-banner-page-removed" and path == DEPRECATED_BANNER_PAGE


# -------------------------------------------------------------------- the diff


def _without_h1_ids(page: dict) -> dict:
    """Copy of the page with the ids of level-1 headings blanked (exempt: only MkDocs gives H1s an id)."""
    return {**page, "headings": [[level, text, "" if level == 1 else heading_id]
                                 for level, text, heading_id in page["headings"]]}


def compare_models(mkdocs_pages: Dict[str, dict], docusaurus_pages: Dict[str, dict], rules: Sequence[Rule]) -> Result:
    """Compare page models keyed by path and attribute every difference to the rules that explain it."""
    counts: Counter = Counter()
    result = Result(pages_mkdocs=len(mkdocs_pages), pages_docusaurus=len(docusaurus_pages))
    mkdocs_pages = {path: _without_h1_ids(page) for path, page in mkdocs_pages.items()}
    docusaurus_pages = {path: _without_h1_ids(page) for path, page in docusaurus_pages.items()}
    for path in sorted(set(mkdocs_pages) | set(docusaurus_pages)):
        mkdocs, docusaurus = mkdocs_pages.get(path), docusaurus_pages.get(path)
        if mkdocs is None:
            result.unexplained.append(FieldDiff(path, PAGE_FIELD, None, "page only exists in the Docusaurus build"))
        elif docusaurus is None:
            matching = [rule for rule in rules if rule_explains_missing_page(rule, path)]
            for rule in matching:
                counts[rule.name] += 1
            if matching:
                result.explained_pages += 1
            else:
                result.unexplained.append(FieldDiff(path, PAGE_FIELD, "page exists", "page missing from the Docusaurus build"))
        else:
            _compare_page(path, mkdocs, docusaurus, rules, counts, result)
    result.rule_counts = dict(counts)
    result.unused_rules = [rule.name for rule in rules if counts[rule.name] == 0]
    return result


def _compare_page(path: str, mkdocs: dict, docusaurus: dict, rules: Sequence[Rule], counts: Counter, result: Result) -> None:
    """Compare two versions of one page field by field, crediting every rule that explains a difference."""
    differing = [field for field in MODEL_FIELDS if mkdocs.get(field) != docusaurus.get(field)]
    if not differing:
        result.identical_pages += 1
        return
    all_explained = True
    for field in differing:
        matching = [rule for rule in rules if rule_explains_field(rule, field, mkdocs, docusaurus)]
        for rule in matching:
            counts[rule.name] += 1
        if not matching:
            all_explained = False
            result.unexplained.append(FieldDiff(path, field, mkdocs.get(field), docusaurus.get(field)))
    if all_explained:
        result.explained_pages += 1


# ---------------------------------------------------------------- file loading


def load_rules(path: Path) -> List[Rule]:
    """Load and validate the allowlist.

    Raises:
        AllowlistError: for unreadable files, YAML errors (``safe_load`` rejects arbitrary tags),
            unknown rule names or keys, duplicate rules, or fixups missing any of id/pages/field/from/to/reason.
    """
    try:
        document = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise AllowlistError(f"cannot read allowlist {path}: {error}") from error
    if not isinstance(document, dict) or not isinstance(document.get("rules"), list) or set(document) != {"rules"}:
        raise AllowlistError("allowlist must be a mapping with a single `rules:` list")
    rules: List[Rule] = []
    for entry in document["rules"]:
        rules.append(_parse_rule(entry))
    names = [rule.name for rule in rules]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise AllowlistError(f"duplicate rules: {duplicates}")
    return rules


def _string_set(entry: dict, key: str, label: str) -> Optional[FrozenSet[str]]:
    """Read an optional list-of-strings key of a rule entry as a frozenset."""
    if key not in entry:
        return None
    value = entry[key]
    if not isinstance(value, list) or not value or not all(isinstance(item, str) for item in value):
        raise AllowlistError(f"`{key}` of rule {label!r} must be a non-empty list of strings")
    return frozenset(value)


def _parse_rule(entry: object) -> Rule:
    """Validate one allowlist entry (built-in rule with `name`, or fixup with `id`) into a ``Rule``."""
    if not isinstance(entry, dict) or ("name" in entry) == ("id" in entry):
        raise AllowlistError(f"every rule must be a mapping with either a built-in `name` or a fixup `id`, got {entry!r}")
    if "id" in entry:
        return _parse_fixup(entry)
    name = entry["name"]
    if not isinstance(name, str) or name not in BUILTIN_RULE_NAMES:
        raise AllowlistError(f"unknown rule {name!r}; built-in rules: {list(BUILTIN_RULE_NAMES)} (fixups use `id`)")
    unknown_keys = set(entry) - _BUILTIN_RULE_KEYS
    if unknown_keys:
        raise AllowlistError(f"rule {name!r} has unknown keys {sorted(unknown_keys)}")
    reason = entry.get("reason", "")
    if not isinstance(reason, str):
        raise AllowlistError(f"`reason` of rule {name!r} must be a string")
    return Rule(name=name, pages=_string_set(entry, "pages", name), reason=reason)


def _parse_fixup(entry: dict) -> Rule:
    """Validate a fixup entry: all of id, pages, field, from, to and reason are required."""
    fixup_id = entry["id"]
    if not isinstance(fixup_id, str) or not _FIXUP_ID.match(fixup_id):
        raise AllowlistError(f"invalid fixup id {fixup_id!r}")
    label = f"fixup:{fixup_id}"
    unknown_keys = set(entry) - _FIXUP_KEYS
    if unknown_keys:
        raise AllowlistError(f"rule {label!r} has unknown keys {sorted(unknown_keys)}")
    missing = sorted(_FIXUP_KEYS - set(entry))
    if missing:
        raise AllowlistError(f"fixup rule {label!r} is missing required keys {missing}")
    pages = _string_set(entry, "pages", label)
    if entry["field"] not in MODEL_FIELDS:
        raise AllowlistError(f"rule {label!r} has unknown field {entry['field']!r}; expected one of {list(MODEL_FIELDS)}")
    for key in ("from", "to", "reason"):
        if not isinstance(entry[key], str):
            raise AllowlistError(f"`{key}` of rule {label!r} must be a string (quote it in YAML)")
    if not entry["from"] or not entry["reason"] or entry["from"] == entry["to"]:
        raise AllowlistError(f"rule {label!r} needs a non-empty `from` that differs from `to`, and a non-empty `reason`")
    return Rule(name=label, pages=pages, reason=entry["reason"], field=entry["field"],
                replace_from=entry["from"], replace_to=entry["to"])


def load_model(path: Path) -> Dict[str, dict]:
    """Load a JSON Lines model file into a dict keyed by page path.

    Raises:
        ModelError: for unreadable files, invalid JSON, pages missing fields, or duplicate paths.
    """
    pages: Dict[str, dict] = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise ModelError(f"cannot read model {path}: {error}") from error
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            page = json.loads(line)
        except json.JSONDecodeError as error:
            raise ModelError(f"{path}:{number}: invalid JSON ({error.msg})") from error
        if not isinstance(page, dict) or not isinstance(page.get("path"), str) or not set(MODEL_FIELDS) <= set(page):
            raise ModelError(f"{path}:{number}: not a page model (needs `path` and {list(MODEL_FIELDS)})")
        if page["path"] in pages:
            raise ModelError(f"{path}:{number}: duplicate page path {page['path']!r}")
        pages[page["path"]] = page
    return pages


# ---------------------------------------------------------------------- report


def _fence(text: str) -> str:
    """A backtick fence longer than any backtick run in the text."""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def _diff_text(diff: FieldDiff) -> str:
    """A bounded unified diff of one unexplained difference."""
    def render(value: object) -> List[str]:
        return (value if isinstance(value, str) else json.dumps(value, indent=1, ensure_ascii=False)).splitlines()

    lines = list(difflib.unified_diff(render(diff.mkdocs), render(diff.docusaurus), "mkdocs", "docusaurus", lineterm="", n=1))
    if len(lines) > _MAX_DIFF_LINES:
        lines = lines[:_MAX_DIFF_LINES] + [f"... ({len(lines) - _MAX_DIFF_LINES} more diff lines)"]
    return "\n".join(lines)


def render_report(result: Result, rules: Sequence[Rule]) -> str:
    """Render the Markdown report: summary, per-rule counts, unexplained differences per page."""
    out = [
        "# MkDocs vs Docusaurus content verification", "",
        f"**Verdict: {'PASS' if result.passed else 'FAIL'}**", "",
        "## Summary", "",
        f"- pages in MkDocs model: {result.pages_mkdocs}",
        f"- pages in Docusaurus model: {result.pages_docusaurus}",
        f"- identical pages: {result.identical_pages}",
        f"- pages whose differences are all explained by the allowlist: {result.explained_pages}",
        f"- unexplained differences: {len(result.unexplained)}",
        f"- unused allowlist rules: {len(result.unused_rules)}", "",
        "## Allowlist rules", "",
    ]
    if rules:
        out += ["| rule | differences explained | status |", "|---|---|---|"]
        out += [
            f"| `{rule.name}` | {result.rule_counts.get(rule.name, 0)} | "
            f"{'UNUSED (remove it)' if rule.name in result.unused_rules else 'used'} |"
            for rule in rules
        ]
    else:
        out.append("No rules are listed: every difference is unexplained.")
    out += ["", "## Unexplained differences", ""]
    if not result.unexplained:
        out.append("None.")
    by_page: Dict[str, List[FieldDiff]] = {}
    for diff in result.unexplained:
        by_page.setdefault(diff.path, []).append(diff)
    for path, diffs in by_page.items():
        out += [f"### `{path or '/'}`", ""]
        for diff in diffs:
            text = _diff_text(diff)
            fence = _fence(text)
            out += [f"- field `{diff.field}`", "", f"{fence}diff", text, fence, ""]
    return "\n".join(out) + "\n"


# ------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    """Command-line parser for ``compare.py``."""
    parser = argparse.ArgumentParser(description="Compare MkDocs and Docusaurus content models.")
    parser.add_argument("mkdocs_model", type=Path, help="model.jsonl extracted from the MkDocs build")
    parser.add_argument("docusaurus_model", type=Path, help="model.jsonl extracted from the Docusaurus build")
    parser.add_argument("--allow", required=True, type=Path, help="allowlist YAML (expected-diffs.master.yaml)")
    parser.add_argument("--report", required=True, type=Path, help="Markdown report to write")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the comparison, write the report and return the exit status (0 pass, 1 fail, 2 bad input)."""
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s %(message)s")
    args = build_parser().parse_args(argv)
    try:
        rules = load_rules(args.allow)
        mkdocs_pages = load_model(args.mkdocs_model)
        docusaurus_pages = load_model(args.docusaurus_model)
    except (AllowlistError, ModelError) as error:
        LOGGER.error("%s", error)
        return 2

    result = compare_models(mkdocs_pages, docusaurus_pages, rules)
    try:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(render_report(result, rules), encoding="utf-8")
    except OSError as error:
        LOGGER.error("cannot write report %s: %s", args.report, error)
        return 2
    LOGGER.info(
        "verdict=%s identical=%d explained_pages=%d unexplained=%d unused_rules=%d report=%s",
        "PASS" if result.passed else "FAIL", result.identical_pages, result.explained_pages,
        len(result.unexplained), len(result.unused_rules), args.report,
    )
    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(main())
