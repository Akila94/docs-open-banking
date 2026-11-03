"""Tests for compare.py: differences pass only when explained by a listed, actually used allowlist rule."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

import compare

HERE = Path(__file__).resolve().parent
PAGE_PATH = "learn/sample/"


def make_page(path=PAGE_PATH, **overrides):
    """A minimal valid page model with the given fields overridden."""
    page = {
        "path": path, "title": "T", "headings": [[1, "T", ""]], "blocks": [], "code": [], "tables": [],
        "lists": [], "admonitions": [], "images": [], "links": [], "tabs": [],
    }
    page.update(overrides)
    return page


def ordered_list(items, start=1, depth=0):
    """A list model entry for an ordered list."""
    return {"ordered": True, "start": start, "depth": depth, "items": items}


def run(mk_pages, docu_pages, *rule_names, **rule_options):
    """Compare two page sets under the given rule names."""
    rules = [compare.Rule(name=name, **rule_options) for name in rule_names]
    return compare.compare_models(
        {page["path"]: page for page in mk_pages}, {page["path"]: page for page in docu_pages}, rules
    )


# ----------------------------------------------------------- core behaviour


def test_identical_models_pass_without_rules():
    result = run([make_page(blocks=["a"])], [make_page(blocks=["a"])])
    assert result.passed
    assert result.identical_pages == 1


def test_unlisted_difference_fails_and_is_reported_per_page_and_field():
    result = run([make_page(blocks=["a"])], [make_page(blocks=["b"])])
    assert not result.passed
    assert [(diff.path, diff.field) for diff in result.unexplained] == [(PAGE_PATH, "blocks")]


def test_page_missing_from_either_side_fails():
    only_mkdocs = run([make_page(), make_page("gone/")], [make_page()])
    only_docusaurus = run([make_page()], [make_page(), make_page("extra/")])
    assert not only_mkdocs.passed and not only_docusaurus.passed
    assert only_mkdocs.unexplained[0].field == "(page)"


# --------------------------------------------------------------- ol-start


def test_ol_start_difference_passes_only_when_rule_is_listed():
    mkdocs = [make_page(lists=[ordered_list(["a", "b"], start=1)])]
    docusaurus = [make_page(lists=[ordered_list(["a", "b"], start=3)])]

    assert not run(mkdocs, docusaurus).passed
    listed = run(mkdocs, docusaurus, "ol-start")
    assert listed.passed
    assert listed.rule_counts == {"ol-start": 1}


def test_ol_start_does_not_excuse_other_list_changes():
    mkdocs = [make_page(lists=[ordered_list(["a"], start=1)])]
    docusaurus = [make_page(lists=[ordered_list(["a", "extra"], start=3)])]
    assert not run(mkdocs, docusaurus, "ol-start").passed


def test_listed_rule_that_explains_nothing_fails_as_unused():
    result = run([make_page()], [make_page()], "ol-start")
    assert not result.passed
    assert result.unused_rules == ["ol-start"]


# ------------------------------------------------------------ nested-list


def test_nested_list_same_items_different_depth():
    mkdocs = [make_page(lists=[ordered_list(["a", "b"], depth=0)])]
    docusaurus = [make_page(lists=[ordered_list(["a", "b"], depth=1)])]
    assert not run(mkdocs, docusaurus).passed
    assert run(mkdocs, docusaurus, "nested-list").passed
    assert not run(
        mkdocs, [make_page(lists=[ordered_list(["a", "c"], depth=1)])], "nested-list"
    ).passed


# ----------------------------------------------------- list-not-paragraph


def test_paragraph_that_became_a_list_with_same_text():
    mkdocs = [make_page(blocks=["Prerequisites: - java - maven"])]
    docusaurus = [make_page(
        blocks=["Prerequisites:"],
        lists=[{"ordered": False, "start": None, "depth": 0, "items": ["java", "maven"]}],
    )]
    assert not run(mkdocs, docusaurus).passed
    assert run(mkdocs, docusaurus, "list-not-paragraph").passed


def test_list_not_paragraph_rejects_changed_text():
    mkdocs = [make_page(blocks=["Prerequisites: - java - maven"])]
    docusaurus = [make_page(
        blocks=["Prerequisites:"],
        lists=[{"ordered": False, "start": None, "depth": 0, "items": ["java", "gradle"]}],
    )]
    assert not run(mkdocs, docusaurus, "list-not-paragraph").passed


# ------------------------------------------------- admonition-title-markup


def test_admonition_titles_differing_only_by_markup():
    def admonition(title):
        return {"kind": "details", "type": "tip", "title": title, "open": False}

    mkdocs = [make_page(admonitions=[admonition("click `obevent` and **more**")])]
    docusaurus = [make_page(admonitions=[admonition("click obevent and more")])]
    assert not run(mkdocs, docusaurus).passed
    assert run(mkdocs, docusaurus, "admonition-title-markup").passed
    other = [make_page(admonitions=[admonition("something else")])]
    assert not run(mkdocs, other, "admonition-title-markup").passed


# ------------------------------------------------------ placeholder-visible


def test_placeholder_tokens_visible_only_in_docusaurus():
    mkdocs = [make_page(
        blocks=["Go to /repository now"],
        tables=[[["Path"], ["/conf"]]],
    )]
    docusaurus = [make_page(
        blocks=["Go to <APIM_HOME>/repository now"],
        tables=[[["Path"], ["<IS_HOME>/conf"]]],
    )]
    assert not run(mkdocs, docusaurus).passed
    assert run(mkdocs, docusaurus, "placeholder-visible").passed


def test_placeholder_rule_accepts_ident_and_generic_type_tokens():
    mkdocs = [make_page(blocks=["Use the map and call it"], lists=[
        {"ordered": False, "start": None, "depth": 0, "items": ["Open /conf"]}])]
    docusaurus = [make_page(blocks=["Use the <IS_HOME> map <String, String> and call it"], lists=[
        {"ordered": False, "start": None, "depth": 0, "items": ["Open <IS_HOME>/conf"]}])]
    assert run(mkdocs, docusaurus, "placeholder-visible").passed


def test_placeholder_removed_from_docusaurus_fails():
    mkdocs = [make_page(blocks=["Go to <APIM_HOME>/repository"])]
    docusaurus = [make_page(blocks=["Go to /repository"])]
    assert not run(mkdocs, docusaurus, "placeholder-visible").passed


def test_placeholder_swapped_for_another_token_fails():
    mkdocs = [make_page(blocks=["Go to <APIM_HOME>/repository"])]
    docusaurus = [make_page(blocks=["Go to <IS_HOME>/repository"])]
    assert not run(mkdocs, docusaurus, "placeholder-visible").passed


def test_bracketed_ordinary_phrase_is_not_a_placeholder():
    mkdocs = [make_page(blocks=["Configure it now"])]
    assert not run(mkdocs, [make_page(blocks=["Configure it <see below> now"])], "placeholder-visible").passed
    assert not run(mkdocs, [make_page(blocks=["Configure it <String,String> now"])], "placeholder-visible").passed
    assert not run(mkdocs, [make_page(blocks=["Configure it <a-b> now"])], "placeholder-visible").passed


def test_placeholder_rule_does_not_hide_real_text_changes_or_code():
    mkdocs = [make_page(blocks=["Go to /repository"], code=["a <X> b"])]
    assert not run(mkdocs, [make_page(blocks=["Go to <X>/other"], code=["a <X> b"])], "placeholder-visible").passed
    assert not run(mkdocs, [make_page(blocks=["Go to /repository"], code=["a b"])], "placeholder-visible").passed



# ------------------------------------------------------ gfm-autolink-literal


def link(text, target, exists=None):
    """A link model entry."""
    return {"text": text, "target": target, "exists": exists}


def autolink_pages(added, mkdocs_blocks=("Write to is_admin@wso2.com or see https://wso2.com now.",),
                   docusaurus_blocks=None, existing=()):
    """MkDocs shows bare URLs as plain text; Docusaurus (remark-gfm) adds links for them."""
    mkdocs = make_page(blocks=list(mkdocs_blocks), links=list(existing))
    docusaurus = make_page(
        blocks=list(mkdocs_blocks if docusaurus_blocks is None else docusaurus_blocks),
        links=list(existing) + list(added),
    )
    return [mkdocs], [docusaurus]


def test_gfm_autolink_literal_accepts_added_links_whose_text_is_the_url_or_email():
    mkdocs, docusaurus = autolink_pages([
        link("is_admin@wso2.com", "mailto:is_admin@wso2.com"), link("https://wso2.com", "https://wso2.com"),
    ])
    assert not run(mkdocs, docusaurus).passed
    result = run(mkdocs, docusaurus, "gfm-autolink-literal")
    assert result.passed
    assert result.rule_counts == {"gfm-autolink-literal": 1}


def test_gfm_autolink_literal_accepts_percent_encoded_url_text():
    mkdocs, docusaurus = autolink_pages(
        [link("http://obis/>", "http://obis/%3E")], mkdocs_blocks=("Use the http://obis/> upstream.",)
    )
    assert run(mkdocs, docusaurus, "gfm-autolink-literal").passed


def test_gfm_autolink_literal_keeps_existing_links_in_place():
    existing = [link("Guide", "learn/guide/", True)]
    mkdocs, docusaurus = autolink_pages([link("https://wso2.com", "https://wso2.com")], existing=existing)
    assert run(mkdocs, docusaurus, "gfm-autolink-literal").passed


def test_gfm_autolink_literal_rejects_a_link_whose_text_is_not_its_url():
    mkdocs, docusaurus = autolink_pages([link("WSO2 website", "https://wso2.com")])
    assert not run(mkdocs, docusaurus, "gfm-autolink-literal").passed


def test_gfm_autolink_literal_rejects_text_that_was_not_visible_in_mkdocs():
    mkdocs, docusaurus = autolink_pages(
        [link("https://new.example", "https://new.example")], docusaurus_blocks=("Brand new https://new.example",)
    )
    assert not run(mkdocs, docusaurus, "gfm-autolink-literal").passed


def test_gfm_autolink_literal_does_not_excuse_changed_or_removed_links():
    base = [link("Guide", "learn/guide/", True)]
    changed = ([make_page(blocks=["https://wso2.com"], links=base)],
               [make_page(blocks=["https://wso2.com"], links=[link("Guide", "learn/other/", True),
                                                              link("https://wso2.com", "https://wso2.com")])])
    removed = ([make_page(blocks=["https://wso2.com"], links=base)],
               [make_page(blocks=["https://wso2.com"], links=[link("https://wso2.com", "https://wso2.com")])])
    assert not run(*changed, "gfm-autolink-literal").passed
    assert not run(*removed, "gfm-autolink-literal").passed


def test_gfm_autolink_literal_does_not_excuse_other_fields():
    mkdocs, docusaurus = autolink_pages([link("https://wso2.com", "https://wso2.com")])
    docusaurus[0]["code"] = ["changed"]
    result = run(mkdocs, docusaurus, "gfm-autolink-literal")
    assert [diff.field for diff in result.unexplained] == ["code"]

# ------------------------------------------- deprecated-banner-page-removed


def test_deprecated_banner_page_may_be_absent_only_when_listed():
    banner = make_page("includes/deprecated-banner/")
    assert not run([make_page(), banner], [make_page()]).passed
    assert run([make_page(), banner], [make_page()], "deprecated-banner-page-removed").passed
    other = make_page("includes/other/")
    assert not run([make_page(), other], [make_page()], "deprecated-banner-page-removed").passed


# ------------------------------------------------------------------ fixups


def fixup(**overrides):
    """A pinned fixup rule for the sample page."""
    options = {"name": "fixup:typo-1", "pages": frozenset({PAGE_PATH}), "field": "blocks",
               "replace_from": "teh", "replace_to": "the", "reason": "typo"}
    options.update(overrides)
    return compare.Rule(**options)


def run_with(rules, mkdocs, docusaurus):
    """Compare page lists under explicit Rule objects."""
    return compare.compare_models(
        {page["path"]: page for page in mkdocs}, {page["path"]: page for page in docusaurus}, rules
    )


def test_fixup_pinned_change_passes_only_on_its_page():
    mkdocs = [make_page(blocks=["Fix teh typo", "same"]), make_page("other/", blocks=["Fix teh typo"])]
    docusaurus = [make_page(blocks=["Fix the typo", "same"]), make_page("other/", blocks=["Fix the typo"])]
    result = run_with([fixup()], mkdocs, docusaurus)
    assert [diff.path for diff in result.unexplained] == ["other/"]
    assert result.rule_counts == {"fixup:typo-1": 1}


def test_fixup_rejects_extra_unrelated_change_in_the_same_field():
    mkdocs = [make_page(blocks=["Fix teh typo"])]
    docusaurus = [make_page(blocks=["Fix the typo and add more words"])]
    result = run_with([fixup()], mkdocs, docusaurus)
    assert not result.passed and result.unexplained[0].field == "blocks"


def test_fixup_rejects_extra_changed_element_in_a_list_field():
    mkdocs = [make_page(blocks=["Fix teh typo", "second"])]
    docusaurus = [make_page(blocks=["Fix the typo", "second changed"])]
    assert not run_with([fixup()], mkdocs, docusaurus).passed
    assert not run_with([fixup()], mkdocs, [make_page(blocks=["Fix the typo"])]).passed


def test_fixup_whose_from_text_does_not_occur_is_unexplained_and_unused():
    mkdocs = [make_page(blocks=["Fix this typo"])]
    docusaurus = [make_page(blocks=["Fix that typo"])]
    result = run_with([fixup()], mkdocs, docusaurus)
    assert not result.passed
    assert result.unused_rules == ["fixup:typo-1"] and result.unexplained


def test_fixup_requires_exactly_one_occurrence_and_the_right_field():
    twice = run_with([fixup()], [make_page(blocks=["teh and teh"])], [make_page(blocks=["the and the"])])
    assert not twice.passed
    wrong_field = run_with([fixup(field="title")], [make_page(blocks=["teh"])], [make_page(blocks=["the"])])
    assert not wrong_field.passed


def test_fixup_on_scalar_and_structured_fields():
    title = run_with([fixup(field="title", replace_from="Old", replace_to="New")],
                     [make_page(title="Old name")], [make_page(title="New name")])
    assert title.passed
    admonition = {"kind": "details", "type": "tip", "title": "x", "open": False}
    structured = run_with(
        [fixup(field="admonitions", replace_from='"type":"tip"', replace_to='"type":"note"')],
        [make_page(admonitions=[admonition])], [make_page(admonitions=[{**admonition, "type": "note"}])],
    )
    assert structured.passed


# ----------------------------------------------------------------- h1 ids


def test_h1_ids_are_exempt_but_other_heading_ids_are_not():
    mkdocs = [make_page(headings=[[1, "Intro", "introduction"], [2, "Setup", "setup"]])]
    assert run(mkdocs, [make_page(headings=[[1, "Intro", ""], [2, "Setup", "setup"]])]).passed
    assert not run(mkdocs, [make_page(headings=[[1, "Intro", ""], [2, "Setup", "other-id"]])]).passed
    assert not run(mkdocs, [make_page(headings=[[1, "Other", ""], [2, "Setup", "setup"]])]).passed
    assert not run(mkdocs, [make_page(headings=[[2, "Intro", ""], [2, "Setup", "setup"]])]).passed


# ------------------------------------------------------- allowlist loading


def write_yaml(tmp_path, text):
    """Write an allowlist file and return its path."""
    path = tmp_path / "allow.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_master_allowlist_is_valid():
    rules = compare.load_rules(HERE / "expected-diffs.master.yaml")
    assert rules and all(rule.reason for rule in rules)


def test_load_rules_reads_names_and_fixup_scopes(tmp_path):
    rules = compare.load_rules(write_yaml(tmp_path, """
