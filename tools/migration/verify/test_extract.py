"""Tests for extract.py: both flavours must normalise to the same content model."""

import base64
import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

import extract

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
BASE_URL = "/en/latest/"
PAGE_PATH = "learn/sample/"
PNG_SHA256 = "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77"


def extract_fixture(flavor, path=PAGE_PATH):
    """Extract one page of a fixture site into its content model."""
    site = FIXTURES / ("mkdocs-site" if flavor == "mkdocs" else "docusaurus-site")
    html = (site / path / "index.html").read_text(encoding="utf-8")
    return extract.extract_page(html, flavor=flavor, path=path, site_dir=site, base_url=BASE_URL)


def mkdocs_page(tmp_path, body, path=PAGE_PATH):
    """Extract a MkDocs-shaped page built from the given article body."""
    html = f'<html><body><article class="md-content__inner md-typeset">{body}</article></body></html>'
    return extract.extract_page(html, flavor="mkdocs", path=path, site_dir=tmp_path, base_url=BASE_URL)


def docusaurus_page(tmp_path, body, path=PAGE_PATH):
    """Extract a Docusaurus-shaped page built from the given markdown body."""
    html = f'<html><body><article><div class="theme-doc-markdown markdown">{body}</div></article></body></html>'
    return extract.extract_page(html, flavor="docusaurus", path=path, site_dir=tmp_path, base_url=BASE_URL)


# ---------------------------------------------------------------- fixtures


def test_fixture_pages_extract_to_identical_models_except_list_start():
    mkdocs_model = extract_fixture("mkdocs")
    docusaurus_model = extract_fixture("docusaurus")

    assert [entry["start"] for entry in mkdocs_model["lists"]] == [1]
    assert [entry["start"] for entry in docusaurus_model["lists"]] == [3]
    for model in (mkdocs_model, docusaurus_model):
        for entry in model["lists"]:
            entry["start"] = None
    assert mkdocs_model == docusaurus_model


def test_fixture_model_has_expected_content():
    model = extract_fixture("mkdocs")

    assert model["path"] == PAGE_PATH
    assert model["title"] == "Sample page"
    assert model["headings"] == [[1, "Sample page", ""], [2, "Setup", "setup"]]
    assert model["blocks"] == [
        "Intro with a link, inline code and a site.",
        "Admonition body.",
    ]
    assert model["code"] == ["public class A {\n    int x;\n\n}"]
    assert model["lists"] == [
        {"ordered": True, "start": 1, "depth": 0, "items": ["Third step", "Fourth step"]}
    ]
    assert model["admonitions"] == [
        {"kind": "admonition", "type": "note", "title": "note", "open": None}
    ]
    assert model["images"] == [{"sha256": PNG_SHA256, "alt": "Diagram"}]
    assert model["links"] == [
        {"text": "a link", "target": "learn/other/#part", "exists": True},
        {"text": "site", "target": "https://example.com/ext", "exists": None},
    ]
    assert model["tables"] == []
    assert model["tabs"] == []


def test_extract_site_keys_pages_by_base_relative_path_and_skips_pages_without_content():
    pages = {
        page["path"]
        for page in extract.extract_site(FIXTURES / "docusaurus-site", "docusaurus", BASE_URL)
    }
    assert pages == {"learn/sample/", "learn/other/"}


def test_site_root_404_page_is_not_a_documentation_page(tmp_path):
    (tmp_path / "404.html").write_text(
        '<html><body><article class="md-content__inner"><h1>404</h1></article></body></html>', encoding="utf-8"
    )
    assert list(extract.extract_site(tmp_path, "mkdocs", "/")) == []


def test_cli_writes_one_json_object_per_line():
    completed = subprocess.run(
        [
            sys.executable, "-I", str(HERE / "extract.py"),
            "--flavor", "mkdocs",
            "--site", str(FIXTURES / "mkdocs-site"),
            "--base-url", BASE_URL,
        ],
        capture_output=True, text=True, check=True,
    )
    pages = [json.loads(line) for line in completed.stdout.splitlines()]
    assert [page["path"] for page in pages] == ["learn/other/", "learn/sample/"]


def test_cli_fails_for_missing_site_directory(tmp_path):
    completed = subprocess.run(
        [
            sys.executable, "-I", str(HERE / "extract.py"),
            "--flavor", "mkdocs", "--site", str(tmp_path / "nope"), "--base-url", "/",
        ],
        capture_output=True, text=True,
    )
    assert completed.returncode != 0


# ----------------------------------------------------------- normalisation


