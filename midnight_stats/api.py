"""Minimal client for the public NBN23 widget API used by alqueriadelbasket.com."""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime

API_BASE = "https://api.swish.nbn23.com"
# Public read-only key that alqueriadelbasket.com embeds in its NBN23 widget.
DEFAULT_API_KEY = "b76058c6-d42e-4672-b229-286d909e0444"
USER_AGENT = "midnight-stats/0.1 (+league stats for personal use)"


class ApiError(RuntimeError):
    pass


class Nbn23Client:
    """API client that stays under the server limit (100 requests per minute per client)."""

    def __init__(self, api_key: str | None = None, base_url: str = API_BASE, retries: int = 6,
                 min_interval: float = 0.75):
        self.api_key = api_key or os.environ.get("NBN23_API_KEY") or DEFAULT_API_KEY
        self.base_url = base_url.rstrip("/")
        self.retries = retries
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._last_call = 0.0

    def _throttle(self) -> None:
        with self._lock:
            wait = self._last_call + self.min_interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()

    def _open(self, url: str, headers: dict[str, str], throttled: bool):
        last_error: Exception | None = None
        for attempt in range(self.retries):
            if throttled:
                self._throttle()
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})
                return urllib.request.urlopen(request, timeout=60)
            except urllib.error.HTTPError as error:
                if error.code == 429:
                    retry_after = float(error.headers.get("Retry-After") or 5)
                    time.sleep(retry_after + 1)
                    last_error = error
                    continue
                if error.code < 500:
                    raise ApiError(f"{error.code} for {url}") from error
                last_error = error
            except urllib.error.URLError as error:
                last_error = error
            time.sleep(1.5 * (attempt + 1))
        raise ApiError(f"Giving up on {url}: {last_error}")

    def get(self, path: str, **params):
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        url = f"{self.base_url}{path}{query}"
        with self._open(url, {"Authorization": self.api_key}, throttled=True) as response:
            return json.loads(response.read().decode("utf-8"))

    def seasons(self) -> list[dict]:
        return self.get("/seasons")

    def competitions(self, season_id: str) -> list[dict]:
        return self.get("/competitions", seasonId=season_id)

    def calendar(self, group_id: str) -> dict:
        return self.get("/calendar", groupId=group_id)

    def standings(self, group_id: str) -> list[dict]:
        return self.get("/standings", groupId=group_id)

    def match(self, match_id: str) -> dict:
        return self.get(f"/match/{match_id}")

    def match_players(self, match_id: str) -> list[dict]:
        return self.get(f"/match/{match_id}/players")

    def match_deeplink(self, match_id: str) -> str:
        """Final URL of the widget's "open in Swish" link (it carries the Leverade ids)."""
        url = f"{self.base_url}/match/link?id={match_id}&apiKey={self.api_key}"
        with self._open(url, {}, throttled=True) as response:
            return response.geturl()

    def download(self, url: str) -> tuple[bytes, str | None]:
        """Download a file and return its bytes plus its upload time (ISO, UTC) when known."""
        with self._open(url, {}, throttled=False) as response:
            data = response.read()
            last_modified = response.headers.get("Last-Modified")
        uploaded_at = parsedate_to_datetime(last_modified).isoformat() if last_modified else None
        return data, uploaded_at
