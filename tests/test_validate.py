from pathlib import Path

from midnight_stats.scoresheet import parse_scoresheet
from midnight_stats.validate import validate_match

FIXTURE = Path(__file__).parent / "fixtures" / "midnight-fivi-2026-10-04.pdf"


def built_match():
    sheet = parse_scoresheet(FIXTURE).to_dict()
    sheet["home"].update(team_id="T1", score=47)
    sheet["away"].update(team_id="T2", score=53)
    return {"id": "M1", "home": sheet["home"], "away": sheet["away"],
            "scoring": sheet["scoring"], "warnings": sheet["warnings"]}


def test_un_acta_correcta_no_tiene_incidencias():
    assert validate_match(built_match()) == []


def test_detecta_que_los_puntos_de_jugadores_no_cuadran_con_el_marcador():
    match = built_match()
    match["home"]["score"] = 49
    issues = validate_match(match)
    assert any("jugadores suman 47" in issue and "marcador 49" in issue for issue in issues)


def test_detecta_parciales_que_no_cuadran():
    match = built_match()
    match["away"]["periods"] = [14, 13, 8, 10]
    assert any("parciales" in issue for issue in validate_match(match))


def test_detecta_quinteto_inicial_incompleto():
    match = built_match()
    match["home"]["players"][0]["starter"] = False
    assert any("titulares" in issue for issue in validate_match(match))


def test_detecta_jugador_que_anota_sin_haber_jugado():
    match = built_match()
    scorer = next(p for p in match["home"]["players"] if p["pts"] > 0)
    scorer["played"] = False
    assert any("anota sin marca de jugado" in issue for issue in validate_match(match))


def test_incluye_los_avisos_del_parser():
    match = built_match()
    match["warnings"] = ["MIDNIGHT: jump of 4 points to 20 by #9"]
    assert "MIDNIGHT: jump of 4 points to 20 by #9" in validate_match(match)