def test_heading_text_drops_permalink_zero_width_and_pilcrow(tmp_path):
    mkdocs_model = mkdocs_page(
        tmp_path,
        '<h2 id="a-b">Café   Setup<a class="headerlink" href="#a-b" title="Permanent link">&para;</a></h2>',
    )
    docusaurus_model = docusaurus_page(
        tmp_path,
        '<h2 class="anchor anchorWithStickyNavbar_x1" id="a-b">Café Setup<a href="#a-b" class="hash-link" '
        'aria-label="Direct link to Café Setup" title="Direct link to x">​</a></h2>',
    )
    assert mkdocs_model["headings"] == [[2, "Café Setup", "a-b"]]
    assert docusaurus_model["headings"] == mkdocs_model["headings"]


def test_title_falls_back_to_empty_when_page_has_no_h1(tmp_path):
    assert mkdocs_page(tmp_path, "<p>Only text</p>")["title"] == ""


def test_code_lines_are_right_stripped_and_outer_blank_lines_trimmed(tmp_path):
    mkdocs_model = mkdocs_page(
        tmp_path, "<pre><code class=\"java\">\n\n  a  \n\n  b\t\n\n</code></pre>"
    )
    assert mkdocs_model["code"] == ["  a\n\n  b"]


def test_docusaurus_code_reads_token_lines_with_or_without_br(tmp_path):
    with_br = (
        '<pre class="prism-code language-xml"><code class="codeBlockLines_a">'
        '<span class="token-line"><span class="token tag">&lt;a&gt;</span><br></span>'
        '<span class="token-line"><span class="token plain"></span><br></span>'
        '<span class="token-line"><span class="token tag">&lt;/a&gt;</span><br></span></code></pre>'
    )
    with_newline = (
        '<pre class="prism-code language-xml"><code class="codeBlockLines_a">'
        '<span class="token-line"><span class="token tag">&lt;a&gt;</span>\n</span>'
        '<span class="token-line"><span class="token plain">\n</span></span>'
        '<span class="token-line"><span class="token tag">&lt;/a&gt;</span>\n</span></code></pre>'
    )
    expected = ["<a>\n\n</a>"]
    assert docusaurus_page(tmp_path, with_br)["code"] == expected
    assert docusaurus_page(tmp_path, with_newline)["code"] == expected


def test_docusaurus_code_reads_div_token_lines(tmp_path):
    """Docusaurus 3.10 renders each Prism line as ``div.token-line`` (older releases used a span)."""
    div_lines = (
        '<pre class="prism-code language-toml"><code class="codeBlockLines_a">'
        '<div class="token-line"><span class="token plain">[section]</span><br></div>'
        '<div class="token-line"><span class="token plain">key = "value"</span><br></div></code></pre>'
    )
    assert docusaurus_page(tmp_path, div_lines)["code"] == ['[section]\nkey = "value"']


def test_docusaurus_copy_buttons_are_not_content(tmp_path):
    model = docusaurus_page(
        tmp_path,
        '<p>Text</p><button type="button" aria-label="Copy code to clipboard" class="clean-btn">Copy</button>',
    )
    assert model["blocks"] == ["Text"]


def test_script_style_and_noscript_are_not_content(tmp_path):
    model = mkdocs_page(
        tmp_path,
        "<p>Text</p><script>var a = 1;</script><style>p {}</style>"
        "<noscript><iframe src=\"https://example.com\"></iframe></noscript>",
    )
    assert model["blocks"] == ["Text"]


def test_unknown_placeholder_elements_are_transparent_in_mkdocs(tmp_path):
    model = mkdocs_page(tmp_path, "<p>Go to <APIM_HOME>/repository now</p>")
    assert model["blocks"] == ["Go to /repository now"]


def test_html_comments_are_ignored(tmp_path):
    assert mkdocs_page(tmp_path, "<p>Text<!-- hidden --> more</p>")["blocks"] == ["Text more"]


# --------------------------------------------------------- admonitions etc.


