"""Build the static stats data for the web app.

Usage:
    python -m midnight_stats.build                      # men's 5th division (league, cup, playoff), current season
    python -m midnight_stats.build --season 2025/2026   # another season
    python -m midnight_stats.build --division CUARTA    # another division
    python -m midnight_stats.build --group <groupId>    # explicit groups
    python -m midnight_stats.build --all                # every group of the season

For every closed match it downloads the official scoresheet once, parses it and
caches the result, then writes one JSON file per group under site/data/.
Registered shirt numbers come from Leverade; names and photos typed by hand can be
added in plantillas.json.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import unicodedata
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .api import ApiError, Nbn23Client
from .leverade import LeveradeClient, match_teams_by_name, tournament_id_from_deeplink
from .scoresheet import parse_scoresheet
from .stats import add_roster_players, aggregate_players, aggregate_teams, attach_roster

ROOT = Path(__file__).resolve().parent.parent
CACHE_VERSION = 1
# Statuses used by NBN23: NOT_STARTED, LIVE, FINISHED, CLOSED (scoresheet signed) and DEFERRED.
FINAL_STATUSES = {"CLOSED", "FINISHED"}
# Matches older than this are trusted from cache without asking the API again.
RECHECK_WINDOW = timedelta(days=10)
ROSTER_TTL = timedelta(hours=12)
DEFAULT_DIVISION = "QUINTA"
DEFAULT_COMPETITION_HINT = "MASCULINA"


def select_groups(competitions: list[dict], division: str | None = DEFAULT_DIVISION,
                  group_ids: list[str] | None = None,
                  competition_hint: str = DEFAULT_COMPETITION_HINT) -> list[tuple[dict, dict]]:
    """Pick the groups to build: explicit ids, every group (division=None) or one division."""
    selected = []
    for competition in competitions:
        for group in competition.get("groups", []):
            if group_ids:
                keep = group["id"] in group_ids
            elif division is None:
                keep = True
            else:
                keep = (competition_hint in competition["name"].upper()
                        and group["name"].upper().split()[-1] == division.upper())
            if keep:
                selected.append((competition, group))
    return selected


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_date(value: str | None) -> datetime | None:
    if not value or value.startswith("1970"):
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return "".join(ch for ch in text.upper() if ch.isalnum())


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def pick_season(seasons: list[dict], wanted: str | None) -> dict:
    if wanted:
        for season in seasons:
            if wanted in (season["_id"], season["name"]):
                return season
        raise SystemExit(f"Season {wanted!r} not found. Available: {', '.join(s['name'] for s in seasons)}")
    now = _now()
    for season in seasons:
        if _parse_date(season["startDate"]) <= now <= _parse_date(season["endDate"]):
            return season
    return seasons[0]


def _link_events(match: dict) -> None:
    for event in match["scoring"]:
        player = next((p for p in match[event["team"]]["players"] if p["number"] == event["number"]), None)
        event["player_id"] = player and player.get("player_id")


def _from_cache(client: Nbn23Client, cached: dict, cache_file: Path) -> dict:
    """Return a cached match, re-attaching player names if the cache predates rosters."""
    match = cached["match"]
    if "roster" not in cached:
        roster = client.match_players(match["id"])
        for side in ("home", "away"):
            attach_roster(match[side], roster)
        _link_events(match)
        cached["roster"] = roster
        _write_json(cache_file, cached)
    return match


def build_match(client: Nbn23Client, calendar_match: dict, round_number: int, cache_dir: Path,
                log, on_progress: Callable[[str], None] | None = None) -> dict | None:
    """Return the parsed stats of a closed match, using the cache whenever possible."""
    match_id = calendar_match["id"]
    cache_file = cache_dir / f"{match_id}.json"
    cached = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.exists() else None
    if cached and cached.get("version") != CACHE_VERSION:
        cached = None
    match_date = _parse_date(calendar_match.get("date"))
    recent = match_date is None or _now() - match_date < RECHECK_WINDOW

    if cached and not recent:
        return _from_cache(client, cached, cache_file)

    detail = client.match(match_id)
    url = detail.get("scoresheetUrl")
    if not url:
        return None
    if cached and cached.get("scoresheet_url") == url:
        return _from_cache(client, cached, cache_file)

    log(f"    acta {calendar_match['homeTeam']['name']} - {calendar_match['awayTeam']['name']}")
    pdf_bytes, uploaded_at = client.download(url)
    sheet = parse_scoresheet(pdf_bytes, on_progress=on_progress).to_dict()
    roster = client.match_players(match_id)

    home_api, away_api = detail["homeTeam"], detail["awayTeam"]
    # Team A on the scoresheet is normally the home team; swap if the names say otherwise.
    sheet_home, sheet_away = _normalise(sheet["home"]["name"]), _normalise(sheet["away"]["name"])
    if sheet_home == _normalise(away_api["name"]) and sheet_away == _normalise(home_api["name"]):
        sheet["home"], sheet["away"] = sheet["away"], sheet["home"]
        for event in sheet["scoring"]:
            event["team"] = "away" if event["team"] == "home" else "home"
    elif sheet_home != _normalise(home_api["name"]) or sheet_away != _normalise(away_api["name"]):
        sheet["warnings"].append(
            f"Team names differ: acta '{sheet['home']['name']}' / '{sheet['away']['name']}'")

    totals = {t["teamId"]: t["total"] for t in (detail.get("score") or {}).get("totals", [])}
    teams = {}
    for side, api_team in (("home", home_api), ("away", away_api)):
        team = sheet[side]
        team.update(team_id=api_team["id"], name=api_team["name"], logo=api_team.get("logo"),
                    score=totals.get(api_team["id"], team.get("final_score")))
        attach_roster(team, roster)
        teams[side] = team

    match = {
        "id": match_id,
        "round": round_number,
        "date": calendar_match.get("date"),
        "home": teams["home"],
        "away": teams["away"],
        "scoring": sheet["scoring"],
        "end_time": sheet["end_time"],
        "scoresheet_url": url,
        "scoresheet_uploaded_at": uploaded_at,
        "warnings": sheet["warnings"],
    }
    _link_events(match)
    _write_json(cache_file, {"version": CACHE_VERSION, "scoresheet_url": url, "match": match, "roster": roster})
    time.sleep(0.2)
    return match


def load_overrides(path: Path) -> dict[str, list[dict]]:
    """Read plantillas.json: {"TEAM NAME": [{"number": ..., "name": ..., "photo": ...}, ...]}."""
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    overrides = {}
    for team, players in data.items():
        if team.startswith("_"):
            continue
        if isinstance(players, dict):  # older {"<number>": {...}} format
            players = [{"number": number, **extra} for number, extra in players.items()]
        overrides[_normalise(team)] = players
    return overrides


def _sort_numbers(numbers: list[str]) -> list[str]:
    return sorted(set(numbers), key=lambda n: (not n.isdigit(), int(n) if n.isdigit() else 0, n))


def fetch_rosters(client: Nbn23Client, leverade: LeveradeClient, group_id: str, teams: dict[str, dict],
                  sample_match_id: str, cache_dir: Path, log) -> dict[str, list[str]]:
    """Registered shirt numbers per NBN23 team id, cached for a few hours."""
    cache_file = cache_dir / f"{group_id}.json"
    cached = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.exists() else None
    if cached and _now() - datetime.fromisoformat(cached["fetched_at"]) < ROSTER_TTL:
        return cached["numbers"]
    try:
        tournament_id = cached.get("tournament_id") if cached else None
        tournament_id = tournament_id or tournament_id_from_deeplink(client.match_deeplink(sample_match_id))
        if not tournament_id:
            raise RuntimeError("no Leverade tournament id in the match link")
        mapping = match_teams_by_name(list(teams.values()), leverade.tournament_teams(tournament_id))
        for team_id, team in teams.items():
            if team_id not in mapping:
                log(f"    ~ {team['name']}: no aparece en Leverade, sin plantilla completa")
        numbers = {team_id: _sort_numbers(leverade.team_numbers(lev_id)) for team_id, lev_id in mapping.items()}
    except Exception as error:  # rosters are a nice-to-have; stats must still be built
        log(f"    ~ plantillas no disponibles: {type(error).__name__}: {error}")
        return cached["numbers"] if cached else {}
    _write_json(cache_file, {"fetched_at": _now().isoformat(), "tournament_id": tournament_id, "numbers": numbers})
    return numbers


def build_group(client: Nbn23Client, season: dict, competition: dict, group: dict, out_dir: Path,
                cache_dir: Path, log, workers: int = 4, leverade: LeveradeClient | None = None,
                roster_cache: Path | None = None, overrides: dict | None = None,
                current_season: bool = True) -> dict:
    calendar = client.calendar(group["id"])
    teams: dict[str, dict] = {}
    for round_ in calendar.get("rounds", []):
        for calendar_match in round_.get("matches", []):
            for side in ("homeTeam", "awayTeam"):
                if calendar_match.get(side):
                    teams[calendar_match[side]["id"]] = calendar_match[side]
    pending = [
        (calendar_match, round_number)
        for round_number, round_ in enumerate(calendar.get("rounds", []), start=1)
        for calendar_match in round_.get("matches", [])
        # Byes come as closed matches with a single team
        if calendar_match.get("status") in FINAL_STATUSES
        and calendar_match.get("homeTeam") and calendar_match.get("awayTeam")
    ]

    def run(item):
        calendar_match, round_number = item
        try:
            return calendar_match, build_match(client, calendar_match, round_number, cache_dir, log)
        except Exception as error:  # one broken scoresheet must not stop the whole build
            log(f"    ! {calendar_match['homeTeam']['name']} - {calendar_match['awayTeam']['name']}: "
                f"{type(error).__name__}: {error}")
            return calendar_match, None

    matches: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for calendar_match, match in pool.map(run, pending):
            if not match:
                continue
            matches[match["id"]] = match
            for warning in match["warnings"]:
                log(f"    ~ {calendar_match['homeTeam']['name']} - {calendar_match['awayTeam']['name']}: {warning}")

    players = aggregate_players(list(matches.values()))
    rosters: dict[str, list[str]] = {}
    sample = next((m for r in calendar.get("rounds", []) for m in r.get("matches", [])
                   if m.get("homeTeam") and m.get("awayTeam")), None)
    if leverade and roster_cache and sample:
        rosters = fetch_rosters(client, leverade, group["id"], teams, sample["id"], roster_cache, log)
    for team_id, team in teams.items():
        players = add_roster_players(players, team_id, team["name"], rosters.get(team_id, []),
                                     (overrides or {}).get(_normalise(team["name"]), []),
                                     name_only=not current_season)

    payload = {
        "group_id": group["id"],
        "group_name": group["name"],
        "competition_id": competition["id"],
        "competition_name": competition["name"],
        "season_id": season["_id"],
        "season_name": season["name"],
        "generated_at": _now().isoformat(),
        "matches": matches,
        "players": players,
        "teams": aggregate_teams(list(matches.values())),
        "rosters": rosters,
    }
    _write_json(out_dir / "groups" / f"{group['id']}.json", payload)
    return {"id": group["id"], "name": group["name"], "competition_id": competition["id"],
            "competition_name": competition["name"], "matches_with_stats": len(matches)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", help="Season name (e.g. 2026/2027) or id; defaults to the current one")
    parser.add_argument("--division", default=DEFAULT_DIVISION,
                        help="Men's division to build (league, cup and playoff groups). Default: QUINTA")
    parser.add_argument("--group", action="append", default=[], help="Only build these group ids")
    parser.add_argument("--all", action="store_true", help="Build every group of the season")
    parser.add_argument("--out", type=Path, default=ROOT / "site" / "data")
    parser.add_argument("--cache", type=Path, default=ROOT / "cache" / "matches")
    parser.add_argument("--rosters", type=Path, default=ROOT / "plantillas.json",
                        help="Hand-written names/photos per team and shirt number")
    parser.add_argument("--no-leverade", action="store_true", help="Skip registered rosters from Leverade")
    parser.add_argument("--workers", type=int, default=4, help="Scoresheets downloaded in parallel")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    def log(message: str) -> None:
        if not args.quiet:
            print(message, flush=True)

    client = Nbn23Client()
    leverade = None if args.no_leverade else LeveradeClient()
    overrides = load_overrides(args.rosters)
    seasons_list = client.seasons()
    season = pick_season(seasons_list, args.season)
    current_season = season["_id"] == pick_season(seasons_list, None)["_id"]
    log(f"Temporada {season['name']}")

    built = []
    division = None if args.all else args.division
    for competition, group in select_groups(client.competitions(season["_id"]), division, args.group):
        log(f"  {competition['name']} / {group['name']}")
        built.append(build_group(client, season, competition, group, args.out, args.cache, log,
                                 workers=args.workers, leverade=leverade,
                                 roster_cache=args.cache.parent / "rosters", overrides=overrides,
                                 current_season=current_season))

    index_file = args.out / "index.json"
    index = json.loads(index_file.read_text(encoding="utf-8")) if index_file.exists() else {}
    seasons = index.get("seasons", {})
    entry = seasons.setdefault(season["_id"], {"name": season["name"], "groups": []})
    groups = {g["id"]: g for g in entry["groups"]}
    groups.update({g["id"]: g for g in built})
    entry.update(name=season["name"], groups=list(groups.values()), generated_at=_now().isoformat())
    _write_json(index_file, {"generated_at": _now().isoformat(), "seasons": seasons})
    log(f"Listo: {sum(g['matches_with_stats'] for g in built)} partidos con estadísticas en {len(built)} grupos")
    return 0


if __name__ == "__main__":
    sys.exit(main())
