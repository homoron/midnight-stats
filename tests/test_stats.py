from midnight_stats.stats import add_roster_players, aggregate_players, aggregate_teams, attach_roster


def line(number, pts=0, fg2=0, fg3=0, ft=0, fouls=0, starter=False, played=True, name="ACTA, N."):
    return {
        "number": number, "name": name, "captain": False, "starter": starter, "played": played,
        "pts": pts, "fg2": fg2, "fg3": fg3, "ft": ft, "fouls": ["P"] * fouls,
        "foul_count": fouls, "technicals": 0, "unsportsmanlike": 0, "disqualified": False,
    }


def match(match_id, round_, home, away, home_players, away_players, home_periods, away_periods):
    return {
        "id": match_id,
        "round": round_,
        "date": f"2026-10-0{round_}T10:00:00.000Z",
        "home": {"team_id": home[0], "name": home[1], "score": sum(home_periods),
                 "periods": home_periods, "players": home_players},
        "away": {"team_id": away[0], "name": away[1], "score": sum(away_periods),
                 "periods": away_periods, "players": away_players},
    }


ROSTER = [
    {"teamId": "T1", "id": "P9", "name": "David", "lastName": "Iñiguez Garcia", "number": "9"},
    {"teamId": "T1", "id": "P54", "name": "Oscar", "lastName": "Lago Angel", "number": "54"},
    {"teamId": "T2", "id": "Q9", "name": "Otro", "lastName": "Rival", "number": "9"},
]


def test_attach_roster_pone_nombre_completo_e_id_segun_equipo_y_dorsal():
    team = {"team_id": "T1", "players": [line("9", name="IÑIGUEZ GARC"), line("54"), line("77", name="NUEVO, X.")]}
    attach_roster(team, ROSTER)
    players = {p["number"]: p for p in team["players"]}
    assert players["9"]["player_id"] == "P9"
    assert players["9"]["name"] == "David Iñiguez Garcia"
    assert (players["9"]["first_name"], players["9"]["last_name"]) == ("David", "Iñiguez Garcia")
    assert players["54"]["player_id"] == "P54"
    # Unknown numbers keep the scoresheet name and get a stable synthetic id
    assert players["77"]["player_id"] == "T1#77"
    assert players["77"]["name"] == "NUEVO, X."


def test_aggregate_players_acumula_partidos_titularidades_y_medias():
    other_starters = [dict(line(str(n), starter=True), player_id=f"S{n}") for n in range(4)]
    m1 = match("M1", 1, ("T1", "MIDNIGHT"), ("T2", "FIVI"),
               [dict(line("54", pts=8, fg2=2, ft=4, fouls=2, starter=True), player_id="P54", name="Oscar Lago Angel",
                     first_name="Oscar", last_name="Lago Angel"),
                *other_starters],
               [dict(line("9", pts=3, fg3=1), player_id="Q9", name="Otro Rival")],
               [6, 2], [3, 0])
    m2 = match("M2", 2, ("T3", "SJB"), ("T1", "MIDNIGHT"),
               [],
               [dict(line("54", pts=13, fg2=2, fg3=3, fouls=1), player_id="P54", name="Oscar Lago Angel"),
                dict(line("21", played=False), player_id="P21", name="Robert Davila")],
               [10, 10], [7, 6])

    players = {p["player_id"]: p for p in aggregate_players([m1, m2])}
    oscar = players["P54"]
    assert oscar["team_id"] == "T1"
    assert oscar["short_name"] == "O. Lago"
    assert oscar["team_name"] == "MIDNIGHT"
    assert (oscar["games"], oscar["starts"]) == (2, 1)
    assert (oscar["pts"], oscar["fg2"], oscar["fg3"], oscar["ft"], oscar["fouls"]) == (21, 4, 3, 4, 3)
    assert oscar["high"] == 13
    assert oscar["ppg"] == 10.5
    assert oscar["fg3pg"] == 1.5
    assert [g["match_id"] for g in oscar["log"]] == ["M1", "M2"]
    assert oscar["log"][1]["opponent"] == "SJB"
    assert oscar["log"][1]["home"] is False
    assert oscar["log"][0]["result"] == "W"
    assert oscar["log"][1]["result"] == "L"
    assert oscar["log"][1]["score"] == "13-20"

    # Listed but did not play: counts no game and gets no average
    assert players["P21"]["games"] == 0
    assert players["P21"]["ppg"] == 0


def test_no_cuenta_titularidades_si_el_acta_no_marca_exactamente_cinco_titulares():
    bad_sheet = [dict(line(str(n), starter=True), player_id=f"P{n}") for n in range(8)]
    good_sheet = [dict(line(str(n), starter=n < 5), player_id=f"P{n}") for n in range(8)]
    m1 = match("M1", 1, ("T1", "MIDNIGHT"), ("T2", "FIVI"), bad_sheet, [], [10], [5])
    m2 = match("M2", 2, ("T1", "MIDNIGHT"), ("T3", "SJB"), good_sheet, [], [10], [5])

    players = {p["player_id"]: p for p in aggregate_players([m1, m2])}
    assert players["P0"]["starts"] == 1
    assert players["P7"]["starts"] == 0
    assert players["P7"]["log"][0]["starter"] is None
    assert players["P0"]["log"][1]["starter"] is True