def test_admonition_kinds_types_titles_and_open_state(tmp_path):
    mkdocs_model = mkdocs_page(
        tmp_path,
        '<div class="admonition tip"><p class="admonition-title">Before you begin</p><p>Body one.</p></div>'
        '<details class="tip adding mock"><summary>Click here</summary><p>Body two.</p></details>'
        '<details class="warning" open="open"><summary>Careful</summary><p>Body three.</p></details>',
    )
    docusaurus_model = docusaurus_page(
        tmp_path,
        '<div class="theme-admonition theme-admonition-tip admonition_a alert alert--success">'
        '<div class="admonitionHeading_b"><span class="admonitionIcon_c"><svg></svg></span>Before you begin</div>'
        '<div class="admonitionContent_d"><p>Body one.</p></div></div>'
        '<details class="details_a isBrowser_b alert alert--info ob-details ob-details--tip" data-collapsed="true">'
        '<summary>Click here</summary><div><p>Body two.</p></div></details>'
        '<details class="details_a isBrowser_b alert alert--warning ob-details ob-details--warning" '
        'data-collapsed="false" open=""><summary>Careful</summary><div><p>Body three.</p></div></details>',
    )
    assert mkdocs_model["admonitions"] == [
        {"kind": "admonition", "type": "tip", "title": "before you begin", "open": None},
        {"kind": "details", "type": "tip", "title": "click here", "open": False},
        {"kind": "details", "type": "warning", "title": "careful", "open": True},
    ]
    assert docusaurus_model["admonitions"] == mkdocs_model["admonitions"]
    assert docusaurus_model["blocks"] == mkdocs_model["blocks"] == ["Body one.", "Body two.", "Body three."]


def test_default_admonition_titles_match_case_insensitively(tmp_path):
    mkdocs_model = mkdocs_page(
        tmp_path, '<div class="admonition note"><p class="admonition-title">Note</p><p>x</p></div>'
    )
    docusaurus_model = docusaurus_page(
        tmp_path,
        '<div class="theme-admonition theme-admonition-note alert"><div class="admonitionHeading_b">note</div>'
        '<div class="admonitionContent_d"><p>x</p></div></div>',
    )
    assert mkdocs_model["admonitions"] == docusaurus_model["admonitions"]


# ------------------------------------------------------------------ lists


def test_nested_list_depth_and_item_text_exclude_nested_items(tmp_path):
    model = mkdocs_page(
        tmp_path,
        "<ul><li>outer<ul><li>inner one</li><li><p>inner</p><p>two</p></li></ul></li></ul>",
    )
    assert model["lists"] == [
        {"ordered": False, "start": None, "depth": 0, "items": ["outer"]},
        {"ordered": False, "start": None, "depth": 1, "items": ["inner one", "inner two"]},
    ]
    assert model["blocks"] == []


def test_tight_and_loose_list_items_yield_the_same_model(tmp_path):
    tight = mkdocs_page(tmp_path, "<ol><li>one</li><li>two</li></ol>")
    loose = docusaurus_page(tmp_path, "<ol><li><p>one</p></li><li><p>two</p></li></ol>")
    assert tight["lists"] == loose["lists"]
    assert tight["blocks"] == loose["blocks"] == []


def test_admonition_inside_list_item_contributes_blocks_not_item_text(tmp_path):
    model = mkdocs_page(
        tmp_path,
        '<ol><li><p>Step</p><div class="admonition note"><p class="admonition-title">Note</p>'
        "<p>Inside.</p></div></li></ol>",
    )
    assert model["lists"][0]["items"] == ["Step"]
    assert model["blocks"] == ["Inside."]


# ----------------------------------------------------------------- tables


def test_table_cells_are_extracted_and_not_repeated_in_blocks(tmp_path):
    model = mkdocs_page(
        tmp_path,
        "<table><thead><tr><th>Name</th><th>Type</th></tr></thead>"
        "<tbody><tr><td>id  <code>x</code></td><td>string</td></tr></tbody></table>",
    )
    assert model["tables"] == [[["Name", "Type"], ["id x", "string"]]]
    assert model["blocks"] == []


# ------------------------------------------------------------------- tabs


