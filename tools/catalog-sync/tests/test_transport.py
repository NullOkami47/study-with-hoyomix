import json
import pytest
from catalog_sync.transport import fetch_catalogue, ingest_manifests, validate_origin
from catalog_sync.discovery import batch_manifests, scan_releases
from catalog_sync.normalize import CatalogueSyncError, dumps_review
from test_discovery import config, release


class Response:
    def __init__(self, body=b'{"revision":"1","tracks":[]}', status=200):
        self.body, self.status_code = body, status
    def iter_content(self, size):
        yield self.body
    def close(self):
        pass


class Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


def artifacts(tmp_path, complete=True, source="public-ytmusic"):
    manifest = batch_manifests(scan_releases([release()], [], config()).discoveries, "upload-once")[0]
    (tmp_path / "manifest-0001.json").write_bytes(dumps_review(manifest))
    (tmp_path / "scan-report.json").write_bytes(dumps_review({"schemaVersion": 1, "complete": complete,
        "source": source, "catalogueSource": "public-api", "manifests": ["manifest-0001.json"]}))
    return manifest


def test_public_catalogue_get_has_no_auth_and_targets_only_the_exact_endpoint():
    session = Session([Response()])
    assert fetch_catalogue("https://catalogue.example", session=session) == {"revision": "1", "tracks": []}
    method, url, options = session.calls[0]
    assert (method, url) == ("GET", "https://catalogue.example/api/catalogue")
    assert set(options["headers"]) == {"Accept"}
    assert options["allow_redirects"] is False
    assert options["timeout"] <= 20


@pytest.mark.parametrize("origin", ["http://example.org", "https://user:pass@example.org", "https://example.org/path", "https://example.org?token=secret", "https://example.org#fragment"])
def test_origin_refuses_non_https_credentials_or_non_origin_urls(origin):
    with pytest.raises(CatalogueSyncError):
        validate_origin(origin)


@pytest.mark.parametrize("response", [Response(status=302), Response(status=500), Response(b"not json"),
    Response(b'{"tracks":{}}'), Response(b"x" * (10 * 1024 * 1024 + 1)), RuntimeError("Cookie=DO_NOT_ECHO")])
def test_public_catalogue_failures_are_bounded_redacted_and_not_retried(response):
    session = Session([response])
    with pytest.raises(CatalogueSyncError) as captured:
        fetch_catalogue("https://catalogue.example", session=session)
    assert "DO_NOT_ECHO" not in str(captured.value)
    assert len(session.calls) == 1


def test_ingestion_is_explicit_separate_token_exact_post_no_response_echo(tmp_path):
    manifest = artifacts(tmp_path)
    session = Session([Response(b'{"server":"DO_NOT_ECHO"}', 201)])
    assert ingest_manifests("https://catalogue.example", tmp_path, "test-only-token", enabled=True, session=session) == 1
    method, url, options = session.calls[0]
    assert (method, url) == ("POST", "https://catalogue.example/api/catalogue/discovery/runs")
    assert options["headers"]["Authorization"] == "Bearer test-only-token"
    assert json.loads(options["data"]) == manifest
    assert "suggestions" not in json.loads(options["data"])


@pytest.mark.parametrize("enabled,token,complete,source", [(False, "x", True, "public-ytmusic"),
    (True, "", True, "public-ytmusic"), (True, "x", False, "public-ytmusic"), (True, "x", True, "fixture")])
def test_disabled_incomplete_or_fixture_ingest_has_zero_network_calls(tmp_path, enabled, token, complete, source):
    artifacts(tmp_path, complete, source)
    session = Session([])
    with pytest.raises(CatalogueSyncError):
        ingest_manifests("https://catalogue.example", tmp_path, token, enabled=enabled, session=session)
    assert session.calls == []


def test_ingestion_failure_is_not_retried_or_logged(tmp_path):
    artifacts(tmp_path)
    session = Session([Response(status=503)])
    with pytest.raises(CatalogueSyncError) as captured:
        ingest_manifests("https://catalogue.example", tmp_path, "secret-value", enabled=True, session=session)
    assert "secret-value" not in str(captured.value)
    assert len(session.calls) == 1


def test_all_manifests_are_validated_before_first_post(tmp_path):
    artifacts(tmp_path)
    report = json.loads((tmp_path / "scan-report.json").read_bytes())
    report["manifests"].append("manifest-0002.json")
    (tmp_path / "scan-report.json").write_bytes(dumps_review(report))
    (tmp_path / "manifest-0002.json").write_text('{"schemaVersion":1,"runId":"bad","discoveries":[],"extra":true}')
    session = Session([])
    with pytest.raises(CatalogueSyncError):
        ingest_manifests("https://catalogue.example", tmp_path, "test-only-token", enabled=True, session=session)
    assert session.calls == []


def test_empty_manifest_does_not_create_a_remote_run(tmp_path):
    artifacts(tmp_path)
    (tmp_path / "manifest-0001.json").write_bytes(dumps_review({"schemaVersion": 1, "runId": "no-new", "discoveries": []}))
    session = Session([])
    assert ingest_manifests("https://catalogue.example", tmp_path, "test-only-token", enabled=True, session=session) == 0
    assert session.calls == []
