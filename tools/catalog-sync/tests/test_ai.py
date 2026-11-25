from copy import deepcopy
import pytest
from catalog_sync.ai import DeterministicAdapter, ImportedJsonAdapter, build_suggestions
from catalog_sync.normalize import CatalogueSyncError, dumps_review
from test_discovery import config, release
from catalog_sync.discovery import scan_releases


def discoveries():
    return scan_releases([release()], [], config()).discoveries


def suggestion():
    return {"videoId": "abcdefghijk", "games": ["zzz"], "album": "Manual alias",
            "aliases": {"zh-Hant": ["人工別名"]}, "relation_ids": ["place:fixture"],
            "work_group_id": "work-manual-review", "vocal_status": "uncertain", "tabs": ["focus"],
            "reasons": ["Manual review only"], "evidence": ["https://example.org/public-review"],
            "confidence": 0.4, "uncertainties": ["Recording identity is not verified"]}


def test_deterministic_default_is_repeatable_and_makes_no_title_identity_inference():
    items = discoveries()
    original = deepcopy(items)
    result = build_suggestions(items, DeterministicAdapter())
    assert result["adapter"] == "deterministic"
    value = result["suggestions"][0]
    assert value["games"] == ["genshin"]
    assert value["work_group_id"] is None
    assert value["vocal_status"] == "uncertain"
    assert value["relation_ids"] == value["tabs"] == []
    assert value["uncertainties"]
    assert dumps_review(result) == dumps_review(build_suggestions(items, DeterministicAdapter()))
    assert items == original


def test_imported_uncertain_ai_is_a_separate_artifact_and_never_changes_discovery():
    items = discoveries()
    original = deepcopy(items)
    result = build_suggestions(items, ImportedJsonAdapter({"schemaVersion": 1, "suggestions": [suggestion()]}))
    assert result["adapter"] == "imported-json"
    assert result["suggestions"][0]["confidence"] == 0.4
    assert result["suggestions"][0]["uncertainties"] == ["Recording identity is not verified"]
    assert items == original
    assert items[0]["games"] == ["genshin"]
    assert "suggestions" not in items[0]


@pytest.mark.parametrize("change", [{"games": ["other"]}, {"confidence": True}, {"confidence": 1.1},
    {"confidence": float("nan")}, {"tabs": ["admin"]}, {"vocal_status": "maybe"},
    {"relation_ids": ["not-a-relation"]}, {"work_group_id": 4}, {"aliases": ["alias"]},
    {"uncertainties": "unsure"}, {"evidence": []}, {"reasons": []}, {"unexpected": "field"},
    {"videoId": "zzzzzzzzzzz"}, {"evidence": ["https://example.org?X-Amz-Signature=secret"]},
    {"reasons": ["Bearer top-secret-value"]}])
def test_manual_ai_suggestions_are_strictly_validated(change):
    item = suggestion()
    item.update(change)
    with pytest.raises(CatalogueSyncError):
        build_suggestions(discoveries(), ImportedJsonAdapter({"schemaVersion": 1, "suggestions": [item]}))


def test_duplicate_ai_targets_and_unknown_document_fields_fail_closed():
    for value in [{"schemaVersion": 1, "suggestions": [suggestion(), suggestion()]},
                  {"schemaVersion": 1, "suggestions": [], "token": "secret"}]:
        with pytest.raises(CatalogueSyncError):
            build_suggestions(discoveries(), ImportedJsonAdapter(value))


@pytest.mark.parametrize("relation", ["place:a:b", "character:" + "a" * 121, "faction:a.b"])
def test_relation_ids_match_canonical_worker_grammar(relation):
    item = suggestion()
    item["relation_ids"] = [relation]
    with pytest.raises(CatalogueSyncError):
        build_suggestions(discoveries(), ImportedJsonAdapter({"schemaVersion": 1, "suggestions": [item]}))


@pytest.mark.parametrize("work_group", ["work:manual", "Work-manual", "_work", "work.id", "a" * 121])
def test_non_null_work_group_matches_canonical_worker_grammar(work_group):
    item = suggestion()
    item["work_group_id"] = work_group
    with pytest.raises(CatalogueSyncError):
        build_suggestions(discoveries(), ImportedJsonAdapter({"schemaVersion": 1, "suggestions": [item]}))


@pytest.mark.parametrize("aliases", [
    {"en-" + str(index).zfill(2): ["Alias"] for index in range(11)},
    {"en": ["Alias " + str(index) for index in range(21)]},
    {"zh-Hant": ["字" * 501]},
])
def test_alias_limits_match_worker_locales_values_and_character_budget(aliases):
    item = suggestion()
    item["aliases"] = aliases
    with pytest.raises(CatalogueSyncError):
        build_suggestions(discoveries(), ImportedJsonAdapter({"schemaVersion": 1, "suggestions": [item]}))


def test_canonical_ai_boundary_values_and_null_default_are_accepted():
    item = suggestion()
    item["relation_ids"] = ["place:a" + "b" * 119]
    item["work_group_id"] = "w" + "a" * 119
    item["aliases"] = {"en-" + str(index).zfill(2): [str(value) + "x" * 498 for value in range(20)] for index in range(10)}
    result = build_suggestions(discoveries(), ImportedJsonAdapter({"schemaVersion": 1, "suggestions": [item]}))
    assert result["suggestions"][0]["work_group_id"] == item["work_group_id"]
    assert len(result["suggestions"][0]["aliases"]) == 10
    item["work_group_id"] = None
    result = build_suggestions(discoveries(), ImportedJsonAdapter({"schemaVersion": 1, "suggestions": [item]}))
    assert result["suggestions"][0]["work_group_id"] is None