def test_legacy_mkdocs_tabs_and_docusaurus_tabs_match(tmp_path):
    mkdocs_model = mkdocs_page(
        tmp_path,
        '<div class="superfences-tabs">'
        '<input name="__tabs_1" type="radio" id="__tab_1_0" checked="checked" /><label for="__tab_1_0">Java</label>'
        '<div class="superfences-content"><pre><code class="java">int a;\n</code></pre></div>'
        '<input name="__tabs_1" type="radio" id="__tab_1_1" /><label for="__tab_1_1">Shell</label>'
        '<div class="superfences-content"><pre><code class="shell">ls  \n</code></pre></div></div>',
    )
    docusaurus_model = docusaurus_page(
        tmp_path,
        '<div class="tabs-container tabList_x"><ul role="tablist" aria-orientation="horizontal" class="tabs">'
        '<li role="tab" tabindex="0" aria-selected="true" class="tabs__item tabs__item--active">Java</li>'
        '<li role="tab" tabindex="-1" aria-selected="false" class="tabs__item">Shell</li></ul>'
        '<div class="margin-top--md">'
        '<div role="tabpanel" class="tabItem_y"><pre class="prism-code language-java"><code class="codeBlockLines_a">'
        '<span class="token-line"><span class="token plain">int a;</span><br></span></code></pre></div>'
        '<div role="tabpanel" class="tabItem_y" hidden=""><pre class="prism-code language-shell"><code class="codeBlockLines_a">'
        '<span class="token-line"><span class="token plain">ls</span><br></span></code></pre></div>'
        "</div></div>",
    )
    expected = [{"label": "Java", "code": "int a;"}, {"label": "Shell", "code": "ls"}]
    assert mkdocs_model["tabs"] == expected
    assert docusaurus_model["tabs"] == expected
    assert docusaurus_model["code"] == mkdocs_model["code"] == ["int a;", "ls"]
    assert docusaurus_model["blocks"] == mkdocs_model["blocks"] == []


def test_icon_only_toggle_is_not_a_tab_but_its_code_is_kept(tmp_path):
    model = mkdocs_page(
        tmp_path,
        '<div class="superfences-tabs"><input id="_tab_2" name="2" type="checkbox"/>'
        '<label class="tab-selector" for="_tab_2"><i class="icon fa fa-code"></i></label>'
        '<div class="superfences-content"><div class="mb-config-example"><pre><code class="toml">[a]\n</code></pre></div></div></div>',
    )
    assert model["tabs"] == []
    assert model["code"] == ["[a]"]


# ------------------------------------------------------- images and links


def test_missing_image_is_reported_with_base_relative_url(tmp_path):
    model = mkdocs_page(tmp_path, '<p><img alt="Gone" src="../../assets/img/gone.png"></p>')
    assert model["images"] == [{"sha256": "MISSING:assets/img/gone.png", "alt": "Gone"}]


def test_images_hash_file_bytes_regardless_of_hashed_filename(tmp_path):
    (tmp_path / "assets" / "images").mkdir(parents=True)
    payload = b"binary-bytes"
    (tmp_path / "assets" / "images" / "pic-abc123.png").write_bytes(payload)
    model = docusaurus_page(tmp_path, '<p><img src="/en/latest/assets/images/pic-abc123.png" alt="Pic"></p>')
    assert model["images"] == [{"sha256": hashlib.sha256(payload).hexdigest(), "alt": "Pic"}]


def test_image_paths_cannot_escape_the_site_directory(tmp_path):
    site = tmp_path / "site"
    site.mkdir()
    (tmp_path / "secret.png").write_bytes(b"secret")
    # Percent-encoded dot segments are not collapsed by URL joining but are decoded on disk lookup.
    html = (
        '<html><body><article class="md-content__inner"><p>'
        '<img alt="x" src="%2e%2e/%2e%2e/%2e%2e/secret.png"></p></article></body></html>'
    )
    model = extract.extract_page(html, flavor="mkdocs", path="a/b/", site_dir=site, base_url="/")
    assert model["images"][0]["sha256"].startswith("MISSING:")
    assert extract.sha256_of_site_file(site, "../secret.png") is None


def test_links_keep_fragments_and_report_existence(tmp_path):
    (tmp_path / "learn" / "other").mkdir(parents=True)
    (tmp_path / "learn" / "other" / "index.html").write_text("x")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "file.zip").write_bytes(b"z")
    model = mkdocs_page(
        tmp_path,
        '<p><a href="../other/#frag">one</a> <a href="../../assets/file.zip">two</a> '
        '<a href="../missing/">three</a> <a href="#local">four</a> <a href="mailto:a@b.example">five</a></p>',
    )
    assert model["links"] == [
        {"text": "one", "target": "learn/other/#frag", "exists": True},
        {"text": "two", "target": "assets/file.zip", "exists": True},
        {"text": "three", "target": "learn/missing/", "exists": False},
        {"text": "four", "target": "learn/sample/#local", "exists": False},
        {"text": "five", "target": "mailto:a@b.example", "exists": None},
    ]


def test_absolute_base_prefixed_links_become_base_relative(tmp_path):
    model = docusaurus_page(tmp_path, '<p><a href="/en/latest/learn/other/">x</a></p>')
    assert model["links"][0]["target"] == "learn/other/"


