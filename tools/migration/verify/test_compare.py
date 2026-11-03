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


# ------------------------------------------------------------ onclick-card-link


HOME = ""


def card_pages(added, targets=("get-started/quick/", "learn/a"), path=HOME, blocks=("Quick Start Set up", "Consent Manage")):
    """MkDocs cards navigate through onclick; Docusaurus renders anchors with the same targets."""
    mkdocs = make_page(path, blocks=list(blocks))
    mkdocs["onclick_targets"] = list(targets)
    docusaurus = make_page(path, blocks=list(blocks), links=list(added))
    return [mkdocs], [docusaurus]


def test_onclick_card_link_explains_added_links_with_recorded_targets_on_the_home_page():
    mkdocs, docusaurus = card_pages([link("Quick Start Set up", "get-started/quick/", True),
                                     link("Consent Manage", "learn/a/", True)])
    assert not run(mkdocs, docusaurus).passed
    assert run(mkdocs, docusaurus, "onclick-card-link").passed


def test_onclick_card_link_rejects_unrecorded_target_other_text_or_other_page():
    mkdocs, docusaurus = card_pages([link("Quick Start Set up", "learn/other/", True)])
    assert not run(mkdocs, docusaurus, "onclick-card-link").passed
    mkdocs, docusaurus = card_pages([link("Brand new words", "get-started/quick/", True)])
    assert not run(mkdocs, docusaurus, "onclick-card-link").passed
    mkdocs, docusaurus = card_pages([link("Quick Start Set up", "get-started/quick/", True)], path="learn/x/")
    assert not run(mkdocs, docusaurus, "onclick-card-link").passed


def test_onclick_card_link_does_not_excuse_removed_links_or_other_fields():
    mkdocs, docusaurus = card_pages([link("Quick Start Set up", "get-started/quick/", True)])
    mkdocs[0]["links"] = [link("Gone", "learn/gone/", True)]
    assert not run(mkdocs, docusaurus, "onclick-card-link").passed
    mkdocs, docusaurus = card_pages([link("Quick Start Set up", "get-started/quick/", True)])
    docusaurus[0]["code"] = ["x"]
    assert [d.field for d in run(mkdocs, docusaurus, "onclick-card-link").unexplained] == ["code"]

# ------------------------------------------- deprecated-banner-page-removed


def test_deprecated_banner_page_may_be_absent_only_when_listed():
    banner = make_page("includes/deprecated-banner/")
    assert not run([make_page(), banner], [make_page()]).passed
    assert run([make_page(), banner], [make_page()], "deprecated-banner-page-removed").passed
    other = make_page("includes/other/")
    assert not run([make_page(), other], [make_page()], "deprecated-banner-page-removed").passed


# ------------------------------------------------------------------ fixups


def change(**overrides):
    """A pinned change; defaults to replacing `teh` by `the` in the first block."""
    options = {"field": "blocks", "op": "replace", "index": 0, "replace_from": "teh", "replace_to": "the"}
    options.update(overrides)
    return compare.Change(**options)


def fixup(*changes, name="fixup:typo-1", pages=frozenset({PAGE_PATH})):
    """A pinned fixup rule for the sample page."""
    return compare.Rule(name=name, pages=pages, reason="typo", changes=tuple(changes or (change(),)))


def run_with(rules, mkdocs, docusaurus):
    """Compare page lists under explicit Rule objects."""
    return compare.compare_models(
        {page["path"]: page for page in mkdocs}, {page["path"]: page for page in docusaurus}, rules
    )


def test_fixup_pinned_replace_passes_only_on_its_page():
    mkdocs = [make_page(blocks=["Fix teh typo", "same"]), make_page("other/", blocks=["Fix teh typo"])]
    docusaurus = [make_page(blocks=["Fix the typo", "same"]), make_page("other/", blocks=["Fix the typo"])]
    result = run_with([fixup()], mkdocs, docusaurus)
    assert [diff.path for diff in result.unexplained] == ["other/"]
    assert result.rule_counts == {"fixup:typo-1": 1}


