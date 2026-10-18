"""Consistency checks for parsed scoresheets.

Usage:
    python -m midnight_stats.validate                 # every group file in site/data
    python -m midnight_stats.validate --season 2025/2026 --report reports/validacion.md
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _team_issues(team: dict) -> list[str]:
    name = team.get("name", "?")
    issues = []
    players = team.get("players", [])
    points = sum(p.get("pts", 0) for p in players)
    score = team.get("score")
    if score is not None and points != score:
        issues.append(f"{name}: jugadores suman {points}, marcador {score}")
    final = team.get("final_score")
    if final is not None and score is not None and final != score:
        issues.append(f"{name}: el acta dice {final}, la API {score}")
    periods = team.get("periods") or []
    if periods and score is not None and sum(periods) + (team.get("overtime") or 0) != score:
        issues.append(f"{name}: parciales {periods} (+{team.get('overtime') or 0}) no suman {score}")
    starters = sum(1 for p in players if p.get("starter"))
    if starters != 5:
        issues.append(f"{name}: {starters} titulares")
    for player in players:
        if player.get("pts", 0) > 0 and not player.get("played"):
            issues.append(f"{name}: #{player['number']} anota sin marca de jugado")
    return issues


def validate_match(match: dict) -> list[str]:
    """Return human readable issues (empty when the scoresheet is fully consistent)."""
    return list(match.get("warnings", [])) + _team_issues(match["home"]) + _team_issues(match["away"])


def _classify(issue: str) -> str:
    for key, label in (("suman", "Puntos no cuadran"), ("parciales", "Parciales no cuadran"),
                       ("titulares", "Titulares != 5"), ("jump", "Salto imposible en el tanteo"),
                       ("not in the roster", "Dorsal fuera de la plantilla"), ("Unplaced", "Marca sin ubicar"),
                       ("acta dice", "Resultado administrativo (acta != API)"), ("running score ends", "Tanteo != resultado"),
                       ("jugado", "Anota sin jugar")):
        if key in issue:
            return label
    return "Otros"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=ROOT / "site" / "data")
    parser.add_argument("--season", help="Only groups of this season name or id")
    parser.add_argument("--report", type=Path, help="Write a Markdown report here")
    args = parser.parse_args(argv)

    files = sorted((args.data / "groups").glob("*.json"))
    total, bad = 0, 0
    kinds: Counter[str] = Counter()
    lines: list[str] = []
    for path in files:
        group = json.loads(path.read_text(encoding="utf-8"))
        if args.season and args.season not in (group["season_id"], group["season_name"]):
            continue
        group_issues = []
        for match in sorted(group["matches"].values(), key=lambda m: (m.get("round") or 0, m["id"])):
            total += 1
            issues = validate_match(match)
            if issues:
                bad += 1
                kinds.update(_classify(i) for i in issues)
                title = f"J{match.get('round')} {match['home']['name']} {match['home'].get('score')}-" \
                        f"{match['away'].get('score')} {match['away']['name']}"
                group_issues.append(f"- **{title}** ([acta]({match.get('scoresheet_url')}))\n"
                                    + "\n".join(f"  - {i}" for i in issues))
        if group_issues:
            lines.append(f"\n### {group['competition_name']} · {group['group_name']} ({group['season_name']})\n")
            lines.extend(group_issues)

    ok = total - bad
    summary = [
        "# Validación de actas",
        "",
        f"- Actas analizadas: **{total}**",
        f"- Totalmente consistentes: **{ok}** ({(ok / total * 100) if total else 0:.1f} %)",
        f"- Con alguna incidencia: **{bad}**",
        "",
        "| Tipo de incidencia | Nº |",
        "|---|---|",
        *[f"| {kind} | {count} |" for kind, count in kinds.most_common()],
    ]
    report = "\n".join(summary + ["", "## Detalle"] + lines) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report, encoding="utf-8")
    print("\n".join(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