def test_inline_data_uri_images_hash_the_decoded_bytes(tmp_path):
    """Webpack inlines small images as base64 data URIs; their bytes are still the image bytes."""
    payload = b"tiny-png-bytes"
    uri = "data:image/png;base64," + base64.b64encode(payload).decode("ascii")
    model = docusaurus_page(tmp_path, f'<p><img src="{uri}" alt="Tiny"></p>')
    assert model["images"] == [{"sha256": hashlib.sha256(payload).hexdigest(), "alt": "Tiny"}]


def test_malformed_data_uri_image_is_marked_missing(tmp_path):
    model = docusaurus_page(tmp_path, '<p><img src="data:image/png;base64,@@@" alt="Bad"></p>')
    assert model["images"][0]["sha256"].startswith("MISSING:")


def test_markdown_mirror_files_are_not_pages(tmp_path):
    """The llms.txt plugin publishes a `.md` copy of each page; a link to a `.md` URL stays broken."""
    (tmp_path / "learn").mkdir()
    (tmp_path / "learn" / "policy.md").write_text("# mirror")
    model = docusaurus_page(tmp_path, '<p><a href="/en/latest/learn/policy.md">Policy</a></p>')
    assert model["links"] == [{"text": "Policy", "target": "learn/policy.md", "exists": False}]


def test_site_origin_absolute_links_resolve_like_root_relative_ones(tmp_path):
    """`https://<origin>/x` and `/x` are the same URL for a reader; with an origin both read `/x`."""
    html = (
        '<html><body><article><div class="theme-doc-markdown markdown">'
        '<p><a href="https://ob.docs.wso2.com/develop/x">a</a> <a href="/develop/x">b</a> '
        '<a href="https://ob.docs.wso2.com/en/latest/learn/y/">c</a> <a href="https://example.com/z">d</a></p>'
        "</div></article></body></html>"
    )
    model = extract.extract_page(
        html, flavor="docusaurus", path=PAGE_PATH, site_dir=tmp_path, base_url=BASE_URL,
        site_origin="https://ob.docs.wso2.com",
    )
    assert [link["target"] for link in model["links"]] == [
        "/develop/x", "/develop/x", "learn/y/", "https://example.com/z",
    ]
    without_origin = docusaurus_page(tmp_path, '<p><a href="https://ob.docs.wso2.com/develop/x">a</a></p>')
    assert without_origin["links"][0]["target"] == "https://ob.docs.wso2.com/develop/x"


def test_site_origin_must_be_a_bare_https_origin():
    for bad in ("ob.docs.wso2.com", "https://ob.docs.wso2.com/en/", "javascript:alert(1)", "https://u@host"):
        with pytest.raises(ValueError):
            extract.normalise_site_origin(bad)
    assert extract.normalise_site_origin("https://ob.docs.wso2.com/") == "https://ob.docs.wso2.com"


def test_verify_ignore_marker_content_is_not_extracted(tmp_path):
    """Client-side loading placeholders carry `data-verify-ignore` and are not documentation."""
    model = docusaurus_page(tmp_path, '<p>Real</p><p data-verify-ignore="">Loading the API reference...</p>')
    assert model["blocks"] == ["Real"]


def test_mkdocs_records_onclick_location_targets_resolved_like_hrefs(tmp_path):
    """Cards that navigate with `onclick="location.href='...'"` are links in spirit; record their targets."""
    model = mkdocs_page(
        tmp_path,
        "<div class=\"card\" onclick=\"location.href='../other/';\">A</div>"
        "<div onclick='location.href=\"/en/latest/learn/y\"'>B</div>"
        "<div onclick=\"doSomething()\">C</div><div onclick=\"location.href='https://example.com/z'\">D</div>",
    )
    assert model["onclick_targets"] == ["learn/other/", "learn/y", "https://example.com/z"]
    assert docusaurus_page(tmp_path, "<p>x</p>")["onclick_targets"] == []


def test_model_is_json_serialisable_and_has_all_fields():
    model = extract_fixture("docusaurus")
    assert set(model) == set(extract.MODEL_FIELDS) | {"path", "onclick_targets"}
    json.dumps(copy.deepcopy(model))


def test_missing_content_root_returns_none(tmp_path):
    assert extract.extract_page(
        "<html><body><main>nothing</main></body></html>",
        flavor="docusaurus", path="x/", site_dir=tmp_path, base_url="/",
    ) is None


def test_unknown_flavor_is_rejected(tmp_path):
    with pytest.raises(ValueError):
        extract.extract_page("<html></html>", flavor="hugo", path="x/", site_dir=tmp_path, base_url="/")
