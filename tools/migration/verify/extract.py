#!/usr/bin/env python3
"""Extract a normalised, flavour-independent content model from a built documentation site.

The same model is produced from a MkDocs (Material 4) build and from a Docusaurus 3 build so that
``compare.py`` can prove that no documentation content changed in the migration.

Usage (run isolated, no network access is needed or used)::

    python -I extract.py --flavor {mkdocs|docusaurus} --site <built-site-dir> --base-url /en/latest/ > model.jsonl

One JSON object is written per page, keyed by ``path`` (the page URL path relative to the base URL,
``""`` for the site root). The HTML is only ever parsed, never executed.

Layout of this module:

* shared normalisation (``normalise_text``, ``finalise_code``)
* URL and file resolution confined to the site directory
* ``MkDocsFlavor`` / ``DocusaurusFlavor``: the small, explicit per-flavour extraction rules
* ``extract_page`` / ``extract_site``: the shared model builder
"""

import argparse
import base64
import binascii
import hashlib
import logging
import os
import re
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Dict, Iterator, List, NamedTuple, Optional, Sequence, Set, Tuple
from urllib.parse import unquote, urljoin, urlsplit

from bs4 import BeautifulSoup
from bs4.element import CData, NavigableString, Tag

LOGGER = logging.getLogger("verify.extract")

MODEL_FIELDS = (
    "title", "headings", "blocks", "code", "tables", "lists",
    "admonitions", "images", "links", "tabs",
)
# Evidence carried in each page model that is not a compared field: ``onclick_targets`` (read by the
# onclick-card-link rule) and ``flow`` (read by the list-restructure-text-preserved rule).

# Characters that never carry content: pilcrow permalinks and zero-width characters.
_STRIPPED_CHARACTERS = dict.fromkeys(
    map(ord, "¶​‌‍⁠﻿"), None
)
_HEADING_NAMES = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
_LIST_NAMES = frozenset({"ul", "ol"})
# Tags that separate words/blocks when text is flattened (everything else is inline).
_BLOCK_NAMES = _HEADING_NAMES | _LIST_NAMES | frozenset({
    "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt",
    "figcaption", "figure", "footer", "header", "hr", "li", "main", "nav", "p", "pre",
    "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
})
_TEXT_NODE_TYPES = (NavigableString, CData)
# Chrome that is never documentation content in either flavour.
_COMMON_NOISE_SELECTORS = ("script", "style", "noscript", "iframe", "template")
_IMAGE_READ_CHUNK = 1024 * 1024


class ExtractionError(Exception):
    """Raised when the markup of a page is not one of the shapes this extractor understands."""


# ------------------------------------------------------------------ normalisation


def normalise_text(text: str) -> str:
    """Normalise prose: strip pilcrow/zero-width characters, apply NFC, collapse all whitespace."""
    stripped = text.translate(_STRIPPED_CHARACTERS)
    return " ".join(unicodedata.normalize("NFC", stripped).split())


def finalise_code(text: str) -> str:
    """Normalise a code block: NFC, LF newlines, right-strip every line, trim outer blank lines."""
    lines = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [line.rstrip() for line in lines]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def _classes(tag: Tag) -> List[str]:
    """Return the class tokens of a tag (empty list when it has none)."""
    value = tag.get("class")
    return list(value) if value else []


def _has_class_prefix(tag: Tag, prefix: str) -> bool:
    """True when any class token of the tag starts with the given prefix (CSS-module hashes vary)."""
    return any(token.startswith(prefix) for token in _classes(tag))


def _direct_children(tag: Tag) -> List[Tag]:
    """Return the element children of a tag."""
    return [child for child in tag.children if isinstance(child, Tag)]


def flatten_text(tag: Tag, exclude=lambda child: False) -> str:
    """Return the normalised text of a tag, skipping excluded descendants.

    Block-level children are separated by spaces so adjacent paragraphs do not fuse; inline children
    are concatenated verbatim so ``<code>a</code>b`` stays ``ab``.
    """
    parts: List[str] = []

    def visit(node: Tag) -> None:
        for child in node.children:
            if isinstance(child, Tag):
                if exclude(child):
                    continue
                is_block = child.name in _BLOCK_NAMES
                if is_block:
                    parts.append(" ")
                visit(child)
                if is_block:
                    parts.append(" ")
            elif type(child) in _TEXT_NODE_TYPES:
                parts.append(str(child))

    visit(tag)
    return normalise_text("".join(parts))