def test_fixup_rejects_leftover_differences():
    mkdocs = [make_page(blocks=["Fix teh typo", "second"])]
    assert not run_with([fixup()], mkdocs, [make_page(blocks=["Fix the typo and more", "second"])]).passed
    assert not run_with([fixup()], mkdocs, [make_page(blocks=["Fix the typo", "second changed"])]).passed
    assert not run_with([fixup()], mkdocs, [make_page(blocks=["Fix the typo"])]).passed


def test_fixup_op_that_does_not_apply_fails_and_is_unused():
    mkdocs, docusaurus = [make_page(blocks=["Fix this typo"])], [make_page(blocks=["Fix that typo"])]
    result = run_with([fixup()], mkdocs, docusaurus)
    assert not result.passed
    assert result.unused_rules == ["fixup:typo-1"] and result.unexplained
    twice = run_with([fixup()], [make_page(blocks=["teh and teh"])], [make_page(blocks=["the and the"])])
    assert not twice.passed
    assert not run_with([fixup(change(index=5))], [make_page(blocks=["teh"])], [make_page(blocks=["the"])]).passed


def test_fixup_insert_and_delete_with_indexes_across_fields():
    mkdocs = [make_page(blocks=["a", "b"], code=["old code"], tables=[])]
    docusaurus = [make_page(blocks=["a", "new", "b"], code=[], tables=[[["h"], ["v"]]])]
    rule = fixup(
        change(field="blocks", op="insert", index=1, replace_from=None, replace_to=None, value="new"),
        change(field="code", op="delete", index=0, replace_from=None, replace_to=None, value="old code"),
        change(field="tables", op="insert", index=0, replace_from=None, replace_to=None, value=[["h"], ["v"]]),
    )
    result = run_with([rule], mkdocs, docusaurus)
    assert result.passed
    assert result.rule_counts == {"fixup:typo-1": 3}
    append = fixup(change(field="blocks", op="insert", index=2, replace_from=None, replace_to=None, value="tail"))
    assert run_with([append], [make_page(blocks=["a", "b"])], [make_page(blocks=["a", "b", "tail"])]).passed


def test_fixup_delete_must_match_the_deleted_value_and_inserts_keep_order():
    wrong = fixup(change(field="blocks", op="delete", index=0, replace_from=None, replace_to=None, value="other"))
    assert not run_with([wrong], [make_page(blocks=["a"])], [make_page(blocks=[])]).passed
    two = fixup(
        change(field="blocks", op="insert", index=0, replace_from=None, replace_to=None, value="x"),
        change(field="blocks", op="insert", index=0, replace_from=None, replace_to=None, value="y"),
    )
    assert run_with([two], [make_page(blocks=[])], [make_page(blocks=["x", "y"])]).passed
    assert not run_with([two], [make_page(blocks=[])], [make_page(blocks=["y", "x"])]).passed


def test_several_fixup_entries_on_one_page_are_applied_together():
    first = fixup(change(), name="fixup:one")
    second = fixup(change(index=1, replace_from="wrng", replace_to="right"), name="fixup:two")
    result = run_with([first, second], [make_page(blocks=["teh", "wrng"])], [make_page(blocks=["the", "right"])])
    assert result.passed and result.rule_counts == {"fixup:one": 1, "fixup:two": 1}


def test_fixup_leaves_the_remainder_to_builtin_rules():
    mkdocs = [make_page(blocks=["teh", "Open /bin"], code=[])]
    docusaurus = [make_page(blocks=["the", "Open <IS_HOME>/bin"], code=[])]
    assert not run_with([fixup()], mkdocs, docusaurus).passed
    result = run_with([fixup(), compare.Rule(name="placeholder-visible")], mkdocs, docusaurus)
    assert result.passed and result.rule_counts == {"fixup:typo-1": 1, "placeholder-visible": 1}


