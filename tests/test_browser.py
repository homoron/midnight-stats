from pathlib import Path
import zipfile

import pytest

from midnight_stats.browser import create_browser_bundle, merge_matches, parse_match


@pytest.fixture
def match_data():
    home = {"id": "HOME", "name": "MIDNIGHT"}
    away = {"id": "AWAY", "name": "FIVI"}
    calendar = {"id": "MATCH", "status": "CLOSED", "date": "2026-10-04T10:45:00Z",
                "round": 1, "homeTeam": home, "awayTeam": away}
    detail = {**calendar, "scoresheetUrl": "https://storage.googleapis.com/match-scorecard-pdf/fixture.pdf",
              "score": {"totals": [{"teamId": "HOME", "total": 47}, {"teamId": "AWAY", "total": 53}]}}
    roster = [{"id": "OSCAR", "teamId": "HOME", "number": "54", "name": "Oscar", "lastName": "Lago Angel"}]
    return calendar, detail, roster


def test_lector_manual_reutiliza_el_parser_y_los_ids_de_jugadores(match_data):
    calendar, detail, roster = match_data
    pdf = (Path(__file__).parent / "fixtures" / "midnight-fivi-2026-10-04.pdf").read_bytes()
    match = parse_match(pdf, calendar, detail, roster, "2026-10-04T12:00:00Z")
    assert (match["home"]["final_score"], match["away"]["final_score"]) == (47, 53)
    assert (match["home"]["score"], match["away"]["score"]) == (47, 53)
    assert (match["id"], match["round"], match["date"]) == ("MATCH", 1, calendar["date"])
    assert match["scoresheet_uploaded_at"] == "2026-10-04T12:00:00Z"
    oscar = next(player for player in match["home"]["players"] if player["number"] == "54")
    assert (oscar["player_id"], oscar["name"], oscar["pts"]) == ("OSCAR", "Oscar Lago Angel", 8)
    assert all(event["player_id"] == "OSCAR" for event in match["scoring"]
               if event["team"] == "home" and event["number"] == "54")


def test_lector_manual_no_procesa_partidos_en_directo(match_data):
    calendar, detail, roster = match_data
    calendar["status"] = "LIVE"
    with pytest.raises(ValueError, match="finished"):
        parse_match(b"", calendar, detail, roster)


def test_lector_manual_rechaza_detalles_de_otro_partido(match_data):
    calendar, detail, roster = match_data
    detail["id"] = "OTHER"
    with pytest.raises(ValueError, match="match"):
        parse_match(b"", calendar, detail, roster)


def test_lector_manual_distingue_un_pdf_aun_no_publicado(match_data):
    calendar, detail, roster = match_data
    detail["scoresheetUrl"] = None
    with pytest.raises(ValueError, match="available"):
        parse_match(b"", calendar, detail, roster)


def test_lector_manual_conserva_el_resultado_administrativo(match_data):
    calendar, detail, roster = match_data
    detail["score"]["totals"] = [{"teamId": "HOME", "total": 20}, {"teamId": "AWAY", "total": 0}]
    pdf = (Path(__file__).parent / "fixtures" / "midnight-fivi-2026-10-04.pdf").read_bytes()
    match = parse_match(pdf, calendar, detail, roster)
    assert (match["home"]["score"], match["home"]["final_score"]) == (20, 47)
    assert (match["away"]["score"], match["away"]["final_score"]) == (0, 53)


def test_lector_manual_rechaza_puntos_que_no_cuadran(match_data, monkeypatch):
    calendar, detail, roster = match_data
    broken = {"home": {"final_score": 10, "players": [{"pts": 4}]},
              "away": {"final_score": 0, "players": []}, "scoring": []}
    monkeypatch.setattr("midnight_stats.browser.build_match", lambda *args: broken)
    with pytest.raises(ValueError, match="points"):
        parse_match(b"", calendar, detail, roster)


def test_mezcla_manual_actualiza_acumulados_sin_duplicar_y_conserva_los_dos_dorsales_cinco():
    def match(match_id, points):
        line = {"player_id": "IVAN", "number": "5", "name": "Iván Cardos García", "played": True,
                "starter": True, "pts": points, "fg2": points // 2, "fg3": 0, "ft": 0, "foul_count": 1}
        return {"id": match_id, "round": 1, "date": "2026-10-18T16:00:00Z",
                "home": {"team_id": "MID", "name": "MIDNIGHT", "score": points, "players": [line], "periods": [points]},
                "away": {"team_id": "OTHER", "name": "OTHER", "score": 0, "players": [], "periods": [0]}}

    group = {"matches": {"M1": match("M1", 2)}, "rosters": {"MID": ["5"]},
             "players": [{"player_id": "IVAN", "team_id": "MID", "team_name": "MIDNIGHT", "number": "5",
                          "name": "Iván Cardos García", "photo": "ivan.jpg"},
                         {"player_id": "NAHUN", "team_id": "MID", "team_name": "MIDNIGHT", "number": "5",
                          "name": "Nahun Balladares Bohorquez", "photo": "nahun.jpg"}],
             "generated_at": "2026-10-18T15:00:00Z"}
    checked = match("M2", 4)
    result = merge_matches(group, [checked], "2026-10-18T17:00:00Z")
    ivan = next(player for player in result["players"] if player["name"] == "Iván Cardos García")
    nahun = next(player for player in result["players"] if player["name"] == "Nahun Balladares Bohorquez")
    assert (ivan["games"], ivan["pts"], ivan["ppg"], ivan["photo"]) == (2, 6, 3.0, "ivan.jpg")
    assert (nahun["games"], nahun["pts"], nahun["photo"]) == (0, 0, "nahun.jpg")
    assert next(team for team in result["teams"] if team["team_id"] == "MID")["games"] == 2
    assert merge_matches(result, [checked])["players"] == result["players"]
    assert set(group["matches"]) == {"M1"}
    assert result["generated_at"] == "2026-10-18T17:00:00Z"


def test_paquete_del_navegador_contiene_fuentes_sin_cache_ni_datos(tmp_path):
    destination = tmp_path / "reader.zip"
    create_browser_bundle(destination)
    with zipfile.ZipFile(destination) as archive:
        names = set(archive.namelist())
        assert {"midnight_stats/__init__.py", "midnight_stats/browser.py", "midnight_stats/build.py",
                "midnight_stats/scoresheet.py", "midnight_stats/stats.py"} <= names
        assert all(name.startswith("midnight_stats/") and name.endswith(".py") for name in names)
        assert "def parse_scoresheet" in archive.read("midnight_stats/scoresheet.py").decode("utf-8")
