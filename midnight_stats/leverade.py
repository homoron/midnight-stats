"""Public Leverade API (the league's management platform), used for registered shirt numbers.

Player names and photos live in Leverade licences, which require logging in, so only the
public part is used here: the teams of a tournament and their participants' shirt numbers.
"""

from __future__ import annotations

import json
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://api.leverade.com"
USER_AGENT = "midnight-stats/0.1 (+league stats for personal use)"


def _normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return "".join(ch for ch in text.upper() if ch.isalnum())


def tournament_id_from_deeplink(url: str) -> str | None:
    """Swish deeplinks carry the Leverade tournament id as `competitionFid`."""
    values = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("competitionFid")
    return values[0] if values else None


def participant_numbers(payload: dict) -> list[str]:
    numbers = []
    for item in payload.get("included", []):
        if item.get("type") != "participant":
            continue
        number = (item.get("attributes") or {}).get("number")
        if number not in (None, ""):
            numbers.append(str(number))
    return numbers


def match_teams_by_name(nbn_teams: list[dict], leverade_teams: list[dict]) -> dict[str, str]:
    """Map NBN23 team ids to Leverade team ids by normalised name."""
    by_name = {_normalise(t["attributes"]["name"]): t["id"] for t in leverade_teams}
    return {t["id"]: by_name[_normalise(t["name"])] for t in nbn_teams if _normalise(t["name"]) in by_name}


class LeveradeClient:
    def __init__(self, base_url: str = API_BASE, min_interval: float = 0.25, retries: int = 5):
        self.base_url = base_url
        self.min_interval = min_interval
        self.retries = retries
        self._lock = threading.Lock()
        self._last_call = 0.0

    def get(self, path: str) -> dict:
        last_error: Exception | None = None
        for attempt in range(self.retries):
            with self._lock:
                wait = self._last_call + self.min_interval - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                self._last_call = time.monotonic()
            try:
                request = urllib.request.Request(self.base_url + path, headers={
                    "Accept": "application/vnd.api+json", "User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=60) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                if error.code == 429:
                    time.sleep(float(error.headers.get("Retry-After") or 5) + 1)
                elif error.code < 500:
                    raise
                last_error = error
            except urllib.error.URLError as error:
                last_error = error
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"Leverade unavailable for {path}: {last_error}")

    def tournament_teams(self, tournament_id: str) -> list[dict]:
        teams, page = [], 1
        flt = urllib.parse.quote(f"registrable[tournament].id:{tournament_id}", safe=":[]")
        while True:
            payload = self.get(f"/teams?filter={flt}&page[size]=100&page[number]={page}")
            teams.extend(payload.get("data", []))
            if not (payload.get("links") or {}).get("next") or not payload.get("data"):
                return teams
            page += 1

    def team_numbers(self, team_id: str) -> list[str]:
        return participant_numbers(self.get(f"/teams/{team_id}?include=participants"))