def test_fixup_on_scalar_and_structured_fields():
    title = run_with([fixup(change(field="title", index=None, replace_from="Old", replace_to="New"))],
                     [make_page(title="Old name")], [make_page(title="New name")])
    assert title.passed
    admonition = {"kind": "details", "type": "tip", "title": "x", "open": False}
    structured = run_with(
        [fixup(change(field="admonitions", replace_from='"type":"tip"', replace_to='"type":"note"'))],
        [make_page(admonitions=[admonition])], [make_page(admonitions=[{**admonition, "type": "note"}])],
    )
    assert structured.passed


# ------------------------------------------------ list-restructure-text-preserved


def bullet_list(items, depth=0):
    """A list model entry for a bullet list."""
    return {"ordered": False, "start": None, "depth": depth, "items": items}


LIST_RULE = compare.Rule(name="list-restructure-text-preserved", pages=frozenset({PAGE_PATH}))


def test_list_restructure_accepts_same_text_with_other_depth_and_boundaries():
    flow = "Engage A B Next"
    mkdocs = [make_page(lists=[bullet_list(["Engage - A - B", "Next"])], flow=flow)]
    docusaurus = [make_page(lists=[bullet_list(["Engage", "Next"]), bullet_list(["A", "B"], depth=1)], flow=flow)]
    assert not run_with([], mkdocs, docusaurus).passed
    assert run_with([LIST_RULE], mkdocs, docusaurus).passed


def test_list_restructure_strips_markers_and_normalises_whitespace_in_the_flow():
    mkdocs = [make_page(blocks=["- Open", "2. Save"], flow="- Open   2. Save")]
    docusaurus = [make_page(lists=[bullet_list(["Open", "Save"])], flow="Open Save")]
    assert run_with([LIST_RULE], mkdocs, docusaurus).passed


def test_list_restructure_covers_paragraphs_that_moved_into_the_lists():
    mkdocs = [make_page(blocks=["2. Open the file", "3. Save it"], lists=[bullet_list(["Note"])],
                        flow="2. Open the file 3. Save it Note")]
    docusaurus = [make_page(blocks=[], lists=[bullet_list(["Open the file", "Save it"]), bullet_list(["Note"], depth=1)],
                            flow="Open the file Save it Note")]
    assert run_with([LIST_RULE], mkdocs, docusaurus).passed
    lost = [make_page(blocks=[], lists=[bullet_list(["Open the file"]), bullet_list(["Note"], depth=1)],
                      flow="Open the file Note")]
    assert not run_with([LIST_RULE], mkdocs, lost).passed
    # a paragraph change with unchanged lists is not a list restructure
    assert not run_with([LIST_RULE], [make_page(blocks=["a b"], flow="a b")], [make_page(blocks=["b a"], flow="b a")]).passed


def test_list_restructure_rejects_reordered_items():
    mkdocs = [make_page(lists=[bullet_list(["first", "second", "third"])], flow="first second third")]
    swapped = [make_page(lists=[bullet_list(["first", "third", "second"])], flow="first third second")]
    assert not run_with([LIST_RULE], mkdocs, swapped).passed


def test_list_restructure_rejects_reordering_across_a_restructure():
    # the same words and counts, but a nested item moved before its parent
    mkdocs = [make_page(lists=[bullet_list(["Engage - A - B", "Next"])], flow="Engage A B Next")]
    moved = [make_page(lists=[bullet_list(["Engage", "Next"]), bullet_list(["B", "A"], depth=1)], flow="Engage B A Next")]
    assert not run_with([LIST_RULE], mkdocs, moved).passed


def test_list_restructure_rejects_text_moving_between_a_paragraph_and_a_list():
    mkdocs = [make_page(blocks=["intro"], lists=[bullet_list(["a", "b"])], flow="intro a b")]
    moved = [make_page(blocks=[], lists=[bullet_list(["intro", "a"]), bullet_list(["b"], depth=1)], flow="a intro b")]
    assert not run_with([LIST_RULE], mkdocs, moved).passed


