"""Parser for NBN23 digital scoresheets (FIBA-style "acta" PDFs).

The scoresheet only records made baskets, so per-player stats are rebuilt from
the running score ("tanteo arrastrado"): every row is one point, and the scorer
writes the player's number next to the score his basket reached. The jump from
the team's previous score tells whether it was a free throw (1), a two (2) or a
three (3). Pre-printed grid numbers are black; anything the scorer writes is
coloured (red/blue alternating by period), which is how both are told apart.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

import pdfplumber

# pdfminer complains about the embedded fonts on every page; the text is fine.
logging.getLogger("pdfminer").setLevel(logging.ERROR)

ROW_TOLERANCE = 2.5
FOUL_LETTERS = "PTUDCBF"
TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
TRAILING_NUMBER_RE = re.compile(r"^(.*?)(\d+)$")


@dataclass
class PlayerLine:
    number: str
    name: str
    captain: bool = False
    starter: bool = False
    played: bool = False
    pts: int = 0
    fg2: int = 0
    fg3: int = 0
    ft: int = 0
    fouls: list[str] = field(default_factory=list)
    disqualified: bool = False

    @property
    def foul_count(self) -> int:
        return sum(1 for code in self.fouls if code[0] in "PTUD")

    @property
    def technicals(self) -> int:
        return sum(1 for code in self.fouls if code.startswith("T"))

    @property
    def unsportsmanlike(self) -> int:
        return sum(1 for code in self.fouls if code.startswith("U"))

    def to_dict(self) -> dict:
        data = asdict(self)
        data.update(
            foul_count=self.foul_count,
            technicals=self.technicals,
            unsportsmanlike=self.unsportsmanlike,
        )
        return data


@dataclass
class TeamSheet:
    name: str
    final_score: int | None = None
    periods: list[int] = field(default_factory=list)
    overtime: int | None = None
    timeouts: dict[str, list[int]] = field(
        default_factory=lambda: {"first_half": [], "second_half": [], "overtime": []}
    )
    players: list[PlayerLine] = field(default_factory=list)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["players"] = [p.to_dict() for p in self.players]
        return data


@dataclass
class ScoringEvent:
    team: str  # "home" | "away"
    period: int  # 1-4, 5 = overtime
    number: str
    points: int
    score: int


@dataclass
class Scoresheet:
    home: TeamSheet
    away: TeamSheet
    date: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    competition: str | None = None
    scoring: list[ScoringEvent] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "home": self.home.to_dict(),
            "away": self.away.to_dict(),
            "date": self.date,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "competition": self.competition,
            "scoring": [asdict(e) for e in self.scoring],
            "warnings": list(self.warnings),
        }


# --------------------------------------------------------------------------- helpers


def _is_black(color) -> bool:
    if color is None:
        return True
    if isinstance(color, (int, float)):
        return color < 0.2
    values = list(color)
    if len(values) == 4:  # CMYK
        return values[3] > 0.8 and max(values[:3]) < 0.2
    return max(values) < 0.2


def _same_row(a: dict, b: dict, tolerance: float = ROW_TOLERANCE) -> bool:
    return abs(a["top"] - b["top"]) <= tolerance


def _row_words(words: Iterable[dict], anchor: dict) -> list[dict]:
    return sorted((w for w in words if _same_row(w, anchor)), key=lambda w: w["x0"])


def _word_after(words: list[dict], anchor: dict) -> dict | None:
    row = _row_words(words, anchor)
    following = [w for w in row if w["x0"] > anchor["x1"]]
    return following[0] if following else None


def _find(words: list[dict], predicate) -> list[dict]:
    return [w for w in words if predicate(w["text"])]


def _int_or_none(text: str | None) -> int | None:
    return int(text) if text and text.isdigit() else None


def _group_rows(words: Iterable[dict]) -> list[list[dict]]:
    rows: list[list[dict]] = []
    for word in sorted(words, key=lambda w: w["top"]):
        if rows and abs(rows[-1][0]["top"] - word["top"]) <= ROW_TOLERANCE:
            rows[-1].append(word)
        else:
            rows.append([word])
    return [sorted(row, key=lambda w: w["x0"]) for row in rows]


# --------------------------------------------------------------------------- sections


def _parse_header(words: list[dict], sheet: Scoresheet) -> None:
    labels = [w for w in words if w["text"] == "Equipo"]
    labels.sort(key=lambda w: (w["top"], w["x0"]))
    if len(labels) >= 2 and _same_row(labels[0], labels[1]):
        label_a, label_b = labels[0], labels[1]
        row = [w for w in _row_words(words, label_a) if not _is_black(w["non_stroking_color"])]
        sheet.home.name = " ".join(w["text"] for w in row if label_a["x1"] < w["x0"] < label_b["x0"])
        sheet.away.name = " ".join(w["text"] for w in row if w["x0"] > label_b["x1"])

    fecha = next(iter(_find(words, lambda t: t == "Fecha")), None)
    if fecha:
        value = _word_after(words, fecha)
        match = value and re.match(r"^(\d{2})/(\d{2})/(\d{4})$", value["text"])
        if match:
            sheet.date = f"{match.group(3)}-{match.group(2)}-{match.group(1)}"
        hora = next((w for w in _row_words(words, fecha) if w["text"] == "Hora"), None)
        start = hora and _word_after(words, hora)
        if start and TIME_RE.match(start["text"]):
            sheet.start_time = start["text"]

    competition = next(iter(_find(words, lambda t: t.startswith("Competici"))), None)
    if competition:
        row = _row_words(words, competition)
        end_x = fecha["x0"] if fecha and _same_row(fecha, competition) else float("inf")
        sheet.competition = " ".join(w["text"] for w in row if competition["x1"] < w["x0"] < end_x) or None

    for fin in _find(words, lambda t: t == "fin"):
        row = _row_words(words, fin)
        times = [w for w in row if w["x0"] > fin["x1"] and TIME_RE.match(w["text"])]
        if times:
            sheet.end_time = times[0]["text"]


def _parse_results(words: list[dict], sheet: Scoresheet) -> None:
    resultado = next(iter(_find(words, lambda t: t == "Resultado")), None)
    if resultado:
        below = [w for w in words if resultado["top"] + 5 < w["top"] < resultado["top"] + 45
                 and resultado["x0"] <= w["x0"] < resultado["x0"] + 90]
        for label, team in (("A", sheet.home), ("B", sheet.away)):
            tag = next((w for w in below if w["text"] == label), None)
            value = tag and _word_after(below, tag)
            team.final_score = _int_or_none(value and value["text"])

    headers = [w for w in words if w["text"] == "Periodo" and w["x0"] > 250]
    if not headers:
        return
    header_top = min(w["top"] for w in headers)
    values_row = sorted(
        (w for w in words if header_top + 8 < w["top"] < header_top + 30 and w["x0"] > 250),
        key=lambda w: w["x0"],
    )
    found: dict[str, list[int | None]] = {"A": [], "B": []}
    for i, word in enumerate(values_row):
        if word["text"] in found:
            nxt = values_row[i + 1] if i + 1 < len(values_row) else None
            found[word["text"]].append(_int_or_none(nxt["text"]) if nxt else None)
    for label, team in (("A", sheet.home), ("B", sheet.away)):
        values = found[label]
        team.periods = [v or 0 for v in values[:4]]
        team.overtime = values[4] if len(values) > 4 else None


def _parse_timeouts(words: list[dict], label: dict, team: TeamSheet) -> None:
    first_row_top = label["top"] + 13
    keys = ["first_half", "second_half", "overtime"]
    for word in words:
        if word["text"].isdigit() and 25 <= word["x0"] <= 70 and label["top"] + 8 < word["top"] < label["top"] + 50:
            index = min(max(round((word["top"] - first_row_top) / 12.8), 0), 2)
            team.timeouts[keys[index]].append(int(word["text"]))
    for key in keys:
        team.timeouts[key].sort()


def _foul_tokens(chars: list[dict]) -> list[str]:
    """Rebuild foul codes like P, P2, T1 or GD from big letters plus subscript digits."""
    tokens: list[list] = []  # [text, x1]
    for ch in sorted(chars, key=lambda c: c["x0"]):
        text = ch["text"].strip()
        if not text:
            continue
        is_subscript = ch["size"] < 7.0
        if is_subscript and tokens and text.isdigit():
            tokens[-1][0] += text
            tokens[-1][1] = ch["x1"]
        elif not is_subscript and tokens and ch["x0"] - tokens[-1][1] < 1.0 and text.isalpha():
            tokens[-1][0] += text
            tokens[-1][1] = ch["x1"]
        elif not is_subscript:
            tokens.append([text, ch["x1"]])
    return [t[0] for t in tokens]


def _parse_players(page, words: list[dict], header: dict, footer_top: float, team: TeamSheet) -> None:
    circles = [c for c in page.curves if (c["x1"] - c["x0"]) < 12 and (c["bottom"] - c["top"]) < 12]
    table_words = [w for w in words if header["top"] + 8 < w["top"] < footer_top - 5 and 45 <= w["x0"] < 145]

    for row in _group_rows(table_words):
        number_match = TRAILING_NUMBER_RE.match(row[-1]["text"])
        if not number_match:
            continue
        name_parts = [w["text"] for w in row[:-1]]
        if number_match.group(1):
            name_parts.append(number_match.group(1))
        captain = "(CAP)" in name_parts
        name = " ".join(p for p in name_parts if p != "(CAP)").strip()
        row_top = row[0]["top"]

        played_marks = [c for c in page.chars
                        if c["text"] == "X" and 145 <= c["x0"] <= 158 and abs(c["top"] - row_top) <= 3]
        starter = any(
            circle["x0"] <= (mark["x0"] + mark["x1"]) / 2 <= circle["x1"]
            and circle["top"] <= (mark["top"] + mark["bottom"]) / 2 <= circle["bottom"]
            for mark in played_marks for circle in circles
        )
        foul_chars = [c for c in page.chars
                      if 160 <= c["x0"] < 262 and row_top - 3 <= c["top"] <= row_top + 8]
        codes = _foul_tokens(foul_chars)
        fouls = [c for c in codes if c[0] in FOUL_LETTERS and c not in ("GD",)]
        player = PlayerLine(
            number=number_match.group(2),
            name=name,
            captain=captain,
            starter=starter,
            played=bool(played_marks),
            fouls=fouls,
        )
        player.disqualified = (
            "GD" in codes
            or any(c.startswith("D") for c in fouls)
            or player.technicals + player.unsportsmanlike >= 2
        )
        team.players.append(player)


def _parse_running_score(words: list[dict], sheet: Scoresheet, top: float, bottom: float) -> None:
    region = [w for w in words if w["x0"] > 262 and top < w["top"] < bottom and w["text"].isdigit()]
    grid = [w for w in region if _is_black(w["non_stroking_color"])]
    marks = [w for w in region if not _is_black(w["non_stroking_color"])]

    per_team: dict[str, list[tuple[int, str]]] = {"home": [], "away": []}
    for mark in marks:
        best = None
        for cell in grid:
            if not _same_row(cell, mark):
                continue
            if cell["x0"] >= mark["x1"]:
                gap, team = cell["x0"] - mark["x1"], "home"
            elif cell["x1"] <= mark["x0"]:
                gap, team = mark["x0"] - cell["x1"], "away"
            else:
                continue
            if best is None or gap < best[0]:
                best = (gap, team, int(cell["text"]))
        if best is None or best[0] > 25:
            sheet.warnings.append(f"Unplaced running-score mark {mark['text']} at y={mark['top']:.0f}")
            continue
        per_team[best[1]].append((best[2], mark["text"]))

    for team_key, team in (("home", sheet.home), ("away", sheet.away)):
        players = {p.number: p for p in team.players}
        period_ends = []
        running = 0
        for value in team.periods:
            running += value
            period_ends.append(running)
        previous = 0
        for score, number in sorted(per_team[team_key]):
            points = score - previous
            previous = score
            period = next((i + 1 for i, end in enumerate(period_ends) if score <= end), 5)
            sheet.scoring.append(ScoringEvent(team=team_key, period=period, number=number,
                                              points=points, score=score))
            player = players.get(number)
            if player is None:
                player = PlayerLine(number=number, name="")
                team.players.append(player)
                players[number] = player
                sheet.warnings.append(f"{team.name}: number {number} scores but is not in the roster")
            player.pts += points
            if points == 1:
                player.ft += 1
            elif points == 2:
                player.fg2 += 1
            elif points == 3:
                player.fg3 += 1
            else:
                sheet.warnings.append(f"{team.name}: jump of {points} points to {score} by #{number}")
        if team.final_score is not None and previous != team.final_score:
            sheet.warnings.append(f"{team.name}: running score ends at {previous}, result says {team.final_score}")

    sheet.scoring.sort(key=lambda e: (e.period, e.team != "home", e.score))


# --------------------------------------------------------------------------- entry point


def parse_scoresheet(source) -> Scoresheet:
    """Parse a scoresheet PDF given as a path, bytes or file-like object."""
    if isinstance(source, (bytes, bytearray)):
        import io
        source = io.BytesIO(source)
    elif isinstance(source, (str, Path)):
        source = str(source)

    with pdfplumber.open(source) as pdf:
        page = pdf.pages[0]
        words = page.extract_words(extra_attrs=["non_stroking_color", "size"])
        sheet = Scoresheet(home=TeamSheet(name=""), away=TeamSheet(name=""))

        _parse_header(words, sheet)
        _parse_results(words, sheet)

        player_headers = sorted((w for w in words if w["text"] == "Jugadores"), key=lambda w: w["top"])
        coach_labels = sorted((w for w in words if w["text"] == "Entrenador" and w["x0"] < 100),
                              key=lambda w: w["top"])
        timeout_labels = sorted((w for w in words if w["text"] == "Tiempos" and w["x0"] < 80),
                                key=lambda w: w["top"])
        for i, team in enumerate((sheet.home, sheet.away)):
            if i < len(player_headers):
                footer = coach_labels[i]["top"] if i < len(coach_labels) else player_headers[i]["top"] + 200
                _parse_players(page, words, player_headers[i], footer, team)
            if i < len(timeout_labels):
                _parse_timeouts(words, timeout_labels[i], team)

        grid_headers = [w for w in words if w["text"] in ("A", "B") and w["x0"] > 262]
        grid_top = min((w["top"] for w in grid_headers), default=100) + 5
        period_headers = [w["top"] for w in words if w["text"] == "Periodo" and w["x0"] > 250]
        grid_bottom = min(period_headers, default=page.height) - 3
        _parse_running_score(words, sheet, grid_top, grid_bottom)

    return sheet
