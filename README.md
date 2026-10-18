# Midnight Stats

App web (para móvil) **no oficial** de la **División Quinta masculina** (Liga, Copa y Playoff) de la Liga Senior
Quirónsalud de L'Alqueria del Basket. Incluye:
- calendario y horarios por jornada, con marcadores en directo;
- clasificación con %PG, PPP, PCPP y racha;
- ficha de cada partido con boxscore, secuencia de anotación, gráficos y acta;
- estadísticas por equipo y por jugador, con la plantilla completa de cada equipo, y líderes de la división;
- consulta de temporadas anteriores.

Abre la app sin registro en <https://homoron.github.io/midnight-stats/>.

## Cómo funciona

| Dato | Origen |
|---|---|
| Calendario, horarios, marcadores, parciales, clasificación | **En directo** desde la API pública de NBN23 (`api.swish.nbn23.com`), la misma que usa el widget de alqueriadelbasket.com. El navegador la consulta cada vez que abres la app (y cada 30 s si hay un partido en juego) |
| Estadísticas de jugadores | Se calculan a partir del **acta oficial en PDF** de cada partido (`python -m midnight_stats.build`). El navegador no puede descargar esos PDF (Google Storage no lo permite desde otras webs), así que se procesan aparte y se guardan en `site/data/` |
| Plantilla completa (dorsales inscritos) | API pública de **Leverade**, la plataforma de gestión de la liga |
| Nombres y fotos de jugadores sin partidos | A mano en `plantillas.json` (Leverade guarda nombres y fotos tras un login) |

Del acta se usa el "tanteo arrastrado": cada fila es un punto y el anotador escribe el dorsal de quien
anota junto al marcador que alcanza su canasta. El salto respecto al marcador anterior del equipo indica el tipo
de canasta: +1 tiro libre, +2 canasta de 2, +3 triple. También se leen las faltas (P, T, U, D y sus tiros
libres), el quinteto inicial (la X rodeada con un círculo), los capitanes, los tiempos muertos y los parciales.

El acta **no** registra fallos, rebotes, asistencias ni minutos, así que esos datos no existen.

Cada acta pasa por una validación automática:
- la suma de puntos de los jugadores debe coincidir con el marcador;
- los parciales deben sumar el resultado;
- no puede haber saltos imposibles en el tanteo;
- cada equipo debe tener 5 titulares.

## Uso en local (Windows)

```bash
py -3.14 -m pip install -r requirements.txt
py -3.14 -m pytest
py -3.14 -m midnight_stats.build
py -3.14 -m http.server 8765 --directory site
```

Después, abre <http://localhost:8765>.

Opciones de `midnight_stats.build` (por defecto genera solo la Quinta masculina: Liga, Copa y Playoff):

- `--season 2025/2026`: genera otra temporada (las actas ya procesadas se guardan en `cache/` y no se vuelven a descargar).
- `--division CUARTA`: otra división; `--group <id>`: grupos concretos; `--all`: todo.
- `--workers 4`: número de actas que se descargan en paralelo.

### Nombres y fotos a mano (`plantillas.json`)

Los jugadores que aún no han jugado salen como "Dorsal N" hasta su primera acta. Para ponerles nombre o
añadir fotos (con permiso de cada jugador; las imágenes van en `site/fotos/`):

```json
{
  "MIDNIGHT": {
    "10": { "name": "Nombre Apellido" },
    "54": { "photo": "fotos/midnight-54.jpg" }
  }
}
```

El nombre del acta siempre tiene prioridad sobre el escrito a mano.

Para validar todas las actas de una temporada:

```bash
py -3.14 -m midnight_stats.validate --season 2025/2026 --report reports/validacion-2025-2026.md
```

## Publicarla para el equipo (GitHub Pages, gratis)

1. Sube esta carpeta a un repositorio de GitHub.
2. En el repositorio, ve a **Settings → Pages → Build and deployment** y elige **GitHub Actions**.
3. El workflow `.github/workflows/update.yml` hace el resto:
   - actualiza las estadísticas cada 10 minutos los fines de semana y cada 3 horas entre semana;
   - publica la app en `https://<usuario>.github.io/<repo>/`.
4. Para cargar una temporada antigua, ve a **Actions → Actualizar estadísticas → Run workflow** e indica la temporada.

En el móvil, «Añadir a pantalla de inicio» la instala como una app.

GitHub desactiva los workflows programados de los repositorios públicos tras 60 días sin actividad.
Si ocurre, vuelve a activar «Actualizar estadísticas» en la pestaña Actions y ejecútalo manualmente.

## Límites de la API

La API permite **100 peticiones por minuto**. El generador va a un máximo de unas 80 por minuto y, si recibe un
`429`, espera lo que indica `Retry-After`. Las actas se descargan de Google Cloud Storage, que no tiene ese límite.
Normalmente se publican uno o dos minutos después del final del partido.

## Estructura

```
midnight_stats/
  api.py          Cliente de la API de NBN23 (con control de velocidad)
  leverade.py     Dorsales inscritos por equipo (API pública de Leverade)
  scoresheet.py   Lectura del acta PDF (pdfplumber, por coordenadas)
  stats.py        Cruce con plantillas y acumulados de temporada
  build.py        Genera site/data/*.json
  validate.py     Validación de consistencia de las actas
site/             App web estática (HTML + CSS + JS, sin compilación)
tests/            Tests (pytest) con un acta real como fixture
```