def test_list_restructure_ignores_placeholder_tokens_shown_only_by_docusaurus():
    mkdocs = [make_page(blocks=["Open /bin"], lists=[bullet_list(["Run it - in /conf"])],
                        flow="Open /bin Run it in /conf")]
    docusaurus = [make_page(blocks=["Open <IS_HOME>/bin"],
                            lists=[bullet_list(["Run it"]), bullet_list(["in <IS_HOME>/conf"], depth=1)],
                            flow="Open <IS_HOME>/bin Run it in <IS_HOME>/conf")]
    assert run_with([LIST_RULE, compare.Rule(name="placeholder-visible")], mkdocs, docusaurus).passed


def test_list_restructure_rejects_a_placeholder_lost_from_the_flow():
    mkdocs = [make_page(lists=[bullet_list(["Open <IS_HOME>/bin"])], flow="Open <IS_HOME>/bin")]
    docusaurus = [make_page(lists=[bullet_list(["Open"]), bullet_list(["/bin"], depth=1)], flow="Open /bin")]
    assert not run_with([LIST_RULE], mkdocs, docusaurus).passed


def test_list_restructure_fails_closed_without_a_flow():
    mkdocs = [make_page(lists=[bullet_list(["a b"])])]
    docusaurus = [make_page(lists=[bullet_list(["a"]), bullet_list(["b"], depth=1)])]
    assert not run_with([LIST_RULE], mkdocs, docusaurus).passed


def test_list_restructure_rejects_changed_text_and_other_pages():
    mkdocs = [make_page(lists=[bullet_list(["a b"])], flow="a b"),
              make_page("other/", lists=[bullet_list(["a b"])], flow="a b")]
    docusaurus = [make_page(lists=[bullet_list(["a"]), bullet_list(["b changed"], depth=1)], flow="a b changed"),
                  make_page("other/", lists=[bullet_list(["a"]), bullet_list(["b"], depth=1)], flow="a b")]
    result = run_with([LIST_RULE], mkdocs, docusaurus)
    assert {diff.path for diff in result.unexplained} == {PAGE_PATH, "other/"}


# ------------------------------------------------------- admonition-type-map


def admonition(kind="admonition", type_="note", title="Title", open_=None):
    """An admonition model entry."""
    return {"kind": kind, "open": open_, "title": title, "type": type_}


@pytest.mark.parametrize("before,after", [("optional", "note"), ("example", "info"), ("", "note"), ("Note", "note")])
def test_admonition_type_map_accepts_the_pinned_pairs(before, after):
    result = run([make_page(admonitions=[admonition(type_=before)])], [make_page(admonitions=[admonition(type_=after)])],
                 "admonition-type-map")
    assert result.passed and result.rule_counts == {"admonition-type-map": 1}


@pytest.mark.parametrize("before,after", [("note", "tip"), ("tip", "note"), ("optional", "info"), ("example", "note")])
def test_admonition_type_map_rejects_other_type_changes(before, after):
    assert not run([make_page(admonitions=[admonition(type_=before)])], [make_page(admonitions=[admonition(type_=after)])],
                   "admonition-type-map").passed


def test_admonition_type_map_requires_identical_title_kind_and_count():
    base = [make_page(admonitions=[admonition(type_="optional")])]
    assert not run(base, [make_page(admonitions=[admonition(title="Other")])], "admonition-type-map").passed
    assert not run(base, [make_page(admonitions=[admonition(kind="details", open_=False)])], "admonition-type-map").passed
    assert not run(base, [make_page(admonitions=[admonition(), admonition()])], "admonition-type-map").passed


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


