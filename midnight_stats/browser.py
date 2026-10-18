"""Share the existing scoresheet reader with the on-demand browser worker."""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile

from .build import FINAL_STATUSES, build_match
from .stats import add_roster_players, aggregate_players, aggregate_teams


def parse_match(pdf_bytes: bytes, calendar_match: dict, detail: dict, roster: list[dict],
                uploaded_at: str | None = None) -> dict:
    """Parse one finished match without network access, using the workflow's reader."""
    if calendar_match.get("status") not in FINAL_STATUSES:
        raise ValueError("Only a finished match can be checked")
    if detail.get("id") != calendar_match.get("id"):
        raise ValueError("The details do not match the requested match")
    if not detail.get("scoresheetUrl"):
        raise ValueError("The scoresheet is not available yet")
    client = SimpleNamespace(
        match=lambda match_id: detail,
        download=lambda url: (pdf_bytes, uploaded_at),
        match_players=lambda match_id: roster,
    )
    with TemporaryDirectory() as directory:
        match = build_match(client, calendar_match, calendar_match.get("round", 0),
                            Path(directory), lambda message: None)
    if match is None:
        raise ValueError("The scoresheet is not available yet")
    for side in ("home", "away"):
        team = match[side]
        if team.get("final_score") is None or sum(player.get("pts", 0) for player in team["players"]) != team["final_score"]:
            raise ValueError("The scoresheet points could not be validated")
    if any(event["points"] not in (1, 2, 3) for event in match["scoring"]):
        raise ValueError("The scoresheet contains an invalid points increment")
    return match


def merge_matches(group: dict, checked_matches: list[dict], checked_at: str | None = None) -> dict:
    """Add locally read matches without replacing published data or duplicating games."""
    result = deepcopy(group)
    matches = result.setdefault("matches", {})
    additions = [match for match in checked_matches if match["id"] not in matches]
    if not additions:
        return result
    matches.update({match["id"]: deepcopy(match) for match in additions})
    previous_players = result.get("players", [])
    players = aggregate_players(list(matches.values()))
    teams = {player["team_id"]: player["team_name"] for player in previous_players}
    for match in matches.values():
        for side in ("home", "away"):
            teams[match[side]["team_id"]] = match[side]["name"]
    for team_id, team_name in teams.items():
        extras = [{key: player[key] for key in ("number", "name", "photo") if key in player}
                  for player in previous_players if player["team_id"] == team_id]
        players = add_roster_players(players, team_id, team_name,
                                     result.get("rosters", {}).get(team_id, []), extras)
    result["players"] = players
    result["teams"] = aggregate_teams(list(matches.values()))
    timestamps = [value for value in (group.get("generated_at"), checked_at) if value]
    if timestamps:
        result["generated_at"] = max(timestamps, key=lambda value: datetime.fromisoformat(value.replace("Z", "+00:00")))
    return result


def create_browser_bundle(destination: Path) -> None:
    """Package Python sources only; generated data and native dependencies stay out."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for source in sorted(Path(__file__).parent.glob("*.py")):
            archive.write(source, f"midnight_stats/{source.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=Path(__file__).resolve().parent.parent / "site" / "reader.zip")
    create_browser_bundle(parser.parse_args().bundle)
