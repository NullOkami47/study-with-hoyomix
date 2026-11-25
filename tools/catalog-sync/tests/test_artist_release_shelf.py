"""Use the artist's returned release shelf, retaining the configured source identity."""
import pytest

from catalog_sync.ytmusic import (
    DiscoveryError, discover_artist_releases, discover_bounded_releases,
)

CHANNEL = "UC" + "A" * 22


class ShelfClient:
    def __init__(self, shelf=None):
        self.shelf = shelf
        self.pages = []

    def get_artist(self, channel):
        assert channel == CHANNEL
        return {
            # The subscription channel is not the discovery provenance.
            "channelId": "UC" + "B" * 22,
            "albums": {"results": [], "browseId": self.shelf, "params": "albums"},
            "singles": {"results": [], "browseId": "MPAD_singles", "params": "singles"},
        }

    def get_artist_albums(self, browse_id, params, *, limit):
        self.pages.append((browse_id, params, limit))
        assert browse_id == (self.shelf if params == "albums" else "MPAD_singles")
        return [{"browseId": "MPRE_" + params}]

    def get_album(self, browse_id):
        return {"title": "Genshin Impact - Fixture", "tracks": [], "trackCount": 0}


@pytest.mark.parametrize("bounded", [False, True])
def test_uses_each_returned_shelf_without_changing_candidate_channel(bounded):
    client = ShelfClient("MPAD" + CHANNEL)
    if bounded:
        result = discover_bounded_releases([CHANNEL], client=client, page_limit=7)
        releases = result.releases
        assert result.incomplete_reasons == []
        assert result.api_calls == 5
    else:
        releases = discover_artist_releases([CHANNEL], client=client)
    assert client.pages == [
        ("MPAD" + CHANNEL, "albums", 7 if bounded else None),
        ("MPAD_singles", "singles", 7 if bounded else None),
    ]
    assert {row["artistChannelId"] for row in releases} == {CHANNEL}
    assert {row["albumBrowseId"] for row in releases} == {"MPRE_albums", "MPRE_singles"}


@pytest.mark.parametrize("bounded", [False, True])
@pytest.mark.parametrize("invalid", [None, "", "  MPAD_example", "https://music.youtube.com/", {"id": "MPAD_example"}])
def test_malformed_returned_shelf_fails_before_another_request(bounded, invalid):
    client = ShelfClient(invalid)
    discover = discover_bounded_releases if bounded else discover_artist_releases
    with pytest.raises(DiscoveryError):
        discover([CHANNEL], client=client)
    assert client.pages == []
