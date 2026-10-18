"""Season aggregation of parsed scoresheets: player and team totals, averages and game logs."""

from __future__ import annotations

import unicodedata
from collections import defaultdict

STAT_KEYS = ("pts", "fg2", "fg3", "ft")


def _avg(total: float, games: int) -> float:
    return round(total / games, 1) if games else 0


def attach_roster(team: dict, roster: list[dict]) -> dict:
    """Give every scoresheet line the API player id and full name, matched by team and number."""
    by_number = {p["number"]: p for p in roster if p.get("teamId") == team["team_id"]}
    for player in team["players"]:
        player.setdefault("acta_name", player["name"])
        api_player = by_number.get(player["number"])
        if api_player:
            player["player_id"] = api_player["id"]
            player["first_name"] = (api_player.get("name") or "").strip()
            player["last_name"] = (api_player.get("lastName") or "").strip()
            player["name"] = f"{player['first_name']} {player['last_name']}".strip()
        else:
            player.setdefault("player_id", f"{team['team_id']}#{player['number']}")
    return team


def short_name(player: dict) -> str:
    """'O. Lago' style label from API names, falling back to 'LAGO ANGEL, O.' scoresheet names."""
    first, last = player.get("first_name"), player.get("last_name")
    if first and last:
        return f"{first[0]}. {last.split()[0]}"
    name = player.get("name") or ""
    if "," in name:
        surname, initial = (part.strip() for part in name.split(",", 1))
        return f"{initial[:1]}. {surname.split()[0].title()}" if initial else surname.title()
    return name


def _sides(match: dict):
    yield match["home"], match["away"], True
    yield match["away"], match["home"], False


def aggregate_players(matches: list[dict]) -> list[dict]:
    players: dict[str, dict] = {}
    for match in sorted(matches, key=lambda m: (m.get("round") or 0, m.get("date") or "")):
        for team, opponent, is_home in _sides(match):
            won = (team.get("score") or 0) > (opponent.get("score") or 0)
            # Scorers sometimes circle every player; then nobody's start can be trusted.
            starters_known = sum(1 for p in team.get("players", []) if p.get("starter")) == 5
            for line in team.get("players", []):
                pid = line.get("player_id") or f"{team['team_id']}#{line['number']}"
                entry = players.setdefault(pid, {
                    "player_id": pid, "team_id": team["team_id"], "team_name": team["name"],
                    "name": line.get("name", ""), "number": line["number"],
                    "games": 0, "starts": 0, "fouls": 0, "high": 0, "log": [],
                    **{k: 0 for k in STAT_KEYS},
                })
                entry["name"] = line.get("name") or entry["name"]
                if (line.get("first_name") and line.get("last_name")) or not entry.get("short_name"):
                    entry["short_name"] = short_name(line)
                entry["number"] = line["number"]
                if not line.get("played"):
                    continue
                entry["games"] += 1
                starter = bool(line.get("starter")) if starters_known else None
                entry["starts"] += int(bool(starter))
                entry["fouls"] += line.get("foul_count", 0)
                for key in STAT_KEYS:
                    entry[key] += line.get(key, 0)
                entry["high"] = max(entry["high"], line.get("pts", 0))
                entry["log"].append({
                    "match_id": match["id"], "round": match.get("round"), "date": match.get("date"),
                    "opponent": opponent["name"], "opponent_id": opponent["team_id"], "home": is_home,
                    "result": "W" if won else "L", "score": f"{team.get('score')}-{opponent.get('score')}",
                    "starter": starter, "fouls": line.get("foul_count", 0),
                    **{k: line.get(k, 0) for k in STAT_KEYS},
                })

    for entry in players.values():
        games = entry["games"]
        entry.update(
            ppg=_avg(entry["pts"], games), fg2pg=_avg(entry["fg2"], games),
            fg3pg=_avg(entry["fg3"], games), ftpg=_avg(entry["ft"], games),
            fpg=_avg(entry["fouls"], games),
        )
    return sorted(players.values(), key=lambda p: (-p["pts"], p["name"]))


