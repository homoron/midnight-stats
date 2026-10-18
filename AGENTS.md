# Midnight Stats — contexto para agentes

App web para móvil, **no oficial**, de la **División Quinta masculina** (Liga, Copa Quinta y Playoff Quinta) de la
Liga Senior Quirónsalud de L'Alqueria del Basket (Valencia). El usuario juega en **MIDNIGHT** (Oscar Lago, #54).

Ya tiene: calendario por jornadas, horarios, marcadores en directo, clasificación (%PG, PPP, PCPP, racha), ficha de
partido (boxscore, secuencia de anotación, gráficos, acta), equipos con plantilla completa, jugadores, líderes y
temporadas anteriores. Ver `README.md`.

## Normas del proyecto

- La interfaz va en **español**. El código, los comentarios y los nombres de variables, **siempre en inglés**.
  Los textos de los tests (nombres de las funciones `test_...`) pueden ir en español.
- **TDD obligatorio** para cualquier funcionalidad nueva de Python: primero el test, comprobar que falla, implementar
  lo mínimo y refactorizar. Ahora mismo hay 51 tests en verde (`py -3.14 -m pytest`).
- Python: en esta máquina usar `py -3.14`, porque `python` es la 3.9 y el proyecto necesita 3.10 o superior.
  Node local: v14 (antiguo).
- `graphify-out/`, `cache/`, `site/data/`, `logs/` y `reports/` están en `.gitignore`. No subirlos.

## Arquitectura

```
site/                 SPA estática sin compilación (index.html, app.js, styles.css, manifest, icon.svg)
midnight_stats/api.py         Cliente de la API de NBN23 (con límite de velocidad y reintentos ante 429)
midnight_stats/leverade.py    Dorsales inscritos por equipo (API pública de Leverade/Clupik)
midnight_stats/scoresheet.py  Lector del acta PDF con pdfplumber, por coordenadas
midnight_stats/stats.py       Cruce con plantillas, acumulados por jugador y equipo, inscritos sin partidos
midnight_stats/build.py       Genera site/data/index.json y site/data/groups/<groupId>.json
midnight_stats/validate.py    Validación de consistencia de las actas (informe en Markdown)
plantillas.json       Nombres y fotos a mano (MIDNIGHT completo: 14 jugadores con foto)
.github/workflows/update.yml   Tests, generación de datos y despliegue en GitHub Pages
```

- **En directo desde el navegador:** la SPA llama a `https://api.swish.nbn23.com` para `/seasons`,
  `/competitions?seasonId`, `/calendar?groupId`, `/standings?groupId` y `/match/{id}`, con la cabecera
  `Authorization: <clave pública>`. La clave es la que publica alqueriadelbasket.com en su widget; está en
  `site/app.js` y en `midnight_stats/api.py`. La API admite CORS `*`.
- **Estadísticas de jugadores:** solo existen en el **PDF del acta** (`scoresheetUrl` de `/match/{id}`, en
  storage.googleapis.com). Ese almacenamiento **no admite CORS**, así que el navegador no puede leerlo y las
  estadísticas se generan con `python -m midnight_stats.build`, en el workflow. El acta se publica 1–2 min después del partido.
- **Cómo se lee el acta:** cada fila del tanteo arrastrado es un punto. El salto respecto al marcador anterior del
  equipo da el tipo de canasta: +1 tiro libre, +2 canasta de 2, +3 triple. Los números impresos van en negro y lo
  que escribe el anotador en color. Los titulares son la X rodeada con un círculo (una curva en el PDF). Las faltas
  son letras grandes con subíndices. El acta no tiene fallos, rebotes, asistencias ni minutos.

## Límites y peculiaridades

- **NBN23:** 100 peticiones por minuto (429 + `Retry-After`). El generador va a unas 80 por minuto.
  Estados de partido: `NOT_STARTED`, `LIVE`, `FINISHED`, `CLOSED`, `DEFERRED`. Las jornadas de descanso llegan
  como partidos `CLOSED` con un solo equipo. Las fechas `1970-01-01` significan "por confirmar".
- **Leverade:** 400 peticiones por minuto. El id del torneo está en el `competitionFid` de la redirección de
  `api.swish.nbn23.com/match/link?id=..&apiKey=..`. Los equipos se piden con
  `/teams?filter=registrable[tournament].id:<id>` y los dorsales con `/teams/<id>?include=participants`.
  Nombres y fotos requieren login.
- **Errores de los anotadores:** a veces marcan más de 5 titulares. En esos partidos la app no cuenta titularidades.
- **Resultados administrativos** (incomparecencias, sanciones): la API da el resultado oficial y el acta el de la
  pista. La app lo avisa.
- En MIDNIGHT, **Iván Cardos y Nahun Balladares tienen los dos el dorsal 5 inscrito.** `plantillas.json` empareja
  por nombre para separarlos.
- **Validación:** 198 actas de la Quinta 2025/26 y 9 de la 2026/27, con todos los puntos correctos. Se lanza con
  `py -3.14 -m midnight_stats.validate --season 2025/2026 --report reports/x.md`.

## Decisiones del usuario (respetarlas)

- **Solo División Quinta masculina.** Generar otras divisiones es trabajo que no quiere.
- **Sin acceso restringido:** la app se comparte con un enlace público en el grupo de WhatsApp y se abre sin
  sesión. La versión web es la elegida; el APK queda para más adelante.
- **Fotos solo de MIDNIGHT.** Se sacaron de la ficha del equipo en Clupik con la sesión del usuario, y el usuario
  confirma que todos quieren salir. No obtener fotos de otros equipos ni usar la API privada de la app Swish.

## Comandos

```bash
py -3.14 -m pip install -r requirements.txt
py -3.14 -m pytest
py -3.14 -m midnight_stats.build                       # Quinta, temporada actual
py -3.14 -m midnight_stats.build --season 2025/2026    # temporada pasada (las actas en cache/ no se vuelven a bajar)
py -3.14 -m http.server 8765 --directory site  # abrir http://localhost:8765
```

## Siguiente tarea: publicar en GitHub Pages

1. `git init`, primer commit y repositorio **público** en la cuenta de GitHub del usuario. Pedirle que inicie
   sesión él (`gh auth login`); nunca pedir tokens ni contraseñas en el chat.
2. En el repositorio: Settings → Pages → Source: **GitHub Actions**. Lanzar el workflow "Actualizar estadísticas"
   (workflow_dispatch) para el primer despliegue.
3. Lanzarlo otra vez con `season = 2025/2026` para cargar la temporada pasada (unos 6–8 min por el límite de la API).
   `site/data` no se sube al repositorio: entre ejecuciones se conserva con `actions/cache`.
4. Añadir **vista previa para WhatsApp** en `site/index.html`: `og:title`, `og:description`, `og:image` con URL
   absoluta de Pages y una imagen 1200×630 (por ejemplo `site/og.png`), además de `og:url`.
5. Comprobar en un móvil que la URL carga, que los marcadores llegan en directo y que aparecen las estadísticas.
6. Tener en cuenta que GitHub desactiva los workflows programados tras 60 días sin actividad en el repositorio.

Ideas pendientes (si el usuario las pide): mínimo de partidos para entrar en los líderes de medias; APK con
Capacitor leyendo las actas en el propio móvil (una app nativa no tiene CORS; habría que portar el parser a JS).