rules:
  - name: ol-start
  - id: one
    reason: typo corrected in source
    pages: [learn/sample/]
    field: blocks
    from: "teh"
    to: "the"
"""))
    assert [rule.name for rule in rules] == ["ol-start", "fixup:one"]
    assert rules[1].pages == frozenset({"learn/sample/"}) and rules[1].field == "blocks"
    assert (rules[1].replace_from, rules[1].replace_to) == ("teh", "the")


@pytest.mark.parametrize("text", [
    "rules:\n  - name: made-up-rule\n",
    "rules:\n  - name: ol-start\n  - name: ol-start\n",
    "rules:\n  - name: 'fixup:x'\n    pages: [a/]\n    field: blocks\n    from: a\n    to: b\n    reason: r\n",
    "rules:\n  - id: x\n    pages: [a/]\n    field: blocks\n    from: a\n    to: b\n",
    "rules:\n  - id: x\n    pages: [a/]\n    field: blocks\n    from: a\n    reason: r\n",
    "rules:\n  - id: x\n    pages: [a/]\n    field: nonsense\n    from: a\n    to: b\n    reason: r\n",
    "rules:\n  - id: x\n    pages: [a/]\n    field: blocks\n    from: a\n    to: a\n    reason: r\n",
    "rules:\n  - id: x\n    pages: [a/]\n    field: blocks\n    from: a\n    to: b\n    reason: r\n    extra: 1\n",
    "rules:\n  - id: x\n    pages: [a/]\n    field: blocks\n    from: no\n    to: b\n    reason: r\n",
    "rules:\n  - name: ol-start\n    field: blocks\n",
    "rules:\n  - name: ol-start\n    surprise: 1\n",
    "rules: not-a-list\n",
    "- just-a-list\n",
    "rules: [\n",
])
def test_load_rules_rejects_invalid_files(tmp_path, text):
    with pytest.raises(compare.AllowlistError):
        compare.load_rules(write_yaml(tmp_path, text))


def test_load_rules_does_not_execute_yaml_tags(tmp_path):
    with pytest.raises(compare.AllowlistError):
        compare.load_rules(write_yaml(tmp_path, "rules: !!python/object/apply:os.system ['echo hi']\n"))


# --------------------------------------------------------------------- CLI


def write_jsonl(path, pages):
    """Write page models as JSON Lines."""
    path.write_text("".join(json.dumps(page) + "\n" for page in pages), encoding="utf-8")
    return path


def test_cli_exit_codes_and_report(tmp_path):
    mkdocs = write_jsonl(tmp_path / "mk.jsonl", [make_page(lists=[ordered_list(["a"], start=1)])])
    docusaurus = write_jsonl(tmp_path / "docu.jsonl", [make_page(lists=[ordered_list(["a"], start=3)])])
    without_rule = write_yaml(tmp_path, "rules: []\n")
    report = tmp_path / "out" / "report.md"

    assert compare.main([str(mkdocs), str(docusaurus), "--allow", str(without_rule), "--report", str(report)]) == 1
    text = report.read_text(encoding="utf-8")
    assert PAGE_PATH in text and "lists" in text

    with_rule = tmp_path / "with.yaml"
    with_rule.write_text("rules:\n  - name: ol-start\n", encoding="utf-8")
    assert compare.main([str(mkdocs), str(docusaurus), "--allow", str(with_rule), "--report", str(report)]) == 0
    assert "ol-start" in report.read_text(encoding="utf-8")


def test_cli_returns_usage_error_for_bad_inputs(tmp_path):
    mkdocs = write_jsonl(tmp_path / "mk.jsonl", [make_page()])
    broken = tmp_path / "broken.jsonl"
    broken.write_text("{not json}\n", encoding="utf-8")
    allow = write_yaml(tmp_path, "rules: []\n")
    report = tmp_path / "r.md"
    assert compare.main([str(mkdocs), str(broken), "--allow", str(allow), "--report", str(report)]) == 2
    assert compare.main([str(mkdocs), str(tmp_path / "missing.jsonl"), "--allow", str(allow), "--report", str(report)]) == 2


def test_script_runs_isolated_from_the_command_line(tmp_path):
    mkdocs = write_jsonl(tmp_path / "mk.jsonl", [make_page()])
    docusaurus = write_jsonl(tmp_path / "docu.jsonl", [make_page()])
    allowlist = write_yaml(tmp_path, "rules: []\n")
    completed = subprocess.run(
        [sys.executable, "-I", str(HERE / "compare.py"), str(mkdocs), str(docusaurus),
         "--allow", str(allowlist), "--report", str(tmp_path / "report.md")],
        capture_output=True, text=True,
    )
    assert completed.returncode == 0, completed.stderr