def test_load_rules_reads_names_and_fixup_changes(tmp_path):
    rules = compare.load_rules(write_yaml(tmp_path, """
rules:
  - name: ol-start
  - name: list-restructure-text-preserved
    pages: [learn/sample/]
  - id: one
    reason: typo corrected in source
    pages: [learn/sample/]
    changes:
      - {field: blocks, op: replace, index: 0, from: "teh", to: "the"}
      - {field: code, op: insert, index: 1, value: "x = 1"}
      - {field: tables, op: delete, index: 0, value: [["a"]]}
      - {field: title, op: replace, from: "Old", to: "New"}
"""))
    assert [rule.name for rule in rules] == ["ol-start", "list-restructure-text-preserved", "fixup:one"]
    assert rules[2].pages == frozenset({"learn/sample/"})
    assert rules[2].changes == (
        compare.Change("blocks", "replace", 0, None, "teh", "the"),
        compare.Change("code", "insert", 1, "x = 1"),
        compare.Change("tables", "delete", 0, [["a"]]),
        compare.Change("title", "replace", None, None, "Old", "New"),
    )


GOOD_CHANGE = "{field: blocks, op: replace, index: 0, from: a, to: b}"


def fixup_yaml(changes=GOOD_CHANGE, extra="", pages="[a/]", reason="reason: r"):
    """An allowlist with one fixup entry; pieces can be replaced to build invalid variants."""
    return f"rules:\n  - id: x\n    pages: {pages}\n    {reason}\n    changes: [{changes}]\n{extra}"


@pytest.mark.parametrize("text", [
    "rules:\n  - name: made-up-rule\n",
    "rules:\n  - name: ol-start\n  - name: ol-start\n",
    "rules:\n  - name: list-restructure-text-preserved\n",
    "rules:\n  - name: 'fixup:x'\n    pages: [a/]\n    reason: r\n",
    "rules:\n  - id: x\n    pages: [a/]\n    reason: r\n",
    "rules:\n  - id: x\n    pages: [a/]\n    reason: r\n    changes: []\n",
    "rules:\n  - id: x\n    pages: [a/]\n    changes: [" + GOOD_CHANGE + "]\n",
    "rules:\n  - id: x\n    reason: r\n    changes: [" + GOOD_CHANGE + "]\n",
    "rules:\n  - id: x\n    pages: [a/]\n    reason: r\n    field: blocks\n    changes: [" + GOOD_CHANGE + "]\n",
    fixup_yaml("{field: nonsense, op: replace, index: 0, from: a, to: b}"),
    fixup_yaml("{field: blocks, op: shuffle, index: 0, from: a, to: b}"),
    fixup_yaml("{field: blocks, op: replace, from: a, to: b}"),
    fixup_yaml("{field: blocks, op: replace, index: -1, from: a, to: b}"),
    fixup_yaml("{field: title, op: replace, index: 0, from: a, to: b}"),
    fixup_yaml("{field: blocks, op: replace, index: 0, from: a, to: a}"),
    fixup_yaml("{field: blocks, op: replace, index: 0, from: a}"),
    fixup_yaml("{field: blocks, op: insert, index: 0}"),
    fixup_yaml("{field: blocks, op: insert, index: 0, value: x, from: a}"),
    fixup_yaml("{field: title, op: insert, value: x}"),
    fixup_yaml("{field: blocks, op: delete, index: 0, value: x, extra: 1}"),
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


def test_placeholder_removals_handles_many_tokens_present_on_both_sides():
    """Tokens MkDocs also shows (e.g. inside code) are not surplus, however many there are."""
    text = " ".join(f"<HOST_{i}>" for i in range(30)) + " end"
    assert list(compare.placeholder_removals(text, text)) == [text]


def test_placeholder_removals_gives_up_when_the_surplus_is_ambiguous_beyond_the_cap():
    docusaurus = " ".join("<X>" for _ in range(40))
    mkdocs = " ".join("<X>" for _ in range(20))
    assert list(compare.placeholder_removals(docusaurus, mkdocs)) == []


def test_list_restructure_accepts_a_page_with_many_placeholders_in_both_flows():
    flow = " ".join(f"<HOST_{i}>" for i in range(30)) + " a b"
    mkdocs = [make_page(lists=[bullet_list(["a - b"])], flow=flow)]
    docusaurus = [make_page(lists=[bullet_list(["a"]), bullet_list(["b"], depth=1)], flow=flow)]
    assert run_with([LIST_RULE], mkdocs, docusaurus).passed