def _name_key(name: str | None) -> str:
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return "".join(ch for ch in text.upper() if ch.isalnum())


def _placeholder(team_id: str, team_name: str, number: str, player_id: str) -> dict:
    return {
        "player_id": player_id, "team_id": team_id, "team_name": team_name,
        "name": "", "short_name": "", "number": number,
        "games": 0, "starts": 0, "fouls": 0, "high": 0, "log": [],
        **{k: 0 for k in STAT_KEYS},
        "ppg": 0, "fg2pg": 0, "fg3pg": 0, "ftpg": 0, "fpg": 0,
    }


def add_roster_players(players: list[dict], team_id: str, team_name: str, numbers: list[str],
                       overrides: list[dict], name_only: bool = False) -> list[dict]:
    """Add registered players who have not appeared on any scoresheet yet, plus manual names/photos.

    `numbers` are the shirt numbers registered for the team. `overrides` is a list of
    {"number", "name", "photo"} written by hand: each one is matched by name first (so two
    players can share a number), then by an unnamed shirt number. Scoresheet names always win.
    With `name_only` (past seasons) overrides are matched by name only, since a shirt number
    may have belonged to someone else back then.
    """
    result = list(players)
    team = [p for p in result if p["team_id"] == team_id]
    taken = {p["number"] for p in team}
    for number in numbers:
        if number not in taken:
            entry = _placeholder(team_id, team_name, number, f"{team_id}#{number}")
            result.append(entry)
            team.append(entry)
            taken.add(number)

    for extra in overrides:
        number = str(extra.get("number", "")).strip()
        key = _name_key(extra.get("name"))
        entry = next((p for p in team if key and _name_key(p.get("name")) == key), None)
        if entry is None and name_only:
            continue
        if entry is None:
            entry = next((p for p in team if p["number"] == number and not p.get("name")), None)
        if entry is None and number:
            entry = _placeholder(team_id, team_name, number, f"{team_id}#{number}-{key.lower() or len(team)}")
            result.append(entry)
            team.append(entry)
        if entry is None:
            continue
        if extra.get("photo"):
            entry["photo"] = extra["photo"]
        if extra.get("name") and not entry.get("name"):
            first, _, last = extra["name"].strip().partition(" ")
            entry["name"] = extra["name"].strip()
            entry["short_name"] = short_name({"first_name": first, "last_name": last, "name": entry["name"]})
    return result


def aggregate_teams(matches: list[dict]) -> list[dict]:
    teams: dict[str, dict] = {}
    period_totals: dict[str, list[list[int]]] = defaultdict(list)
    for match in matches:
        for team, opponent, _ in _sides(match):
            entry = teams.setdefault(team["team_id"], {
                "team_id": team["team_id"], "name": team["name"], "games": 0, "wins": 0, "losses": 0,
                "pts_for": 0, "pts_against": 0, "fouls": 0, **{k: 0 for k in STAT_KEYS if k != "pts"},
            })
            score, against = team.get("score") or 0, opponent.get("score") or 0
            entry["games"] += 1
            entry["wins" if score > against else "losses"] += 1
            entry["pts_for"] += score
            entry["pts_against"] += against
            for line in team.get("players", []):
                entry["fouls"] += line.get("foul_count", 0)
                for key in ("fg2", "fg3", "ft"):
                    entry[key] += line.get(key, 0)
            period_totals[team["team_id"]].append(team.get("periods") or [])

    for team_id, entry in teams.items():
        games = entry["games"]
        periods = period_totals[team_id]
        width = max((len(p) for p in periods), default=0)
        entry.update(
            ppg=_avg(entry["pts_for"], games), oppg=_avg(entry["pts_against"], games),
            fg3pg=_avg(entry["fg3"], games), ftpg=_avg(entry["ft"], games), fpg=_avg(entry["fouls"], games),
            period_avg=[_avg(sum(p[i] for p in periods if len(p) > i), games) for i in range(width)],
        )
    return sorted(teams.values(), key=lambda t: (-t["wins"], t["losses"], -(t["pts_for"] - t["pts_against"])))