# ------------------------------------------------------- URL and file resolution


def normalise_base_url(base_url: str) -> str:
    """Return the base URL with a leading and a trailing slash; reject anything that is not a path."""
    if not base_url.startswith("/") or "//" in base_url or urlsplit(base_url).scheme:
        raise ValueError(f"--base-url must be an absolute URL path such as /en/latest/, got {base_url!r}")
    return base_url if base_url.endswith("/") else base_url + "/"


class ResolvedUrl(NamedTuple):
    """A URL resolved against the page it appears on.

    ``target`` is base-relative (fragment and query kept) for internal URLs, or the raw URL for
    external ones. ``site_path`` is the base-relative path without query/fragment (None if external or
    outside the base URL).
    """

    target: str
    site_path: Optional[str]


def normalise_site_origin(origin: str) -> str:
    """Return a bare ``scheme://host[:port]`` origin without a trailing slash; reject anything else."""
    parts = urlsplit(origin)
    if (parts.scheme not in ("http", "https") or not parts.netloc or "@" in parts.netloc
            or parts.path not in ("", "/") or parts.query or parts.fragment):
        raise ValueError(f"--site-origin must be a bare http(s) origin such as https://ob.docs.wso2.com, got {origin!r}")
    return f"{parts.scheme}://{parts.netloc}".lower()


def resolve_url(raw_url: str, page_url: str, base_url: str, site_origin: Optional[str] = None) -> ResolvedUrl:
    """Resolve ``raw_url`` against ``page_url`` and express it relative to ``base_url``.

    With ``site_origin``, an absolute URL on that origin is the same URL for a reader as the matching
    root-relative one, so it is resolved as a path (MkDocs writes ``/x``, Docusaurus needs ``https://origin/x``).
    """
    raw_url = raw_url.strip()
    joined = urlsplit(urljoin(page_url, raw_url))
    if site_origin and joined.scheme and f"{joined.scheme}://{joined.netloc}".lower() == site_origin:
        joined = joined._replace(scheme="", netloc="")
    if joined.scheme or joined.netloc:
        return ResolvedUrl(raw_url, None)
    path = joined.path if joined.path.startswith("/") else "/" + joined.path  # urljoin drops the slash when ".." clamps at the root
    if path.startswith(base_url):
        site_path = path[len(base_url):]
    elif path + "/" == base_url:
        site_path = ""
    else:
        return ResolvedUrl(path + ("?" + joined.query if joined.query else "")
                           + ("#" + joined.fragment if joined.fragment else ""), None)
    target = site_path
    if joined.query:
        target += "?" + joined.query
    if joined.fragment:
        target += "#" + joined.fragment
    return ResolvedUrl(target, site_path)


def resolve_inside_site(site_dir: Path, site_path: str) -> Optional[Path]:
    """Map a base-relative URL path to a file system path, or None if it would leave ``site_dir``."""
    try:
        root = site_dir.resolve()
        candidate = (root / unquote(site_path)).resolve()
    except (OSError, ValueError):
        return None
    if candidate != root and root not in candidate.parents:
        return None
    return candidate


def site_path_exists(site_dir: Path, site_path: str) -> bool:
    """True when a base-relative URL path is served by the site (file, directory index or .html)."""
    candidate = resolve_inside_site(site_dir, site_path)
    if candidate is None:
        return False
    try:
        if site_path == "" or site_path.endswith("/"):
            return (candidate / "index.html").is_file()
        if site_path.endswith(".md"):
            return False  # the llms.txt plugin's per-page Markdown copies are not pages
        return (candidate.is_file() or (candidate / "index.html").is_file()
                or candidate.with_name(candidate.name + ".html").is_file())
    except (OSError, ValueError):
        return False