def test_add_roster_players_anade_inscritos_que_aun_no_han_jugado():
    played = [{"player_id": "P54", "team_id": "T1", "team_name": "MIDNIGHT", "number": "54",
               "name": "Oscar Lago Angel", "short_name": "O. Lago", "games": 1, "pts": 8}]
    players = add_roster_players(played, team_id="T1", team_name="MIDNIGHT", numbers=["54", "7", "10"], overrides={})

    by_number = {p["number"]: p for p in players if p["team_id"] == "T1"}
    assert sorted(by_number) == ["10", "54", "7"]
    assert by_number["54"]["pts"] == 8
    assert by_number["7"]["player_id"] == "T1#7"
    assert by_number["7"]["games"] == 0
    assert by_number["7"]["name"] == ""
    assert by_number["7"]["log"] == []


def test_add_roster_players_aplica_nombres_y_fotos_del_fichero_manual():
    played = [{"player_id": "P54", "team_id": "T1", "team_name": "MIDNIGHT", "number": "54",
               "name": "Oscar Lago Angel", "short_name": "O. Lago", "games": 1, "pts": 8}]
    overrides = [{"number": "54", "name": "Óscar Lago Ángel", "photo": "fotos/54.jpg"},
                 {"number": "7", "name": "Pepe Pérez Gil", "photo": "fotos/7.jpg"}]
    players = add_roster_players(played, team_id="T1", team_name="MIDNIGHT", numbers=["54", "7"], overrides=overrides)

    by_number = {p["number"]: p for p in players}
    # Matched by name (accents ignored); the official name wins and the photo is added
    assert by_number["54"]["name"] == "Oscar Lago Angel"
    assert by_number["54"]["photo"] == "fotos/54.jpg"
    assert by_number["7"]["name"] == "Pepe Pérez Gil"
    assert by_number["7"]["short_name"] == "P. Pérez"
    assert by_number["7"]["photo"] == "fotos/7.jpg"


def test_add_roster_players_admite_dos_jugadores_con_el_mismo_dorsal():
    played = [{"player_id": "P5", "team_id": "T1", "team_name": "MIDNIGHT", "number": "5",
               "name": "Iván Cardos García", "short_name": "I. Cardos", "games": 1, "pts": 8}]
    overrides = [{"number": "5", "name": "Iván Cardos García", "photo": "a.jpg"},
                 {"number": "5", "name": "Nahun Balladares Bohorquez", "photo": "b.jpg"}]
    players = add_roster_players(played, team_id="T1", team_name="MIDNIGHT", numbers=["5"], overrides=overrides)

    fives = sorted((p["name"], p["photo"], p["games"]) for p in players if p["number"] == "5")
    assert fives == [("Iván Cardos García", "a.jpg", 1), ("Nahun Balladares Bohorquez", "b.jpg", 0)]
    assert len({p["player_id"] for p in players}) == 2


def test_add_roster_players_en_temporadas_pasadas_solo_empareja_por_nombre():
    played = [{"player_id": "P73", "team_id": "T1", "team_name": "MIDNIGHT", "number": "73",
               "name": "Carles Aznar Martinez", "short_name": "C. Aznar", "games": 11, "pts": 125}]
    overrides = [{"number": "73", "name": "Carles Aznar Martinez", "photo": "c.jpg"},
                 {"number": "0", "name": "Mario San Pedro Navarro", "photo": "m.jpg"}]
    players = add_roster_players(played, team_id="T1", team_name="MIDNIGHT", numbers=["73", "0"],
                                 overrides=overrides, name_only=True)

    by_number = {p["number"]: p for p in players}
    assert by_number["73"]["photo"] == "c.jpg"
    # Dorsal 0 last season may have been someone else: keep it anonymous
    assert by_number["0"]["name"] == ""
    assert "photo" not in by_number["0"]
    assert len(players) == 2


def test_add_roster_players_no_toca_otros_equipos():
    other = [{"player_id": "Q9", "team_id": "T2", "team_name": "FIVI", "number": "9", "name": "X", "games": 1, "pts": 3}]
    players = add_roster_players(other, team_id="T1", team_name="MIDNIGHT", numbers=["9"], overrides={})
    assert [p["player_id"] for p in players] == ["Q9", "T1#9"]


def test_aggregate_teams_calcula_puntos_a_favor_en_contra_y_parciales():
    m1 = match("M1", 1, ("T1", "MIDNIGHT"), ("T2", "FIVI"),
               [dict(line("54", pts=8, fg2=2, ft=4, fouls=2), player_id="P54")],
               [dict(line("9", pts=3, fg3=1, fouls=1), player_id="Q9")],
               [6, 2], [3, 0])
    m2 = match("M2", 2, ("T3", "SJB"), ("T1", "MIDNIGHT"),
               [], [dict(line("54", pts=13, fg2=2, fg3=3, fouls=1), player_id="P54")],
               [10, 10], [7, 6])

    teams = {t["team_id"]: t for t in aggregate_teams([m1, m2])}
    midnight = teams["T1"]
    assert midnight["games"] == 2
    assert (midnight["wins"], midnight["losses"]) == (1, 1)
    assert (midnight["pts_for"], midnight["pts_against"]) == (21, 23)
    assert (midnight["fg2"], midnight["fg3"], midnight["ft"], midnight["fouls"]) == (4, 3, 4, 3)
    assert midnight["ppg"] == 10.5
    assert midnight["period_avg"] == [6.5, 4.0]
