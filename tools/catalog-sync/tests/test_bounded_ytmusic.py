from copy import deepcopy
import pytest
import catalog_sync.ytmusic as module
from catalog_sync.ytmusic import DiscoveryError
from test_discovery import CHANNEL, release


class PublicFixture:
    def __init__(self):
        self.calls = []
    def get_artist(self, channel):
        self.calls.append(("artist", channel))
        return {"albums": {"results": [{"browseId": "MPREb_b"}, {"browseId": "MPREb_a"}], "params": "page"}}
    def get_artist_albums(self, channel, params, *, limit):
        self.calls.append(("page", limit))
        return [{"browseId": "MPREb_c"}]
    def get_album(self, browse):
        self.calls.append(("album", browse))
        return deepcopy(release()["album"])


def test_album_and_page_limits_are_enforced_with_explicit_incomplete_report():
    client = PublicFixture()
    result = module.discover_bounded_releases([CHANNEL], client=client, max_albums=2, page_limit=3)
    assert [item["albumBrowseId"] for item in result.releases] == ["MPREb_a", "MPREb_b"]
    assert result.incomplete_reasons == ["album_limit"]
    assert ("album", "MPREb_c") not in client.calls
    assert ("page", 3) in client.calls


def test_request_budget_stops_before_another_public_api_call():
    client = PublicFixture()
    result = module.discover_bounded_releases([CHANNEL], client=client, max_api_calls=2)
    assert result.releases == []
    assert result.incomplete_reasons == ["request_limit"]
    assert not any(call[0] == "album" for call in client.calls)


def test_page_at_limit_is_conservatively_incomplete():
    result = module.discover_bounded_releases([CHANNEL], client=PublicFixture(), page_limit=1)
    assert "release_page_limit" in result.incomplete_reasons


def test_api_failure_is_generic_does_not_leak_upstream_error_and_is_not_retried():
    class Broken(PublicFixture):
        def get_artist(self, channel):
            self.calls.append(("failed", channel))
            raise RuntimeError("Cookie=do-not-print; Bearer secret")
    client = Broken()
    with pytest.raises(DiscoveryError) as captured:
        module.discover_bounded_releases([CHANNEL], client=client)
    assert str(captured.value) == "public discovery API failed"
    assert len(client.calls) == 1


def test_public_client_receives_no_authentication_and_has_a_bounded_transport(monkeypatch):
    captures = []
    class Empty:
        def __init__(self, **kwargs):
            captures.append(kwargs)
        def get_artist(self, channel):
            return {}
    monkeypatch.setattr(module, "YTMusic", Empty)
    result = module.discover_bounded_releases([CHANNEL])
    assert result.releases == []
    assert set(captures[0]) == {"requests_session"}
    assert captures[0]["requests_session"].trust_env is False


def test_invalid_metadata_and_hard_limits_fail_before_output():
    for args in [{"max_albums": 101}, {"page_limit": 0}, {"max_api_calls": 0}]:
        with pytest.raises(DiscoveryError):
            module.discover_bounded_releases([CHANNEL], client=PublicFixture(), **args)


def test_transport_drops_cookies_and_stops_at_http_request_limit(monkeypatch):
    from requests import Session as RequestsSession
    from time import monotonic
    from catalog_sync.ytmusic import _PublicSession, _BudgetReached
    captured = []
    class Reply:
        status_code = 200
        def iter_content(self, size):
            yield b'{}'
        def close(self):
            pass
    def request(self, method, url, **kwargs):
        captured.append(kwargs)
        return Reply()
    monkeypatch.setattr(RequestsSession, "request", request)
    session = _PublicSession(1, monotonic() + 30)
    session.cookies.set("SID", "test-only")
    session.request("GET", "https://music.youtube.com", cookies={"SID": "test-only"})
    with pytest.raises(_BudgetReached):
        session.request("GET", "https://music.youtube.com")
    assert len(captured) == 1
    assert "cookies" not in captured[0]
    assert captured[0]["allow_redirects"] is False
    assert captured[0]["stream"] is True
    assert captured[0]["timeout"] <= 15
    assert not session.cookies


def test_transport_time_and_body_size_are_bounded(monkeypatch):
    from requests import Session as RequestsSession
    from time import monotonic
    from catalog_sync.ytmusic import _PublicSession, _BudgetReached
    class Oversized:
        status_code = 200
        def iter_content(self, size):
            for _ in range(129):
                yield b"x" * 65536
        def close(self):
            pass
    monkeypatch.setattr(RequestsSession, "request", lambda *args, **kwargs: Oversized())
    with pytest.raises(_BudgetReached):
        _PublicSession(1, monotonic() - 1).request("GET", "https://music.youtube.com")
    with pytest.raises(DiscoveryError):
        _PublicSession(1, monotonic() + 30).request("GET", "https://music.youtube.com")
