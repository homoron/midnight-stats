from midnight_stats.build import select_groups
from midnight_stats.leverade import match_teams_by_name, participant_numbers, tournament_id_from_deeplink

COMPETITIONS = [
    {"id": "C1", "name": "LIGA QUIRONSALUD ALQUERIA MASCULINA", "groups": [
        {"id": "G1", "name": "DIVISION CUARTA"},
        {"id": "G2", "name": "DIVISION QUINTA"},
        {"id": "G3", "name": "COPA QUINTA"},
        {"id": "G4", "name": "PLAYOFF QUINTA"},
    ]},
    {"id": "C2", "name": "LIGA QUIRONSALUD ALQUERIA FEMENINA", "groups": [{"id": "G5", "name": "DIVISION QUINTA"}]},
    {"id": "C3", "name": "II MEMORIAL DEJAN MILOJEVIC", "groups": [{"id": "G6", "name": "GROUP A"}]},
]


def test_select_groups_solo_devuelve_la_quinta_masculina_liga_copa_y_playoff():
    selected = select_groups(COMPETITIONS, division="QUINTA")
    assert [(c["id"], g["id"]) for c, g in selected] == [("C1", "G2"), ("C1", "G3"), ("C1", "G4")]


def test_select_groups_con_ids_explicitos_ignora_la_division():
    selected = select_groups(COMPETITIONS, division="QUINTA", group_ids=["G1"])
    assert [g["id"] for _, g in selected] == ["G1"]


def test_select_groups_all_devuelve_todo():
    assert len(select_groups(COMPETITIONS, division=None)) == 6


def test_tournament_id_from_deeplink():
    url = ("https://nbn23.com/swish-deeplink/?projectKey=alqueriabasket&matchFid=145644520"
           "&competitionFid=1342549&routeName=Game")
    assert tournament_id_from_deeplink(url) == "1342549"
    assert tournament_id_from_deeplink("https://nbn23.com/swish-promo/") is None


def test_participant_numbers_lee_dorsales_de_la_respuesta_de_leverade():
    payload = {
        "data": {"type": "team", "id": "15925091"},
        "included": [
            {"type": "participant", "id": "1", "attributes": {"number": 54}},
            {"type": "participant", "id": "2", "attributes": {"number": "7"}},
            {"type": "participant", "id": "3", "attributes": {"number": None}},
            {"type": "club", "id": "9", "attributes": {}},
        ],
    }
    assert participant_numbers(payload) == ["54", "7"]


def test_match_teams_by_name_ignora_mayusculas_acentos_y_signos():
    nbn = [{"id": "N1", "name": "MIDNIGHT"}, {"id": "N2", "name": "CLIPPERS DE SAMBA `B´"}, {"id": "N3", "name": "FANTASMA"}]
    leverade = [
        {"type": "team", "id": "L1", "attributes": {"name": "Midnight"}},
        {"type": "team", "id": "L2", "attributes": {"name": "CLIPPERS DE SAMBA 'B'"}},
    ]
    assert match_teams_by_name(nbn, leverade) == {"N1": "L1", "N2": "L2"}