def sha256_of_site_file(site_dir: Path, site_path: str) -> Optional[str]:
    """SHA-256 of a file inside the site directory, or None if it is absent or outside the site."""
    candidate = resolve_inside_site(site_dir, site_path)
    if candidate is None:
        return None
    try:
        if not candidate.is_file():
            return None
        digest = hashlib.sha256()
        with candidate.open("rb") as handle:
            for chunk in iter(lambda: handle.read(_IMAGE_READ_CHUNK), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except (OSError, ValueError):
        LOGGER.warning("could not read image file site_path=%s", site_path)
        return None


# ------------------------------------------------------------- flavour rules


class Admonition(NamedTuple):
    """An admonition/details container together with its model entry and its chrome elements."""

    container: Tag
    model: Dict[str, object]
    chrome: Sequence[Tag]


class TabGroup(NamedTuple):
    """A tab group container, its tab model entries and its chrome elements (labels, inputs...)."""

    container: Tag
    tabs: List[Dict[str, str]]
    chrome: Sequence[Tag]


class Flavor:
    """Extraction rules that differ between the MkDocs and the Docusaurus markup."""

    name = ""
    noise_selectors: Tuple[str, ...] = ()

    def content_root(self, soup: BeautifulSoup) -> Optional[Tag]:
        """Return the element holding the page content, or None when the page has none."""
        raise NotImplementedError

    def admonitions(self, root: Tag) -> List[Admonition]:
        """Return every admonition and details block under ``root`` in document order."""
        raise NotImplementedError

    def tab_groups(self, root: Tag) -> List[TabGroup]:
        """Return every tab group under ``root`` in document order."""
        raise NotImplementedError

    def ignorable_elements(self, root: Tag) -> List[Tag]:
        """Return elements that are verification scaffolding, not content (none by default)."""
        return []

    def code_text(self, pre: Tag) -> str:
        """Return the raw text of a ``<pre>`` code block (before ``finalise_code``)."""
        raise NotImplementedError


def _admonition_model(kind: str, admonition_type: str, title: str, is_open: Optional[bool]) -> Dict[str, object]:
    """Build an admonition model entry; the title is casefolded (default titles differ in case only)."""
    return {"kind": kind, "type": admonition_type, "title": title.casefold(), "open": is_open}


class MkDocsFlavor(Flavor):
    """MkDocs 1.1 / Material 4.6 markup (``article.md-content__inner``)."""

    name = "mkdocs"
    noise_selectors = ("a.headerlink", "a.md-content__icon", "a.cd-top")

    def content_root(self, soup: BeautifulSoup) -> Optional[Tag]:
        """The Material article body."""
        return soup.select_one("article.md-content__inner")

    def admonitions(self, root: Tag) -> List[Admonition]:
        """``div.admonition.<type>`` with ``p.admonition-title``, and ``details.<type>`` with ``summary``."""
        found: List[Admonition] = []
        for tag in root.find_all(lambda t: t.name == "details" or (t.name == "div" and "admonition" in _classes(t))):
            if tag.name == "details":
                summary = next((c for c in _direct_children(tag) if c.name == "summary"), None)
                types = _classes(tag)
                model = _admonition_model(
                    "details", types[0] if types else "",
                    flatten_text(summary) if summary else "", tag.has_attr("open"),
                )
                found.append(Admonition(tag, model, [summary] if summary else []))
                continue
            title = next((c for c in _direct_children(tag) if c.name == "p" and "admonition-title" in _classes(c)), None)
            types = [token for token in _classes(tag) if token != "admonition"]
            model = _admonition_model(
                "admonition", types[0] if types else "", flatten_text(title) if title else "", None
            )
            found.append(Admonition(tag, model, [title] if title else []))
        return found

    def tab_groups(self, root: Tag) -> List[TabGroup]:
        """Legacy ``div.superfences-tabs``: ``input``/``label``/``div.superfences-content`` triples.

        Icon-only toggles (``label.tab-selector``, used by the config catalog) are not tabs; their
        code is still part of the page ``code`` list.
        """
        groups: List[TabGroup] = []
        for container in root.select("div.superfences-tabs"):
            children = _direct_children(container)
            labels = [c for c in children if c.name == "label"]
            panels = [c for c in children if c.name == "div" and "superfences-content" in _classes(c)]
            if len(labels) != len(panels):
                raise ExtractionError("superfences-tabs with unequal labels and panels")
            tabs = [
                {"label": flatten_text(label), "code": _panel_code(panel, self)}
                for label, panel in zip(labels, panels)
                if "tab-selector" not in _classes(label)
            ]
            chrome = [c for c in children if c.name in ("input", "label")]
            groups.append(TabGroup(container, tabs, chrome))
        return groups

    def code_text(self, pre: Tag) -> str:
        """Plain text: codehilite runs with ``use_pygments: false`` so there is no token markup."""
        return pre.get_text()


class DocusaurusFlavor(Flavor):
    """Docusaurus 3 markup (``article .theme-doc-markdown``)."""

    name = "docusaurus"
    noise_selectors = ("a.hash-link", "button", "svg")
    #: The loading placeholder that ``RedocSpec`` renders on the server (src/components/RedocSpec).
    REDOC_FALLBACK_TEXT = "Loading the API reference..."

    def ignorable_elements(self, root: Tag) -> List[Tag]:
        """The ``RedocSpec`` server-rendered fallback, and nothing else.

        ``data-verify-ignore`` is honoured only on a ``<p>`` that is the sole element of the content root
        and reads exactly the placeholder text. Anywhere else the attribute hides nothing, so content
        cannot be dropped from the comparison by carrying it.
        """
        children = _direct_children(root)
        if len(children) != 1:
            return []
        fallback = children[0]
        if (fallback.name == "p" and fallback.has_attr("data-verify-ignore")
                and flatten_text(fallback) == self.REDOC_FALLBACK_TEXT):
            return [fallback]
        return []

    def content_root(self, soup: BeautifulSoup) -> Optional[Tag]:
        """The markdown container, which also holds the synthetic ``header > h1``."""
        return soup.select_one("article .theme-doc-markdown")

    def admonitions(self, root: Tag) -> List[Admonition]:
        """``div.theme-admonition-<type>`` with an ``admonitionHeading_*`` child, and ``details.ob-details--<type>``."""
        found: List[Admonition] = []
        for tag in root.find_all(lambda t: t.name == "details" or (t.name == "div" and "theme-admonition" in _classes(t))):
            if tag.name == "details":
                summary = next((c for c in _direct_children(tag) if c.name == "summary"), None)
                types = [t[len("ob-details--"):] for t in _classes(tag) if t.startswith("ob-details--")]
                is_open = tag.has_attr("open") or tag.get("data-collapsed") == "false"
                model = _admonition_model(
                    "details", types[0] if types else "", flatten_text(summary) if summary else "", is_open
                )
                found.append(Admonition(tag, model, [summary] if summary else []))
                continue
            heading = next((c for c in _direct_children(tag) if _has_class_prefix(c, "admonitionHeading")), None)
            types = [t[len("theme-admonition-"):] for t in _classes(tag) if t.startswith("theme-admonition-")]
            model = _admonition_model(
                "admonition", types[0] if types else "", flatten_text(heading) if heading else "", None
            )
            found.append(Admonition(tag, model, [heading] if heading else []))
        return found

    def tab_groups(self, root: Tag) -> List[TabGroup]:
        """``div.tabs-container``: ``ul[role=tablist]`` labels paired in order with ``div[role=tabpanel]``."""
        groups: List[TabGroup] = []
        for container in root.select("div.tabs-container"):
            children = _direct_children(container)
            tablist = next((c for c in children if c.name == "ul" and c.get("role") == "tablist"), None)
            panel_holder = next((c for c in children if c.name == "div"), None)
            if tablist is None or panel_holder is None:
                raise ExtractionError("tabs-container without tablist or panel container")
            labels = [c for c in _direct_children(tablist) if c.get("role") == "tab"]
            panels = [c for c in _direct_children(panel_holder) if c.get("role") == "tabpanel"]
            if len(labels) != len(panels):
                raise ExtractionError("tabs-container with unequal tabs and panels")
            tabs = [
                {"label": flatten_text(label), "code": _panel_code(panel, self)}
                for label, panel in zip(labels, panels)
            ]
            groups.append(TabGroup(container, tabs, [tablist]))
        return groups

    def code_text(self, pre: Tag) -> str:
        """Join the Prism ``.token-line`` lines (``div`` since Docusaurus 3.x, ``span`` before) (with or without trailing ``<br>``/newline)."""
        for number in pre.select('[class*="codeLineNumber"]'):
            number.decompose()
        lines = pre.select(".token-line")
        if not lines:
            return pre.get_text()
        texts = []
        for line in lines:
            content = line.select_one('[class*="codeLineContent"]') or line
            texts.append(content.get_text().rstrip("\n"))
        return "\n".join(texts)


FLAVORS: Dict[str, Flavor] = {flavor.name: flavor for flavor in (MkDocsFlavor(), DocusaurusFlavor())}


def _panel_code(panel: Tag, flavor: Flavor) -> str:
    """The code of a tab panel: each ``<pre>`` normalised, joined by a newline."""
    return "\n".join(finalise_code(flavor.code_text(pre)) for pre in panel.find_all("pre"))


# --------------------------------------------------------------- model builder


def _structural_names_excluded(structural_ids: Set[int]):
    """Exclusion predicate for list-item text: nested lists, code, tables, headings and containers."""

    def exclude(child: Tag) -> bool:
        return (child.name in _LIST_NAMES or child.name in _HEADING_NAMES
                or child.name in ("pre", "table") or id(child) in structural_ids)

    return exclude


def collect_blocks(root: Tag, structural_ids: Set[int]) -> List[str]:
    """Collect paragraph-level text outside headings, code, tables and list items.

    List-item text belongs to the ``lists`` model, so it is not repeated here (this keeps tight and
    loose lists identical). Content of admonitions, details and tab panels nested in list items is
    still emitted because it is not part of the item text.
    """
    blocks: List[str] = []
    buffer: List[str] = []

    def flush() -> None:
        text = normalise_text("".join(buffer))
        buffer.clear()
        if text:
            blocks.append(text)

    def visit(node: Tag, emit: bool) -> None:
        for child in node.children:
            if isinstance(child, Tag):
                if child.name in _HEADING_NAMES or child.name in ("pre", "table"):
                    flush()
                elif child.name in _LIST_NAMES:
                    flush()
                    for item in child.find_all("li", recursive=False):
                        visit(item, False)
                else:
                    separate = child.name in _BLOCK_NAMES or id(child) in structural_ids
                    if separate:
                        flush()
                    visit(child, emit or id(child) in structural_ids)
                    if separate:
                        flush()
            elif emit and type(child) in _TEXT_NODE_TYPES:
                buffer.append(str(child))

    visit(root, True)
    flush()
    return blocks


def _extract_lists(root: Tag, structural_ids: Set[int]) -> List[Dict[str, object]]:
    """One entry per ``ul``/``ol``: ordered, start (ol only, default 1), nesting depth, item texts."""
    exclude = _structural_names_excluded(structural_ids)
    lists = []
    for list_tag in root.find_all(list(_LIST_NAMES)):
        ordered = list_tag.name == "ol"
        start = None
        if ordered:
            try:
                start = int(list_tag.get("start", 1))
            except (TypeError, ValueError):
                start = 1
        lists.append({
            "ordered": ordered,
            "start": start,
            "depth": sum(1 for parent in list_tag.parents if parent.name in _LIST_NAMES),
            "items": [flatten_text(item, exclude) for item in list_tag.find_all("li", recursive=False)],
        })
    return lists


def _extract_tables(root: Tag) -> List[List[List[str]]]:
    """One entry per table: rows of normalised cell texts."""
    return [
        [[flatten_text(cell) for cell in row.find_all(["th", "td"], recursive=False)] for row in table.find_all("tr")]
        for table in root.find_all("table")
    ]


def _sha256_of_data_uri(src: str) -> Optional[str]:
    """SHA-256 of the bytes of a ``data:<mime>;base64,<payload>`` URI, or None when it is not valid base64."""
    header, _, payload = src.partition(",")
    if not header.lower().endswith(";base64"):
        return None
    try:
        return hashlib.sha256(base64.b64decode(payload, validate=True)).hexdigest()
    except (binascii.Error, ValueError):
        return None


def _extract_images(root: Tag, site_dir: Path, page_url: str, base_url: str,
                    site_origin: Optional[str] = None) -> List[Dict[str, str]]:
    """One entry per ``<img>``: SHA-256 of the file bytes (or MISSING:/EXTERNAL: markers) and alt text.

    Small images that webpack inlines as base64 ``data:`` URIs are hashed from their decoded bytes.
    """
    images = []
    for image in root.find_all("img"):
        src = image.get("src", "").strip()
        if src[:5].lower() == "data:":
            digest = _sha256_of_data_uri(src) or "MISSING:data:invalid-uri"
            images.append({"sha256": digest, "alt": normalise_text(image.get("alt", ""))})
            continue
        resolved = resolve_url(src, page_url, base_url, site_origin)
        if resolved.site_path is None:
            digest = f"EXTERNAL:{resolved.target}"
        else:
            digest = sha256_of_site_file(site_dir, resolved.site_path) or f"MISSING:{resolved.target}"
        images.append({"sha256": digest, "alt": normalise_text(image.get("alt", ""))})
    return images


def _link_entry(text: str, href: str, site_dir: Path, page_url: str, base_url: str,
                site_origin: Optional[str]) -> Dict[str, object]:
    """One ``links`` entry: text, base-relative target and whether an internal target exists."""
    resolved = resolve_url(href, page_url, base_url, site_origin)
    exists = None if resolved.site_path is None else site_path_exists(site_dir, resolved.site_path)
    if urlsplit(href.strip()).scheme:  # mailto:, tel:, javascript: ... are neither files nor pages
        exists = None
    return {"text": text, "target": resolved.target, "exists": exists}


def _extract_links(root: Tag, site_dir: Path, page_url: str, base_url: str,
                   site_origin: Optional[str] = None) -> List[Dict[str, object]]:
    """One entry per ``<a href>``: text, base-relative target and whether an internal target exists."""
    return [
        _link_entry(flatten_text(anchor), anchor["href"], site_dir, page_url, base_url, site_origin)
        for anchor in root.find_all("a", href=True)
    ]


def _extract_iframe_links(root: Tag, site_dir: Path, page_url: str, base_url: str,
                          site_origin: Optional[str] = None) -> List[Dict[str, object]]:
    """One entry per ``<iframe src>`` (empty text), in document order.

    Iframes are dropped from the text as noise, so their ``src`` is the only record of an embed; call
    this before the noise is removed. Iframes inside ``<noscript>`` (the tag manager fallback) are chrome.
    """
    return [
        _link_entry("", frame["src"], site_dir, page_url, base_url, site_origin)
        for frame in root.find_all("iframe", src=True)
        if frame.find_parent("noscript") is None
    ]


_ONCLICK_LOCATION = re.compile(r"""\blocation(?:\.href)?\s*=\s*(['"])(.*?)\1""")


def _extract_onclick_targets(root: Tag, page_url: str, base_url: str, site_origin: Optional[str]) -> List[str]:
    """Targets of ``onclick="location.href='...'"`` handlers (cards), resolved like hrefs, in document order.

    Never executed, only read; handlers that do anything else are ignored.
    """
    targets = []
    for element in root.find_all(attrs={"onclick": True}):
        match = _ONCLICK_LOCATION.search(element["onclick"])
        if match:
            targets.append(resolve_url(match.group(2), page_url, base_url, site_origin).target)
    return targets


def _remove(tags: Sequence[Tag]) -> None:
    """Decompose tags, tolerating ones already removed together with an ancestor."""
    for tag in tags:
        if not tag.decomposed:
            tag.decompose()


def extract_page(html: str, *, flavor: str, path: str, site_dir: Path, base_url: str,
                 site_origin: Optional[str] = None) -> Optional[Dict[str, object]]:
    """Build the content model of one page.

    Args:
        html: the page HTML (parsed only, never executed).
        flavor: ``mkdocs`` or ``docusaurus``.
        path: the page URL path relative to ``base_url`` (``""`` for the site root).
        site_dir: the built site directory, used to resolve images and links on disk.
        base_url: the URL path the site is served under, e.g. ``/en/latest/``.
        site_origin: optional bare origin of the published site; absolute URLs on it are read as root-relative.

    Returns:
        The model dictionary, or None when the page has no content root (404, search, ...).

    Raises:
        ValueError: for an unknown flavor or an invalid base URL.
        ExtractionError: for tab markup that is not one of the known shapes.
    """
    if flavor not in FLAVORS:
        raise ValueError(f"unknown flavor {flavor!r}; expected one of {sorted(FLAVORS)}")
    rules = FLAVORS[flavor]
    base_url = normalise_base_url(base_url)
    site_origin = normalise_site_origin(site_origin) if site_origin else None
    page_url = base_url + path

    root = rules.content_root(BeautifulSoup(html, "lxml"))
    if root is None:
        return None
    # Iframes are noise for the text but their src is content: record it before they are removed.
    iframe_links = _extract_iframe_links(root, site_dir, page_url, base_url, site_origin)
    _remove(rules.ignorable_elements(root))
    for selector in _COMMON_NOISE_SELECTORS + rules.noise_selectors:
        _remove(root.select(selector))

    onclick_targets = _extract_onclick_targets(root, page_url, base_url, site_origin)
    headings = [
        [int(heading.name[1]), flatten_text(heading), heading.get("id", "")]
        for heading in root.find_all(list(_HEADING_NAMES))
    ]
    admonitions = rules.admonitions(root)
    tab_groups = rules.tab_groups(root)

    structural_ids = {id(item.container) for item in admonitions} | {id(group.container) for group in tab_groups}
    for chrome in [c for item in admonitions for c in item.chrome] + [c for group in tab_groups for c in group.chrome]:
        _remove([chrome])

    # After chrome and noise removal and before any extractor touches the tree: the page text in
    # document order, the evidence of the list-restructure-text-preserved rule.
    flow = flatten_text(root)

    model: Dict[str, object] = {
        "path": path,
        "title": next((entry[1] for entry in headings if entry[0] == 1), ""),
        "headings": headings,
        "blocks": collect_blocks(root, structural_ids),
        "code": [finalise_code(rules.code_text(pre)) for pre in root.find_all("pre")],
        "tables": _extract_tables(root),
        "lists": _extract_lists(root, structural_ids),
        "admonitions": [item.model for item in admonitions],
        "images": _extract_images(root, site_dir, page_url, base_url, site_origin),
        "links": _extract_links(root, site_dir, page_url, base_url, site_origin) + iframe_links,
        "tabs": [tab for group in tab_groups for tab in group.tabs],
        "onclick_targets": onclick_targets,  # not compared as a field; evidence for the onclick-card-link rule
        "flow": flow,  # not compared as a field; evidence for the list-restructure-text-preserved rule
    }
    return model


def page_path_for(relative_file: PurePosixPath) -> str:
    """Map a site-relative HTML file to its page URL path (``a/b/index.html`` -> ``a/b/``)."""
    if relative_file.name == "index.html":
        parent = relative_file.parent.as_posix()
        return "" if parent == "." else parent + "/"
    return relative_file.as_posix()


def extract_site(site_dir: Path, flavor: str, base_url: str, site_origin: Optional[str] = None) -> Iterator[Dict[str, object]]:
    """Yield the model of every page of a built site, in path order; pages without content are skipped."""
    site_dir = Path(site_dir)
    skipped = 0
    for directory, directory_names, file_names in os.walk(site_dir, followlinks=False):
        directory_names.sort()
        for file_name in sorted(file_names):
            if not file_name.endswith(".html"):
                continue
            if file_name == "404.html" and Path(directory) == site_dir:
                continue  # the site-wide error page is chrome, not documentation content
            file_path = Path(directory) / file_name
            relative = PurePosixPath(file_path.relative_to(site_dir).as_posix())
            html = file_path.read_text(encoding="utf-8")
            model = extract_page(html, flavor=flavor, path=page_path_for(relative), site_dir=site_dir, base_url=base_url,
                                 site_origin=site_origin)
            if model is None:
                skipped += 1
                LOGGER.info("skipped page without content root file=%s", relative)
                continue
            yield model
    LOGGER.info("extraction finished flavor=%s skipped_pages=%d", flavor, skipped)


# -------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    """Command-line parser for ``extract.py``."""
    parser = argparse.ArgumentParser(description="Extract a normalised content model (JSON Lines) from a built site.")
    parser.add_argument("--flavor", required=True, choices=sorted(FLAVORS))
    parser.add_argument("--site", required=True, type=Path, help="directory of the built site")
    parser.add_argument("--base-url", default="/", help="URL path the site is served under (default: /)")
    parser.add_argument("--site-origin", default=None,
                        help="bare origin of the published site, e.g. https://ob.docs.wso2.com; absolute URLs on it "
                             "are read as root-relative")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Write one JSON object per page to stdout; return the process exit code."""
    import json

    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s %(message)s")
    args = build_parser().parse_args(argv)
    if not args.site.is_dir():
        LOGGER.error("site directory not found site=%s", args.site)
        return 2
    try:
        normalise_base_url(args.base_url)
        if args.site_origin:
            normalise_site_origin(args.site_origin)
    except ValueError as error:
        LOGGER.error("%s", error)
        return 2

    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    seen_paths: Set[str] = set()
    count = 0
    try:
        for model in extract_site(args.site, args.flavor, args.base_url, args.site_origin):
            if model["path"] in seen_paths:
                LOGGER.error("duplicate page path path=%s", model["path"])
                return 1
            seen_paths.add(model["path"])
            sys.stdout.write(json.dumps(model, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    except (ExtractionError, UnicodeDecodeError, OSError) as error:
        LOGGER.error("extraction failed: %s", error)
        return 1
    if count == 0:
        LOGGER.error("no pages with a content root were found site=%s", args.site)
        return 1
    LOGGER.info("pages extracted count=%d", count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
