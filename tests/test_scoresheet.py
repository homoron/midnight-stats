from pathlib import Path

import pytest

from midnight_stats.scoresheet import parse_scoresheet

FIXTURE = Path(__file__).parent / "fixtures" / "midnight-fivi-2026-10-04.pdf"


@pytest.fixture(scope="module")
def sheet():
    return parse_scoresheet(FIXTURE)


def by_number(team):
    return {p.number: p for p in team.players}


def test_progreso_avanza_despues_de_leer_cada_seccion_del_acta():
    completed = []
    parsed = parse_scoresheet(FIXTURE, on_progress=completed.append)
    assert completed == ["pdf-text", "pdf-header", "pdf-home", "pdf-away", "pdf-scoring"]
    assert (parsed.home.final_score, parsed.away.final_score) == (47, 53)
    assert sum(player.pts for player in parsed.home.players) == 47


def test_progreso_no_cuenta_una_seccion_que_falla(monkeypatch):
    completed = []

    def fail_header(*args):
        raise ValueError("Header extraction failed")

    monkeypatch.setattr("midnight_stats.scoresheet._parse_header", fail_header)
    with pytest.raises(ValueError, match="Header"):
        parse_scoresheet(FIXTURE, on_progress=completed.append)
    assert completed == ["pdf-text"]


def test_lee_cabecera_del_acta(sheet):
    assert sheet.home.name == "MIDNIGHT"
    assert sheet.away.name == "FIVI"
    assert sheet.date == "2026-10-04"
    assert sheet.start_time == "12:45"
    assert sheet.end_time == "14:19"


def test_lee_resultado_final_y_parciales(sheet):
    assert sheet.home.final_score == 47
    assert sheet.away.final_score == 53
    assert sheet.home.periods == [6, 7, 18, 16]
    assert sheet.away.periods == [14, 13, 8, 18]
    assert sheet.home.overtime is None
    assert sheet.away.overtime is None


def test_lee_todos_los_jugadores_con_dorsal(sheet):
    assert sorted(by_number(sheet.home)) == ["21", "22", "32", "5", "54", "55", "66", "8", "9"]
    assert sorted(by_number(sheet.away)) == ["1", "11", "13", "22", "30", "31", "5", "6", "7", "77", "8"]


def test_detecta_capitanes(sheet):
    assert [p.number for p in sheet.home.players if p.captain] == ["9"]
    assert [p.number for p in sheet.away.players if p.captain] == ["8"]


def test_detecta_quinteto_inicial_y_jugadores_que_han_jugado(sheet):
    assert {p.number for p in sheet.home.players if p.starter} == {"5", "9", "32", "54", "66"}
    assert {p.number for p in sheet.away.players if p.starter} == {"5", "6", "7", "30", "31"}
    assert all(p.played for p in sheet.home.players)
    assert all(p.played for p in sheet.away.players)


@pytest.mark.parametrize(
    "number, pts, fg2, fg3, ft",
    [
        ("22", 13, 3, 2, 1),
        ("9", 8, 3, 0, 2),
        ("5", 8, 1, 2, 0),
        ("54", 8, 2, 0, 4),
        ("55", 6, 2, 0, 2),
        ("8", 2, 1, 0, 0),
        ("32", 2, 1, 0, 0),
        ("66", 0, 0, 0, 0),
        ("21", 0, 0, 0, 0),
    ],
)
def test_calcula_puntos_de_midnight_desde_el_tanteo(sheet, number, pts, fg2, fg3, ft):
    player = by_number(sheet.home)[number]
    assert (player.pts, player.fg2, player.fg3, player.ft) == (pts, fg2, fg3, ft)


@pytest.mark.parametrize(
    "number, pts, fg2, fg3, ft",
    [
        ("22", 14, 6, 0, 2),
        ("30", 12, 3, 2, 0),
        ("11", 6, 2, 0, 2),
        ("5", 6, 0, 2, 0),
        ("8", 5, 2, 0, 1),
        ("1", 4, 1, 0, 2),
        ("31", 2, 1, 0, 0),
        ("7", 2, 1, 0, 0),
        ("77", 2, 0, 0, 2),
        ("6", 0, 0, 0, 0),
        ("13", 0, 0, 0, 0),
    ],
)
def test_calcula_puntos_de_fivi_desde_el_tanteo(sheet, number, pts, fg2, fg3, ft):
    player = by_number(sheet.away)[number]
    assert (player.pts, player.fg2, player.fg3, player.ft) == (pts, fg2, fg3, ft)


def test_la_suma_de_puntos_cuadra_con_el_resultado(sheet):
    assert sum(p.pts for p in sheet.home.players) == sheet.home.final_score
    assert sum(p.pts for p in sheet.away.players) == sheet.away.final_score


def test_lee_faltas_por_jugador(sheet):
    home = by_number(sheet.home)
    assert home["5"].fouls == ["P", "P2", "P", "P2"]
    assert home["9"].fouls == ["P1", "P", "P", "P", "P2"]
    assert home["21"].fouls == []
    assert {n: p.foul_count for n, p in home.items()} == {
        "5": 4, "8": 3, "9": 5, "21": 0, "22": 1, "32": 1, "54": 2, "55": 2, "66": 2,
    }


def test_detecta_tecnicas_y_descalificacion(sheet):
    stuyck = by_number(sheet.away)["30"]
    assert stuyck.fouls == ["P", "P2", "P2", "T2", "T"]
    assert stuyck.foul_count == 5
    assert stuyck.technicals == 2
    assert stuyck.disqualified is True
    assert by_number(sheet.home)["9"].disqualified is False


def test_lee_tiempos_muertos(sheet):
    assert sheet.home.timeouts == {"first_half": [9], "second_half": [6, 10, 10], "overtime": []}
    assert sheet.away.timeouts == {"first_half": [2], "second_half": [4, 9], "overtime": []}


def test_secuencia_de_anotacion_por_equipo_y_periodo(sheet):
    home_events = [e for e in sheet.scoring if e.team == "home"]
    away_events = [e for e in sheet.scoring if e.team == "away"]
    assert len(home_events) == 26
    assert len(away_events) == 29

    first = home_events[0]
    assert (first.period, first.number, first.points, first.score) == (1, "9", 2, 2)
    triple = next(e for e in home_events if e.score == 23)
    assert (triple.period, triple.number, triple.points) == (3, "5", 3)
    last = away_events[-1]
    assert (last.period, last.number, last.points, last.score) == (4, "22", 2, 53)

    assert [sum(e.points for e in home_events if e.period == p) for p in (1, 2, 3, 4)] == [6, 7, 18, 16]
