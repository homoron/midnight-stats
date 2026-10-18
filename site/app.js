// Midnight Stats: unofficial app for the L'Alqueria del Basket senior league.
// Live data (calendar, standings, scores) comes straight from the public NBN23 API used by the
// official website; per-player stats come from the workflow or an on-demand scoresheet check.

import { restoreManualStats, readScoresheet, incorporateManualMatch } from "./manual-reader.js?v=11";

const API_BASE = "https://api.swish.nbn23.com";
// Public read-only key published by alqueriadelbasket.com in its NBN23 widget.
const API_KEY = "b76058c6-d42e-4672-b229-286d909e0444";
const TZ = "Europe/Madrid";
// The app only covers the men's 5th division: its league, cup and playoff groups.
const DEFAULTS = { competition: "MASCULINA", division: "QUINTA", group: "DIVISION QUINTA", team: "MIDNIGHT" };
const FINAL = new Set(["CLOSED", "FINISHED"]);
const LIVE_REFRESH_MS = 30000;
const PERIOD_NAMES = { 1: "1er cuarto", 2: "2º cuarto", 3: "3er cuarto", 4: "4º cuarto", 5: "Prórroga" };

const app = document.getElementById("app");
const tooltip = document.getElementById("tooltip");
const themeToggle = document.getElementById("theme-toggle");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

/* ======================================================================= utilities */

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const fmt1 = (n) => (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : "");
const titleCase = (text) => (text || "").toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`midnight-stats.${key}`);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`midnight-stats.${key}`, JSON.stringify(value));
    } catch {
      // Storage can be unavailable (private mode); settings then last for the session only.
    }
  },
};

/* --------------------------------------------------------------------- dates */

const dayFmt = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const longDayFmt = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

const hasDate = (m) => Boolean(m && m.date) && !m.date.startsWith("1970");
const dayKey = (date) => keyFmt.format(new Date(date));
const shortDay = (date) => capitalize(dayFmt.format(new Date(date)).replace(/\./g, ""));
const longDay = (date) => capitalize(longDayFmt.format(new Date(date)));
const clock = (date) => timeFmt.format(new Date(date));

function daysFromToday(date) {
  return Math.round((Date.parse(dayKey(date)) - Date.parse(dayKey(Date.now()))) / 86400000);
}

function relativeDay(date) {
  const days = daysFromToday(date);
  if (days === 0) return "Hoy";
  if (days === 1) return "Mañana";
  if (days === -1) return "Ayer";
  if (days > 1 && days < 7) return `En ${days} días`;
  return shortDay(date);
}

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "hace un momento";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `el ${shortDay(iso)}`;
}

/* --------------------------------------------------------------------- data access */

const memo = new Map();
const scoresheetChecks = new Map();
let currentContext = null;

function cached(key, ttl, loader) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.time < ttl) return hit.promise;
  const promise = loader().catch((error) => {
    memo.delete(key);
    throw error;
  });
  memo.set(key, { time: Date.now(), promise });
  return promise;
}

const api = (path, ttl = 25000) => cached(`api:${path}`, ttl, async () => {
  const response = await fetch(API_BASE + path, { headers: { Authorization: API_KEY } });
  if (response.status === 429) throw new Error("La API está recibiendo demasiadas peticiones; prueba en unos segundos.");
  if (!response.ok) throw new Error(`La API respondió con un error ${response.status}.`);
  return response.json();
});

const statsFor = (groupId) => cached(`stats:${groupId}`, 120000, async () => {
  let published = null;
  try {
    const response = await fetch(`data/groups/${groupId}.json`, { cache: "no-cache" });
    if (response.ok) published = await response.json();
  } catch {
    // A locally checked scoresheet can still be available when the published data is unreachable.
  }
  return restoreManualStats(published, groupId, storage);
});

async function getContext() {
  const settings = storage.get("settings", {});
  const seasons = await api("/seasons", 3600000);
  const now = Date.now();
  const season = seasons.find((s) => s._id === settings.seasonId)
    || seasons.find((s) => Date.parse(s.startDate) <= now && now <= Date.parse(s.endDate))
    || seasons[0];
  const competitions = await api(`/competitions?seasonId=${season._id}`, 3600000);
  const groups = competitions
    .filter((c) => c.name.toUpperCase().includes(DEFAULTS.competition))
    .flatMap((c) => c.groups.map((g) => ({ ...g, competition: c })))
    .filter((g) => g.name.toUpperCase().split(/\s+/).pop() === DEFAULTS.division);
  if (!groups.length) throw new Error(`La temporada ${season.name} no tiene ${titleCase(DEFAULTS.group)}.`);
  const group = groups.find((g) => g.id === settings.groupId)
    || groups.find((g) => g.name === DEFAULTS.group)
    || groups[0];

  const [calendar, standings, stats] = await Promise.all([
    api(`/calendar?groupId=${group.id}`),
    api(`/standings?groupId=${group.id}`).catch(() => []),
    statsFor(group.id),
  ]);

  const rounds = (calendar.rounds || []).map((round, i) => ({
    number: i + 1,
    name: round.name,
    matches: (round.matches || []).map((m) => ({ ...m, round: i + 1 })),
  }));
  const matches = rounds.flatMap((r) => r.matches);
  const teams = new Map();
  for (const m of matches) {
    for (const team of [m.homeTeam, m.awayTeam]) if (team) teams.set(team.id, team);
  }

  // The favourite is remembered by name too, so it carries over to other seasons and phases.
  const favoriteName = settings.favoriteTeamName === undefined ? DEFAULTS.team : settings.favoriteTeamName;
  let favoriteId = teams.has(settings.favoriteTeamId) ? settings.favoriteTeamId : null;
  if (!favoriteId && favoriteName) {
    favoriteId = [...teams.values()].find((t) => t.name === favoriteName)?.id || null;
  }

  return {
    settings, seasons, season, competitions, groups, group, rounds, matches, teams,
    standings: Array.isArray(standings) ? standings : [], stats, favoriteId,
  };
}

/* --------------------------------------------------------------------- match helpers */

const isBye = (m) => !m.homeTeam || !m.awayTeam;
const isLive = (m) => m.status === "LIVE";
const isFinal = (m) => FINAL.has(m.status);
const scoreOf = (m, teamId) => m.score?.totals?.find((t) => t.teamId === teamId)?.total;
const roundName = (round) => round.name || `Jornada ${round.number}`;

function winnerId(m) {
  if (!isFinal(m) || isBye(m)) return null;
  const home = scoreOf(m, m.homeTeam.id);
  const away = scoreOf(m, m.awayTeam.id);
  if (home === away) return null;
  return home > away ? m.homeTeam.id : m.awayTeam.id;
}

function sortByDate(list) {
  const time = (m) => (hasDate(m) ? Date.parse(m.date) : Number.MAX_SAFE_INTEGER);
  return [...list].sort((a, b) => time(a) - time(b) || a.round - b.round);
}

function teamMatches(ctx, teamId) {
  return sortByDate(ctx.matches.filter((m) => !isBye(m) && (m.homeTeam.id === teamId || m.awayTeam.id === teamId)));
}

function currentRound(ctx) {
  const since = Date.now() - 12 * 3600000;
  let best = null;
  for (const m of ctx.matches) {
    if (isBye(m) || isFinal(m)) continue;
    if (isLive(m)) return m.round;
    if (hasDate(m) && Date.parse(m.date) >= since && (!best || Date.parse(m.date) < Date.parse(best.date))) best = m;
  }
  if (best) return best.round;
  const played = ctx.matches.filter(isFinal);
  return played.length ? Math.max(...played.map((m) => m.round)) : 1;
}

function lastResults(ctx, teamId, count = 5) {
  return teamMatches(ctx, teamId).filter(isFinal).slice(-count).map((m) => ({ m, won: winnerId(m) === teamId }));
}

const standingOf = (ctx, teamId) => ctx.standings.find((s) => s.teamId === teamId);
const statsMatch = (ctx, id) => ctx.stats?.matches?.[id] || null;
const teamPlayers = (ctx, teamId) => (ctx.stats?.players || []).filter((p) => p.team_id === teamId);

function shortName(player) {
  if (player.first_name && player.last_name) return `${player.first_name[0]}. ${player.last_name.split(" ")[0]}`;
  if (player.short_name) return player.short_name;
  const name = player.name || "";
  if (name.includes(",")) {
    const [surname, initial] = name.split(",");
    return `${(initial.trim()[0] || "")}. ${titleCase(surname.trim().split(" ")[0])}`;
  }
  return name;
}

/* ======================================================================= components */

function initials(name) {
  return (name || "?").replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean)
    .slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function logo(team, size = 32) {
  const img = team?.logo ? `<img src="${esc(team.logo)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<span class="logo" style="--size:${size}px" data-initials="${esc(initials(team?.name))}">${img}</span>`;
}

function card(title, body, link) {
  const action = link ? `<a class="card-link" href="${link.href}">${esc(link.text)} ›</a>` : "";
  return `<section class="card"><div class="card-head"><h2 class="card-title">${esc(title)}</h2>${action}</div>${body}</section>`;
}

function resultChip(won) {
  return `<span class="result ${won ? "W" : "L"}" aria-label="${won ? "Victoria" : "Derrota"}">${won ? "V" : "D"}</span>`;
}

function streak(results) {
  if (!results.length) return "";
  return `<span class="streak" aria-label="Últimos resultados">${results.map(({ m, won }) => {
    const tip = `J${m.round}: ${m.homeTeam.name} ${scoreOf(m, m.homeTeam.id)}-${scoreOf(m, m.awayTeam.id)} ${m.awayTeam.name}`;
    return `<span class="result ${won ? "W" : "L"}" data-tip="${esc(tip)}">${won ? "V" : "D"}</span>`;
  }).join("")}</span>`;
}

function matchMeta(m, withRound = false) {
  const round = withRound ? `J${m.round} · ` : "";
  if (isLive(m)) return `<span class="badge live">EN JUEGO</span>`;
  if (m.status === "DEFERRED") return `<span class="badge">APLAZADO</span>`;
  if (isFinal(m)) return `<span class="badge">FINAL</span><br>${esc(round)}${hasDate(m) ? esc(shortDay(m.date)) : ""}`;
  if (!hasDate(m)) return `${esc(round)}<span class="muted">Fecha por confirmar</span>`;
  return `<b>${clock(m.date)}</b>${esc(round)}${esc(withRound ? shortDay(m.date) : relativeDay(m.date))}`;
}

function matchCard(ctx, m, withRound = false) {
  if (isBye(m)) {
    const team = m.homeTeam || m.awayTeam;
    return `<div class="bye">Descansa: <b>${esc(team?.name || "—")}</b></div>`;
  }
  const showScore = isFinal(m) || isLive(m);
  const winner = winnerId(m);
  const row = (team) => `
    <div class="mt-row ${winner === team.id ? "win" : ""}">
      ${logo(team, 24)}<span class="mt-name">${esc(team.name)}</span>
      <span class="mt-score">${showScore ? esc(scoreOf(m, team.id) ?? "") : ""}</span>
    </div>`;
  const favorite = ctx.favoriteId && (m.homeTeam.id === ctx.favoriteId || m.awayTeam.id === ctx.favoriteId);
  return `<a class="match ${favorite ? "is-favorite" : ""}" href="#/partido/${m.id}">
    <div class="match-meta">${matchMeta(m, withRound)}</div>
    <div class="match-teams">${row(m.homeTeam)}${row(m.awayTeam)}</div>
  </a>`;
}

function matchList(ctx, matches, { byDay = true, withRound = false } = {}) {
  const playable = sortByDate(matches.filter((m) => !isBye(m)));
  let html = "";
  let lastDay = null;
  for (const m of playable) {
    const key = hasDate(m) ? dayKey(m.date) : "tbd";
    if (byDay && key !== lastDay) {
      html += `<div class="day-head">${hasDate(m) ? esc(longDay(m.date)) : "Fecha por confirmar"}</div>`;
      lastDay = key;
    }
    html += matchCard(ctx, m, withRound);
  }
  html += matches.filter(isBye).map((m) => matchCard(ctx, m)).join("");
  return `<div class="match-list">${html || '<div class="empty">Sin partidos</div>'}</div>`;
}

function versusCard(ctx, m, title) {
  let center;
  if (isFinal(m) || isLive(m)) {
    const status = isLive(m) ? '<span class="badge live">EN JUEGO</span>' : esc(hasDate(m) ? shortDay(m.date) : "Final");
    center = `<div class="versus-score">${scoreOf(m, m.homeTeam.id) ?? 0}–${scoreOf(m, m.awayTeam.id) ?? 0}</div>
      <div class="small subtle">${status}</div>`;
  } else if (hasDate(m)) {
    center = `<div class="versus-time">${clock(m.date)}</div><div class="small subtle">${esc(relativeDay(m.date))}</div>`;
  } else {
    center = `<div class="small subtle">Fecha por<br>confirmar</div>`;
  }
  let chip = "";
  if (isFinal(m) && ctx.favoriteId && [m.homeTeam.id, m.awayTeam.id].includes(ctx.favoriteId)) {
    chip = resultChip(winnerId(m) === ctx.favoriteId);
  }
  return `<a class="card" href="#/partido/${m.id}">
    <div class="card-head"><h2 class="card-title">${esc(title)}</h2><span class="small subtle">${chip} J${m.round}</span></div>
    <div class="versus">
      <div class="versus-team">${logo(m.homeTeam, 48)}<span>${esc(m.homeTeam.name)}</span></div>
      <div class="versus-center">${center}</div>
      <div class="versus-team">${logo(m.awayTeam, 48)}<span>${esc(m.awayTeam.name)}</span></div>
    </div>
  </a>`;
}

function teamHero(ctx, team, href) {
  const st = standingOf(ctx, team.id);
  const stats = st ? `
    <div class="hero-stat"><b>${st.position}º</b><span>Posición</span></div>
    <div class="hero-stat"><b>${st.stats.wonMatches}-${st.stats.lostMatches}</b><span>V-D</span></div>
    <div class="hero-stat"><b>${fmt1(st.stats.pointsPerGame)}</b><span>Pts/partido</span></div>` : "";
  const tag = href ? "a" : "div";
  return `<${tag} class="card hero" ${href ? `href="${href}"` : ""}>
    ${logo(team, 60)}
    <div>
      <h1 class="hero-title">${esc(team.name)}</h1>
      <div class="hero-sub">${esc(titleCase(ctx.group.name))} · ${esc(ctx.season.name)}</div>
      <div class="hero-stats">${stats}</div>
    </div>
  </${tag}>`;
}

function tabs(items, active) {
  return `<nav class="tabs" aria-label="Secciones">${items.map(([key, label, href]) => (
    `<a href="${href}" ${key === active ? 'aria-current="page"' : ""}>${esc(label)}</a>`
  )).join("")}</nav>`;
}

function tiles(items) {
  return `<div class="tiles">${items.map(([label, value, sub]) => `
    <div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>
    ${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ""}</div>`).join("")}</div>`;
}

function chart(spec) {
  return `<div class="chart" data-chart="${esc(JSON.stringify(spec))}" role="img" aria-label="${esc(spec.label || "Gráfico")}"></div>`;
}

function legend(items) {
  return `<div class="legend">${items.map(([name, color]) => `<span><i style="background:${color}"></i>${esc(name)}</span>`).join("")}</div>`;
}

function noStats(ctx) {
  return `<div class="notice">Todavía no hay estadísticas de jugadores para este grupo. Se incorporan a partir de
    las actas oficiales. También puedes abrir un partido terminado y pulsar «Comprobar acta».</div>`;
}

function footer(ctx) {
  const updated = ctx.stats?.generated_at ? ` · Estadísticas de jugadores: actas procesadas ${timeAgo(ctx.stats.generated_at)}` : "";
  return `<p class="footer-note">App no oficial · Calendario, marcadores y clasificación en directo${esc(updated)} · <a href="#/ajustes">Ajustes</a></p>`;
}

function playerInitials(player) {
  if (!player.name) return `#${player.number}`;
  const parts = player.first_name && player.last_name ? [player.first_name, player.last_name] : player.name.split(/\s+/);
  return parts.slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function avatar(player, size = 28) {
  const img = player.photo ? `<img src="${esc(player.photo)}" alt="" loading="lazy" onerror="this.remove()">` : "";
  return `<span class="logo avatar" style="--size:${size}px" data-initials="${esc(playerInitials(player))}">${img}</span>`;
}

const displayName = (player) => player.name || `Dorsal ${player.number}`;

/* ======================================================================= views */

async function viewHome(ctx) {
  const parts = [];
  const favorite = ctx.favoriteId ? ctx.teams.get(ctx.favoriteId) : null;

  if (favorite) {
    parts.push(teamHero(ctx, favorite, `#/equipo/${favorite.id}`));
    const list = teamMatches(ctx, favorite.id);
    const live = list.find(isLive);
    const next = list.find((m) => !isFinal(m) && !isLive(m) && m.status !== "DEFERRED"
      && (!hasDate(m) || Date.parse(m.date) > Date.now() - 3 * 3600000));
    const last = [...list].reverse().find(isFinal);
    if (live) parts.push(versusCard(ctx, live, "En juego"));
    const pair = [next && versusCard(ctx, next, "Próximo partido"), last && versusCard(ctx, last, "Último partido")];
    parts.push(`<div class="grid-2 stack">${pair.filter(Boolean).join("")}</div>`);

    const leaders = teamPlayers(ctx, favorite.id).filter((p) => p.games > 0)
      .sort((a, b) => b.ppg - a.ppg || b.pts - a.pts).slice(0, 5);
    if (leaders.length) {
      parts.push(card("Máximos anotadores", leaderRows(ctx, leaders, (p) => fmt1(p.ppg),
        (p) => `${p.pts} pts · ${plural(p.games, "partido", "partidos")}`), { href: `#/equipo/${favorite.id}`, text: "Plantilla" }));
    }
  } else {
    parts.push(`<section class="card card-pad"><h1 class="page-title">Elige tu equipo</h1>
      <p class="subtle">Marca tu equipo favorito para ver aquí su próximo partido, el último resultado y sus anotadores.</p>
      <a class="btn" href="#/ajustes">Elegir equipo</a></section>`);
  }

  const number = currentRound(ctx);
  const round = ctx.rounds[number - 1];
  if (round) parts.push(card(roundName(round), matchList(ctx, round.matches), { href: `#/calendario/${number}`, text: "Jornadas" }));
  return `<div class="stack">${parts.join("")}</div>${footer(ctx)}`;
}

async function viewCalendar(ctx, param) {
  const favorite = ctx.favoriteId ? ctx.teams.get(ctx.favoriteId) : null;
  const mine = param === "mi-equipo" && favorite;
  const number = clamp(Number(param) || currentRound(ctx), 1, Math.max(ctx.rounds.length, 1));
  const chips = [
    favorite ? `<a class="chip" href="#/calendario/mi-equipo" ${mine ? 'aria-current="true"' : ""}>${esc(favorite.name)}</a>` : "",
    ...ctx.rounds.map((r) => `<a class="chip" href="#/calendario/${r.number}" ${!mine && r.number === number ? 'aria-current="true"' : ""}>J${r.number}</a>`),
  ].join("");

  if (mine) {
    return `<div class="stack">
      <section class="card"><div class="pager"><span></span><div class="pager-title">Calendario de ${esc(favorite.name)}
        <small>${plural(teamMatches(ctx, favorite.id).length, "partido", "partidos")}</small></div><span></span></div>
        <div class="chips">${chips}</div></section>
      <section class="card">${matchList(ctx, teamMatches(ctx, favorite.id), { byDay: false, withRound: true })}</section>
    </div>${footer(ctx)}`;
  }

  const round = ctx.rounds[number - 1];
  if (!round) return `<div class="card empty">Este grupo todavía no tiene calendario.</div>`;
  const dated = sortByDate(round.matches.filter(hasDate));
  const range = dated.length
    ? (dayKey(dated[0].date) === dayKey(dated[dated.length - 1].date) ? shortDay(dated[0].date)
      : `${shortDay(dated[0].date)} – ${shortDay(dated[dated.length - 1].date)}`)
    : "Fechas por confirmar";
  const arrow = (dir, target, disabled) => `<a class="icon-btn" href="#/calendario/${target}" aria-label="${dir < 0 ? "Jornada anterior" : "Jornada siguiente"}"
      ${disabled ? 'aria-disabled="true" tabindex="-1"' : ""}><svg viewBox="0 0 24 24"><path d="${dir < 0 ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}"/></svg></a>`;

  return `<div class="stack">
    <section class="card">
      <div class="pager">${arrow(-1, number - 1, number <= 1)}
        <div class="pager-title">${esc(roundName(round))}<small>${esc(range)}</small></div>
        ${arrow(1, number + 1, number >= ctx.rounds.length)}</div>
      <div class="chips">${chips}</div>
    </section>
    <section class="card">${matchList(ctx, round.matches)}</section>
  </div>${footer(ctx)}`;
}

async function viewStandings(ctx) {
  if (!ctx.standings.length) {
    return `<div class="card empty">Este grupo no tiene clasificación (es una eliminatoria o aún no ha empezado).</div>`;
  }
  const rows = [...ctx.standings].sort((a, b) => a.position - b.position).map((s) => {
    const played = s.stats.playedMatches || 0;
    const ppg = s.stats.pointsPerGame || 0;
    const oppg = s.stats.opponentsPointsPerGame || 0;
    const winPct = played ? Math.round((s.stats.wonMatches / played) * 100) : 0;
    const diff = Math.round((ppg - oppg) * played);
    const team = ctx.teams.get(s.teamId) || { name: s.name, logo: s.logo };
    return `<tr class="link ${s.teamId === ctx.favoriteId ? "is-favorite" : ""}" data-href="#/equipo/${s.teamId}">
      <td class="t-left sticky"><a class="team-cell" href="#/equipo/${s.teamId}"><b class="pos">${s.position}</b>${logo(team, 24)}<span>${esc(s.name)}</span></a></td>
      <td>${played}</td><td class="t-strong t-wins">${s.stats.wonMatches}</td><td class="t-losses">${s.stats.lostMatches}</td>
      <td>${played ? `${winPct}%` : "–"}</td><td>${played ? fmt1(ppg) : "–"}</td><td>${played ? fmt1(oppg) : "–"}</td>
      <td>${diff > 0 ? "+" : ""}${diff}</td>
      <td class="t-left">${streak(lastResults(ctx, s.teamId))}</td>
    </tr>`;
  }).join("");
  return `<div class="stack">
    <div><h1 class="page-title">Clasificación</h1><div class="subtle small">${esc(titleCase(ctx.group.name))} · ${esc(ctx.season.name)}</div></div>
    <section class="card"><div class="table-wrap"><table>
      <thead><tr><th class="t-left sticky">Equipo</th><th>PJ</th><th class="t-wins">V</th><th class="t-losses">D</th><th>%PG</th><th>PPP</th><th>PCPP</th><th>+/-</th><th class="t-left">Racha</th></tr></thead>
      <tbody>${rows}</tbody></table></div></section>
    <p class="small muted">PJ partidos jugados · V victorias · D derrotas · %PG porcentaje de partidos ganados · PPP puntos por partido · PCPP puntos en contra por partido · +/- diferencia total.</p>
  </div>${footer(ctx)}`;
}

const LEADER_CATEGORIES = [
  { key: "ppg", label: "Puntos por partido", value: (p) => p.ppg, show: (p) => fmt1(p.ppg), sub: (p) => `${p.pts} pts · ${p.games} PJ` },
  { key: "pts", label: "Puntos", value: (p) => p.pts, show: (p) => p.pts, sub: (p) => `${fmt1(p.ppg)} por partido` },
  { key: "fg3", label: "Triples", value: (p) => p.fg3, show: (p) => p.fg3, sub: (p) => `${fmt1(p.fg3pg)} por partido` },
  { key: "ft", label: "Tiros libres", value: (p) => p.ft, show: (p) => p.ft, sub: (p) => `${fmt1(p.ftpg)} por partido` },
  { key: "fg2", label: "Canastas de 2", value: (p) => p.fg2, show: (p) => p.fg2, sub: (p) => `${fmt1(p.fg2pg)} por partido` },
  { key: "high", label: "Récord en un partido", value: (p) => p.high, show: (p) => p.high, sub: (p) => `${p.games} PJ` },
  { key: "fouls", label: "Faltas", value: (p) => p.fouls, show: (p) => p.fouls, sub: (p) => `${fmt1(p.fpg)} por partido` },
];

function leaderRows(ctx, players, show, sub, { ranked = false, value = null } = {}) {
  let rank = 0;
  let previous = null;
  return players.map((p, i) => {
    const current = value ? value(p) : null;
    if (current !== previous) rank = i + 1;
    previous = current;
    const team = ctx.teams.get(p.team_id) || { name: p.team_name };
    return `<a class="leader ${ranked && rank <= 3 ? "top" : ""} ${ranked && p.team_id === ctx.favoriteId ? "is-favorite" : ""}" href="#/jugador/${encodeURIComponent(p.player_id)}">
      <span class="leader-rank">${ranked ? rank : `#${esc(p.number)}`}</span>
      <span class="leader-who">${avatar(p, 32)}<span><div class="leader-name">${esc(displayName(p))}</div>
        <div class="leader-team">${ranked ? `${esc(team.name)} · #${esc(p.number)}` : ""}</div></span></span>
      <span class="leader-value">${show(p)}<small>${esc(sub(p))}</small></span>
    </a>`;
  }).join("");
}

async function viewLeaders(ctx, key = "ppg") {
  const category = LEADER_CATEGORIES.find((c) => c.key === key) || LEADER_CATEGORIES[0];
  const chips = LEADER_CATEGORIES.map((c) => `<a class="chip" href="#/lideres/${c.key}" ${c.key === category.key ? 'aria-current="true"' : ""}>${esc(c.label)}</a>`).join("");
  let body;
  if (!ctx.stats) {
    body = `<div class="card-pad">${noStats(ctx)}</div>`;
  } else {
    const players = ctx.stats.players.filter((p) => p.games > 0 && category.value(p) > 0)
      .sort((a, b) => category.value(b) - category.value(a) || b.pts - a.pts || a.games - b.games).slice(0, 25);
    body = players.length
      ? leaderRows(ctx, players, category.show, category.sub, { ranked: true, value: category.value })
      : '<div class="empty">Aún no hay datos</div>';
  }
  return `<div class="stack">
    <div><h1 class="page-title">Líderes</h1><div class="subtle small">${esc(titleCase(ctx.group.name))} · ${esc(ctx.season.name)}</div></div>
    <div class="chips" style="padding:0">${chips}</div>
    <section class="card">${body}</section>
    <p class="small muted">Datos de las actas oficiales: solo canastas anotadas (el acta no registra fallos, rebotes ni asistencias).</p>
  </div>${footer(ctx)}`;
}

/* --------------------------------------------------------------------- match */

function quarterTable(m, detail) {
  const partials = detail.score?.partials || [];
  const periods = [...new Set(partials.map((p) => p.period))].sort((a, b) => a - b);
  if (!periods.length) return "";
  const cell = (teamId, period) => partials.find((p) => p.teamId === teamId && p.period === period)?.partial ?? "–";
  const label = (p) => (p <= 4 ? p : p === 5 ? "PR" : `PR${p - 4}`);
  const row = (team) => `<tr><td class="t-left"><span class="team-cell">${logo(team, 20)}<span>${esc(team.name)}</span></span></td>
    ${periods.map((p) => `<td>${cell(team.id, p)}</td>`).join("")}<td class="t-strong">${scoreOf(detail, team.id) ?? "–"}</td></tr>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th class="t-left">Parciales</th>${periods.map((p) => `<th>${label(p)}</th>`).join("")}<th>T</th></tr></thead>
    <tbody>${row(m.homeTeam)}${row(m.awayTeam)}</tbody></table></div>`;
}

function boxscore(team) {
  const players = team.players || [];
  const starters = players.filter((p) => p.starter);
  const known = starters.length === 5;
  const order = (list) => [...list].sort((a, b) => (b.played - a.played) || b.pts - a.pts || Number(a.number) - Number(b.number));
  const row = (p) => {
    const flags = [
      p.captain ? '<span class="flag cap" title="Capitán">C</span>' : "",
      p.disqualified ? '<span class="flag" title="Descalificado">DESC</span>' : (p.foul_count >= 5 ? '<span class="flag" title="Eliminado por faltas">5F</span>' : ""),
    ].join("");
    const href = `#/jugador/${encodeURIComponent(p.player_id)}`;
    return `<tr class="link ${p.played ? "" : "dnp"}" data-href="${href}">
      <td class="t-left"><span class="player-cell"><span class="dorsal">${esc(p.number)}</span><a href="${href}">${esc(shortName(p))}</a>${flags}</span></td>
      <td class="t-strong">${p.played ? p.pts : "NJ"}</td><td>${p.fg2}</td><td>${p.fg3}</td><td>${p.ft}</td><td>${p.foul_count}</td>
    </tr>`;
  };
  const section = (label) => `<tr class="section"><td colspan="6">${label}</td></tr>`;
  const body = known
    ? section("Quinteto inicial") + order(starters).map(row).join("") + section("Banquillo") + order(players.filter((p) => !p.starter)).map(row).join("")
    : order(players).map(row).join("");
  const sum = (key) => players.reduce((total, p) => total + (key === "fouls" ? p.foul_count : p[key] || 0), 0);
  return `<div class="table-wrap"><table>
    <thead><tr><th class="t-left">Jugador</th><th>PTS</th><th>T2</th><th>T3</th><th>TL</th><th>F</th></tr></thead>
    <tbody>${body}<tr class="total"><td class="t-left">Total</td><td>${sum("pts")}</td><td>${sum("fg2")}</td><td>${sum("fg3")}</td><td>${sum("ft")}</td><td>${sum("fouls")}</td></tr></tbody>
  </table></div>`;
}

function compareRows(rows) {
  return rows.map(({ label, home, away, fmt = (v) => v }) => {
    const max = Math.max(home, away) || 1;
    return `<div class="cmp">
      <div class="cmp-vals"><b>${fmt(home)}</b><span>${esc(label)}</span><b>${fmt(away)}</b></div>
      <div class="cmp-bars"><div class="cmp-bar home"><i style="width:${(home / max) * 100}%"></i></div>
      <div class="cmp-bar away"><i style="width:${(away / max) * 100}%"></i></div></div>
    </div>`;
  }).join("");
}

function scoringTab(sm) {
  const periods = [...new Set(sm.scoring.map((e) => e.period))].sort((a, b) => a - b);
  const names = {};
  for (const side of ["home", "away"]) {
    for (const p of sm[side].players) names[`${side}:${p.number}`] = shortName(p);
  }
  const column = (side, period) => {
    const events = sm.scoring.filter((e) => e.team === side && e.period === period);
    if (!events.length) return '<div class="pbp-item muted">—</div>';
    return events.map((e) => `<div class="pbp-item"><span class="pbp-pts ${e.points === 3 ? "p3" : ""}">+${e.points}</span>
      <span class="pbp-name">#${esc(e.number)} ${esc(names[`${side}:${e.number}`] || "")}</span><span class="pbp-score">${e.score}</span></div>`).join("");
  };
  const sections = periods.map((period) => {
    const pts = (side) => sm.scoring.filter((e) => e.team === side && e.period === period).reduce((t, e) => t + e.points, 0);
    return `<div class="period-head"><span>${PERIOD_NAMES[period] || `Periodo ${period}`}</span><span class="num">${pts("home")} – ${pts("away")}</span></div>
      <div class="pbp"><div class="pbp-col">${column("home", period)}</div><div class="pbp-col">${column("away", period)}</div></div>`;
  }).join("");
  return `<section class="card">
    <div class="pbp" style="padding:10px 0 4px"><div class="pbp-col t-center t-strong small">${esc(sm.home.name)}</div><div class="pbp-col t-center t-strong small">${esc(sm.away.name)}</div></div>
    ${sections}
  </section>
  <p class="small muted">Canastas en el orden en que las anotó cada equipo según el acta (+1 tiro libre, +2, +3 triple) y el marcador del equipo tras cada una. El acta no recoge el minuto ni el orden entre equipos.</p>`;
}

function chartsTab(m, detail, sm) {
  const partials = detail.score?.partials || [];
  const periods = [...new Set(partials.map((p) => p.period))].sort((a, b) => a - b);
  const value = (teamId, period) => partials.find((p) => p.teamId === teamId && p.period === period)?.partial ?? 0;
  const label = (p) => (p <= 4 ? `C${p}` : "PR");
  const home = periods.map((p) => value(m.homeTeam.id, p));
  const away = periods.map((p) => value(m.awayTeam.id, p));
  const cumulative = (list) => list.reduce((acc, v) => [...acc, acc[acc.length - 1] + v], [0]);
  const sumOf = (side, key) => (sm ? sm[side].players.reduce((t, p) => t + (key === "fouls" ? p.foul_count : p[key] || 0), 0) : 0);
  const keyLegend = legend([[m.homeTeam.name, "var(--series-1)"], [m.awayTeam.name, "var(--series-2)"]]);

  const quarterTips = periods.map((p, i) => `${PERIOD_NAMES[p] || label(p)}\n${m.homeTeam.name}: ${home[i]}\n${m.awayTeam.name}: ${away[i]}`);
  const runningHome = cumulative(home);
  const runningAway = cumulative(away);
  const runningTips = ["Inicio", ...periods.map((p) => `Final ${PERIOD_NAMES[p] || label(p)}`)]
    .map((name, i) => `${name}\n${m.homeTeam.name}: ${runningHome[i]}\n${m.awayTeam.name}: ${runningAway[i]}`);

  const comparison = sm ? card("Comparativa", `${keyLegend}<div style="padding:6px 0 10px">${compareRows([
    { label: "Canastas de 2", home: sumOf("home", "fg2"), away: sumOf("away", "fg2") },
    { label: "Triples", home: sumOf("home", "fg3"), away: sumOf("away", "fg3") },
    { label: "Tiros libres", home: sumOf("home", "ft"), away: sumOf("away", "ft") },
    { label: "Faltas personales", home: sumOf("home", "fouls"), away: sumOf("away", "fouls") },
    { label: "Mejor cuarto", home: Math.max(0, ...home), away: Math.max(0, ...away) },
  ])}</div>`) : "";

  return `<div class="stack">
    ${card("Puntos por cuarto", keyLegend + chart({
      type: "bars", label: "Puntos por cuarto de cada equipo", categories: periods.map(label),
      series: [{ name: m.homeTeam.name, color: "var(--series-1)", values: home }, { name: m.awayTeam.name, color: "var(--series-2)", values: away }],
      tips: quarterTips,
    }))}
    ${card("Marcador al final de cada cuarto", keyLegend + chart({
      type: "lines", label: "Evolución del marcador por cuartos", categories: ["0", ...periods.map(label)],
      series: [{ name: m.homeTeam.name, color: "var(--series-1)", values: runningHome }, { name: m.awayTeam.name, color: "var(--series-2)", values: runningAway }],
      tips: runningTips,
    }))}
    ${comparison}
  </div>`;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function actaTab(detail, sm) {
  const url = sm?.scoresheet_url || detail.scoresheetUrl;
  const lines = [];
  if (sm?.end_time) lines.push(`<li>Final del partido según el acta: <b>${esc(sm.end_time)}</b></li>`);
  if (sm?.scoresheet_uploaded_at) {
    const uploaded = sm.scoresheet_uploaded_at;
    let delay = "";
    if (sm.end_time && hasDate(detail) && dayKey(uploaded) === dayKey(detail.date)) {
      const diff = minutesOf(clock(uploaded)) - minutesOf(sm.end_time);
      if (diff >= 0) delay = diff < 60 ? ` · ${plural(diff, "minuto", "minutos")} después del final` : ` · ${fmt1(diff / 60)} h después del final`;
    }
    lines.push(`<li>Acta publicada: <b>${esc(shortDay(uploaded))}, ${clock(uploaded)}</b>${delay}</li>`);
  }
  const warnings = sm?.warnings?.length
    ? `<div class="notice" style="margin-top:12px"><b>Avisos al leer el acta:</b><ul>${sm.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
  return `<section class="card card-pad">
    ${lines.length ? `<ul style="margin:0 0 14px;padding-left:18px">${lines.join("")}</ul>` : ""}
    ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Abrir acta oficial (PDF)</a>` : '<p class="subtle">El acta todavía no está disponible.</p>'}
    <p class="small subtle" style="margin-top:14px">Las estadísticas salen del «tanteo arrastrado» del acta: cada canasta anotada con el dorsal de quien la hace.
    Por eso hay puntos, tiros libres, canastas de 2 y triples anotados, faltas y quinteto inicial, pero no fallos, rebotes, asistencias ni minutos.</p>
    ${warnings}
  </section>`;
}

function previewTab(ctx, m) {
  const sides = [m.homeTeam, m.awayTeam];
  const st = sides.map((t) => standingOf(ctx, t.id));
  const rows = [];
  if (st[0] && st[1]) {
    rows.push(
      { label: "Victorias", home: st[0].stats.wonMatches, away: st[1].stats.wonMatches },
      { label: "Puntos por partido", home: st[0].stats.pointsPerGame || 0, away: st[1].stats.pointsPerGame || 0, fmt: fmt1 },
      { label: "Puntos recibidos", home: st[0].stats.opponentsPointsPerGame || 0, away: st[1].stats.opponentsPointsPerGame || 0, fmt: fmt1 },
    );
  }
  const teamStats = sides.map((t) => ctx.stats?.teams?.find((x) => x.team_id === t.id));
  if (teamStats[0] && teamStats[1]) {
    rows.push(
      { label: "Triples por partido", home: teamStats[0].fg3pg, away: teamStats[1].fg3pg, fmt: fmt1 },
      { label: "Tiros libres por partido", home: teamStats[0].ftpg, away: teamStats[1].ftpg, fmt: fmt1 },
    );
  }
  const keyLegend = legend([[m.homeTeam.name, "var(--series-1)"], [m.awayTeam.name, "var(--series-2)"]]);
  const forms = sides.map((t) => `<div class="cmp-vals" style="padding:6px 16px"><span>${esc(t.name)}</span>${streak(lastResults(ctx, t.id)) || '<span class="muted small">Sin partidos</span>'}</div>`).join("");
  const scorers = sides.map((t) => {
    const top = teamPlayers(ctx, t.id).filter((p) => p.games > 0).sort((a, b) => b.ppg - a.ppg).slice(0, 3);
    return card(`Anotadores · ${t.name}`, top.length ? leaderRows(ctx, top, (p) => fmt1(p.ppg), (p) => "pts/partido") : '<div class="empty">Sin datos todavía</div>');
  }).join("");
  const meetings = teamMatches(ctx, m.homeTeam.id).filter((x) => isFinal(x) && [x.homeTeam.id, x.awayTeam.id].includes(m.awayTeam.id));
  return `<div class="stack">
    ${rows.length ? card("Cara a cara", `${keyLegend}<div style="padding:6px 0 10px">${compareRows(rows)}</div>`) : ""}
    ${card("Últimos resultados", `<div style="padding-bottom:8px">${forms}</div>`)}
    ${meetings.length ? card("Precedentes esta temporada", matchList(ctx, meetings, { byDay: false, withRound: true })) : ""}
    <div class="grid-2 stack">${scorers}</div>
  </div>`;
}

const SCORESHEET_STAGES = ["download", "prepare", "read", "update"];

function scoresheetProgress(stage) {
  const index = SCORESHEET_STAGES.indexOf(stage);
  const label = index < 0 ? "Comprobando disponibilidad" : `Paso ${index + 1} de ${SCORESHEET_STAGES.length}`;
  return `<progress max="${SCORESHEET_STAGES.length}" ${index < 0 ? "" : `value="${index}"`}
    aria-label="Progreso de comprobación del acta" aria-valuetext="${label}"></progress><span class="small subtle">${label}</span>`;
}

function scoresheetCheckPanel(ctx, match) {
  if (!isFinal(match) || isBye(match) || statsMatch(ctx, match.id)
    || !ctx.matches.some((known) => known.id === match.id)) return "";
  const state = scoresheetChecks.get(match.id);
  return `<section class="card card-pad scoresheet-check" data-scoresheet-check="${esc(match.id)}">
    <button type="button" class="btn" data-action="check-scoresheet" data-match-id="${esc(match.id)}"
      data-group-id="${esc(ctx.group.id)}" ${state?.pending ? "disabled" : ""}>${state?.pending ? "Comprobando acta…" : "Comprobar acta"}</button>
    <div class="scoresheet-progress" ${state?.pending ? "" : "hidden"}>${state?.pending ? scoresheetProgress(state.stage) : ""}</div>
    <p class="small subtle" role="status" aria-live="polite">${esc(state?.message
      || "Busca el acta oficial y añade las estadísticas en este dispositivo. La primera comprobación puede tardar un poco más.")}</p>
  </section>`;
}

function updateScoresheetCheck(id, pending, message, stage) {
  const status = pending ? `${message} Esto puede tardar unos minutos.` : message;
  scoresheetChecks.set(id, { pending, message: status, stage });
  const panel = document.querySelector(`[data-scoresheet-check="${id}"]`);
  if (!panel) return;
  const button = panel.querySelector("button");
  button.disabled = pending;
  button.textContent = pending ? "Comprobando acta…" : "Comprobar acta";
  const progress = panel.querySelector(".scoresheet-progress");
  progress.hidden = !pending;
  progress.innerHTML = pending ? scoresheetProgress(stage) : "";
  panel.querySelector('[role="status"]').textContent = status;
}

async function checkScoresheet(id, groupId) {
  const ctx = currentContext;
  const known = ctx?.matches.find((match) => match.id === id);
  if (!known || isBye(known) || ctx.group.id !== groupId || scoresheetChecks.get(id)?.pending) return;
  const onProgress = (message, stage) => updateScoresheetCheck(id, true, message, stage);
  const notPublished = "El acta todavía no está publicada. Prueba dentro de unos minutos.";
  onProgress("Buscando acta…");
  try {
    memo.delete(`stats:${groupId}`);
    const published = await statsFor(groupId);
    if (published?.matches?.[id]) {
      scoresheetChecks.delete(id);
      if (currentContext?.group.id === groupId) await render({ keepScroll: true });
      return;
    }
    const detail = await api(`/match/${id}`, 0);
    const match = { ...known, ...detail, round: known.round };
    if (!isFinal(match)) {
      updateScoresheetCheck(id, false, "El partido todavía no ha finalizado.");
      return;
    }
    if (!detail.scoresheetUrl) {
      updateScoresheetCheck(id, false, notPublished);
      return;
    }
    const roster = await api(`/match/${id}/players`, 0);
    const parsed = await readScoresheet(match, detail, roster, onProgress);
    const base = published || ctx.stats || {
      group_id: groupId, group_name: ctx.group.name, generated_at: null,
      _server_generated_at: null, matches: {}, players: [], teams: [], rosters: {},
    };
    const merged = await incorporateManualMatch(base, groupId, parsed, storage, onProgress);
    memo.set(`stats:${groupId}`, { time: Date.now(), promise: Promise.resolve(merged) });
    scoresheetChecks.delete(id);
    if (currentContext?.group.id === groupId) await render({ keepScroll: true });
  } catch (error) {
    console.warn("The manual scoresheet check failed", error);
    updateScoresheetCheck(id, false, error.code === "not-published" ? notPublished
      : "No se ha podido comprobar el acta. Revisa la conexión y vuelve a intentarlo.");
  }
}

async function viewMatch(ctx, id, tab) {
  const known = ctx.matches.find((x) => x.id === id);
  const detail = await api(`/match/${id}`, known && isLive(known) ? 20000 : 60000);
  const m = { ...(known || {}), ...detail, round: known?.round ?? "–" };
  if (!m.homeTeam || !m.awayTeam) return `<div class="card empty">Partido no encontrado.</div>`;
  const sm = statsMatch(ctx, id);
  const played = isFinal(m) || isLive(m);

  const header = `<section class="card">
    <div class="card-head"><h2 class="card-title">${esc(titleCase(ctx.group.name))} · J${esc(m.round)}</h2>
      <span class="small subtle">${hasDate(m) ? `${esc(shortDay(m.date))} · ${clock(m.date)}` : "Fecha por confirmar"}</span></div>
    <div class="versus">
      <a class="versus-team" href="#/equipo/${m.homeTeam.id}">${logo(m.homeTeam, 56)}<span>${esc(m.homeTeam.name)}</span></a>
      <div class="versus-center">${played
        ? `<div class="versus-score">${scoreOf(m, m.homeTeam.id) ?? 0}–${scoreOf(m, m.awayTeam.id) ?? 0}</div>
           <div class="small">${isLive(m) ? '<span class="badge live">EN JUEGO</span>' : '<span class="badge">FINAL</span>'}</div>`
        : `<div class="versus-time">${hasDate(m) ? clock(m.date) : "—"}</div>
           <div class="small subtle">${m.status === "DEFERRED" ? "Aplazado" : hasDate(m) ? esc(relativeDay(m.date)) : "Por confirmar"}</div>`}
      </div>
      <a class="versus-team" href="#/equipo/${m.awayTeam.id}">${logo(m.awayTeam, 56)}<span>${esc(m.awayTeam.name)}</span></a>
    </div>
    ${played ? quarterTable(m, detail) : ""}
  </section>`;

  if (!played) return `<div class="stack">${header}${previewTab(ctx, m)}</div>${footer(ctx)}`;

  const active = ["estadisticas", "anotacion", "graficos", "acta"].includes(tab) ? tab : "estadisticas";
  const base = `#/partido/${id}`;
  let body;
  if (active === "acta") {
    body = actaTab(m, sm);
  } else if (active === "graficos") {
    body = chartsTab(m, detail, sm);
  } else if (!sm) {
    body = `<div class="notice">${isLive(m) ? "Las estadísticas de jugadores aparecerán cuando se cierre el acta, normalmente un par de minutos después del final."
      : "Las estadísticas de este partido aún no se han generado a partir del acta."}</div>`;
  } else if (active === "anotacion") {
    body = scoringTab(sm);
  } else {
    body = `<div class="grid-2 stack">${["home", "away"].map((side) => card(sm[side].name, boxscore(sm[side]))).join("")}</div>
      <p class="small muted">T2 canastas de 2 · T3 triples · TL tiros libres anotados · F faltas · NJ no jugó · C capitán · 5F eliminado por faltas.</p>`;
  }

  const administrative = sm && ["home", "away"].some((side) => sm[side].final_score != null
    && sm[side].score != null && sm[side].final_score !== sm[side].score);
  const adminNote = administrative
    ? `<div class="notice">Resultado administrativo. Según el acta, en la pista terminó ${sm.home.final_score}–${sm.away.final_score};
       las estadísticas de jugadores son las de ese partido.</div>` : "";

  return `<div class="stack">${header}${adminNote}
    ${tabs([["estadisticas", "Estadísticas", base], ["anotacion", "Anotación", `${base}/anotacion`], ["graficos", "Gráficos", `${base}/graficos`], ["acta", "Acta", `${base}/acta`]], active)}
    ${scoresheetCheckPanel(ctx, m)}${body}</div>${footer(ctx)}`;
}

/* --------------------------------------------------------------------- team */

function quarterAverages(ctx, teamId) {
  const games = Object.values(ctx.stats?.matches || {}).filter((m) => m.home.team_id === teamId || m.away.team_id === teamId);
  const own = [0, 0, 0, 0];
  const against = [0, 0, 0, 0];
  for (const m of games) {
    const [mine, theirs] = m.home.team_id === teamId ? [m.home, m.away] : [m.away, m.home];
    for (let i = 0; i < 4; i += 1) {
      own[i] += mine.periods?.[i] || 0;
      against[i] += theirs.periods?.[i] || 0;
    }
  }
  const avg = (list) => list.map((v) => (games.length ? Math.round((v / games.length) * 10) / 10 : 0));
  return { games: games.length, own: avg(own), against: avg(against) };
}

async function viewTeam(ctx, teamId, tab) {
  const team = ctx.teams.get(teamId);
  if (!team) return `<div class="card empty">Equipo no encontrado en este grupo.</div>`;
  const active = ["jugadores", "partidos", "estadisticas"].includes(tab) ? tab : "jugadores";
  const base = `#/equipo/${teamId}`;
  const isFavorite = teamId === ctx.favoriteId;
  const favButton = isFavorite ? "" : `<button class="btn secondary" data-action="favorite" data-team="${teamId}" data-name="${esc(team.name)}">★ Marcar como mi equipo</button>`;
  let body;

  if (active === "partidos") {
    const list = teamMatches(ctx, teamId);
    const played = list.filter(isFinal);
    const margins = played.map((m) => {
      const own = scoreOf(m, teamId) ?? 0;
      const rival = m.homeTeam.id === teamId ? m.awayTeam : m.homeTeam;
      return { m, rival, own, other: scoreOf(m, rival.id) ?? 0 };
    });
    const marginChart = margins.length ? card("Diferencia de puntos por partido", chart({
      type: "bars", diverging: true, label: "Diferencia de puntos en cada partido jugado",
      categories: margins.map(({ m }) => `J${m.round}`),
      series: [{ name: "Diferencia", values: margins.map(({ own, other }) => own - other) }],
      tips: margins.map(({ m, rival, own, other }) => `J${m.round} · ${m.homeTeam.id === teamId ? "vs" : "en"} ${rival.name}\n${own}-${other} (${own > other ? "victoria" : "derrota"} por ${Math.abs(own - other)})`),
    }) + legend([["Victoria", "var(--series-1)"], ["Derrota", "var(--negative)"]])) : "";
    body = `${marginChart}<section class="card">${matchList(ctx, list, { byDay: false, withRound: true })}</section>`;
  } else if (active === "estadisticas") {
    const ts = ctx.stats?.teams?.find((t) => t.team_id === teamId);
    const st = standingOf(ctx, teamId);
    if (!ts && !st) {
      body = noStats(ctx);
    } else {
      const q = quarterAverages(ctx, teamId);
      const tileItems = [
        ["Puntos por partido", fmt1(st?.stats.pointsPerGame ?? ts?.ppg), null],
        ["Puntos recibidos", fmt1(st?.stats.opponentsPointsPerGame ?? ts?.oppg), null],
      ];
      if (ts) {
        tileItems.push(
          ["Triples por partido", fmt1(ts.fg3pg), `${ts.fg3} en total`],
          ["Tiros libres por partido", fmt1(ts.ftpg), `${ts.ft} en total`],
          ["Faltas por partido", fmt1(ts.fpg), `${ts.fouls} en total`],
          ["Canastas de 2", ts.fg2, `${fmt1(ts.games ? ts.fg2 / ts.games : 0)} por partido`],
        );
      }
      body = card("Promedios", tiles(tileItems));
      if (q.games) {
        body += card("Puntos medios por cuarto", legend([["A favor", "var(--series-1)"], ["En contra", "var(--series-2)"]]) + chart({
          type: "bars", label: "Puntos medios anotados y recibidos por cuarto", categories: ["C1", "C2", "C3", "C4"],
          series: [{ name: "A favor", color: "var(--series-1)", values: q.own }, { name: "En contra", color: "var(--series-2)", values: q.against }],
          tips: q.own.map((v, i) => `${PERIOD_NAMES[i + 1]}\nA favor: ${fmt1(v)}\nEn contra: ${fmt1(q.against[i])}`),
        }));
      }
    }
  } else {
    const players = teamPlayers(ctx, teamId).sort((a, b) => (b.games > 0) - (a.games > 0) || b.ppg - a.ppg || b.pts - a.pts
      || Number(a.number) - Number(b.number));
    const title = ctx.stats?.rosters?.[teamId]?.length ? `Plantilla · ${plural(players.length, "jugador", "jugadores")}` : "Jugadores";
    const row = (p) => {
      const href = `#/jugador/${encodeURIComponent(p.player_id)}`;
      const stats = p.games
        ? `<td>${p.games}</td><td>${p.pts}</td><td class="t-strong">${fmt1(p.ppg)}</td><td>${p.fg2}</td><td>${p.fg3}</td><td>${p.ft}</td><td>${p.fouls}</td><td>${p.starts}</td><td>${p.high}</td>`
        : `<td colspan="9" class="t-left muted small">Sin partidos</td>`;
      return `<tr class="link ${p.games ? "" : "dnp"}" data-href="${href}">
        <td class="t-left sticky"><span class="player-cell"><span class="dorsal">${esc(p.number)}</span>${avatar(p, 26)}<a href="${href}">${esc(displayName(p))}</a></span></td>
        ${stats}
      </tr>`;
    };
    body = !ctx.stats ? noStats(ctx) : card(title, players.length ? `<div class="table-wrap"><table>
      <thead><tr><th class="t-left sticky">Jugador</th><th>PJ</th><th>PTS</th><th>Media</th><th>T2</th><th>T3</th><th>TL</th><th>F</th><th>Tit</th><th>Máx</th></tr></thead>
      <tbody>${players.map(row).join("")}</tbody></table></div>` : '<div class="empty">Sin partidos con acta todavía</div>');
  }

  return `<div class="stack">
    ${teamHero(ctx, team)}
    ${favButton ? `<div>${favButton}</div>` : ""}
    ${tabs([["jugadores", "Jugadores", base], ["partidos", "Partidos", `${base}/partidos`], ["estadisticas", "Estadísticas", `${base}/estadisticas`]], active)}
    ${body}
  </div>${footer(ctx)}`;
}

async function viewMyTeam(ctx) {
  if (ctx.favoriteId) return viewTeam(ctx, ctx.favoriteId);
  return `<section class="card card-pad"><h1 class="page-title">Sin equipo favorito</h1>
    <p class="subtle">Elige tu equipo en ajustes para tenerlo siempre a mano.</p><a class="btn" href="#/ajustes">Elegir equipo</a></section>`;
}

/* --------------------------------------------------------------------- player */

async function viewPlayer(ctx, playerId) {
  const p = ctx.stats?.players?.find((x) => x.player_id === playerId);
  if (!p) return `<div class="card empty">No hay estadísticas de este jugador en ${esc(titleCase(ctx.group.name))}.</div>`;
  const team = ctx.teams.get(p.team_id) || { id: p.team_id, name: p.team_name };
  const log = p.log || [];
  if (!p.games) {
    return `<div class="stack"><a class="card hero" href="#/equipo/${team.id}">${avatar(p, 60)}<div>
      <h1 class="hero-title">${esc(displayName(p))}</h1><div class="hero-sub">#${esc(p.number)} · ${esc(team.name)}</div></div></a>
      <div class="card empty">Inscrito en el equipo, pero todavía no ha jugado ningún partido con acta esta temporada.</div></div>${footer(ctx)}`;
  }

  const pointsChart = log.length ? card("Puntos por partido", chart({
    type: "bars", label: `Puntos de ${p.name} en cada partido`, labelMax: true,
    categories: log.map((g) => `J${g.round}`),
    series: [{ name: "Puntos", color: "var(--series-2)", values: log.map((g) => g.pts) }],
    tips: log.map((g) => `J${g.round} · ${g.home ? "vs" : "en"} ${g.opponent}\n${g.pts} pts (T2 ${g.fg2} · T3 ${g.fg3} · TL ${g.ft})`),
  })) : "";

  const rows = log.map((g) => `<tr class="link" data-href="#/partido/${g.match_id}">
    <td class="t-left">J${g.round}</td>
    <td class="t-left"><a href="#/partido/${g.match_id}">${g.home ? "vs" : "en"} ${esc(g.opponent)}</a></td>
    <td class="t-center">${resultChip(g.result === "W")} <span class="small subtle">${esc(g.score)}</span></td>
    <td class="t-strong">${g.pts}</td><td>${g.fg2}</td><td>${g.fg3}</td><td>${g.ft}</td><td>${g.fouls}</td>
  </tr>`).join("");

  return `<div class="stack">
    <a class="card hero" href="#/equipo/${team.id}">${avatar(p, 60)}<div>
      <h1 class="hero-title">${esc(p.name)}</h1><div class="hero-sub team-cell">${logo(team, 20)}<span>#${esc(p.number)} · ${esc(team.name)}</span></div>
      <div class="hero-stats"><div class="hero-stat"><b>${fmt1(p.ppg)}</b><span>Pts/partido</span></div>
      <div class="hero-stat"><b>${p.games}</b><span>Partidos</span></div><div class="hero-stat"><b>${p.high}</b><span>Máximo</span></div></div>
    </div></a>
    ${card("Temporada", tiles([
      ["Puntos", p.pts, `${fmt1(p.ppg)} por partido`],
      ["Canastas de 2", p.fg2, `${fmt1(p.fg2pg)} por partido`],
      ["Triples", p.fg3, `${fmt1(p.fg3pg)} por partido`],
      ["Tiros libres", p.ft, `${fmt1(p.ftpg)} por partido`],
      ["Faltas", p.fouls, `${fmt1(p.fpg)} por partido`],
      ["Titular", p.starts, `de ${plural(p.games, "partido", "partidos")}`],
    ]))}
    ${pointsChart}
    ${card("Partido a partido", `<div class="table-wrap"><table>
      <thead><tr><th class="t-left">J</th><th class="t-left">Rival</th><th class="t-center">Res.</th><th>PTS</th><th>T2</th><th>T3</th><th>TL</th><th>F</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="t-center muted">Sin partidos jugados</td></tr>'}</tbody></table></div>`)}
  </div>${footer(ctx)}`;
}

/* --------------------------------------------------------------------- settings */

async function viewSettings(ctx) {
  const theme = storage.get("theme", "light");
  const seasonOptions = ctx.seasons.map((s) => `<option value="${s._id}" ${s._id === ctx.season._id ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  const groupOptions = ctx.groups.map((g) => (
    `<option value="${g.id}" ${g.id === ctx.group.id ? "selected" : ""}>${esc(titleCase(g.name))}</option>`
  )).join("");
  const teamOptions = [...ctx.teams.values()].sort((a, b) => a.name.localeCompare(b.name, "es"))
    .map((t) => `<option value="${t.id}" ${t.id === ctx.favoriteId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const themeOptions = [["auto", "Automático"], ["light", "Claro"], ["dark", "Oscuro"]]
    .map(([value, label]) => `<option value="${value}" ${value === theme ? "selected" : ""}>${label}</option>`).join("");

  return `<div class="stack" id="settings">
    <h1 class="page-title">Ajustes</h1>
    <section class="card">
      <div class="field"><label for="set-season">Temporada</label><select id="set-season" data-setting="seasonId">${seasonOptions}</select></div>
      <div class="field"><label for="set-group">Fase de la Quinta</label><select id="set-group" data-setting="groupId">${groupOptions}</select></div>
      <div class="field"><label for="set-team">Mi equipo</label><select id="set-team" data-setting="favoriteTeamId"><option value="">— Ninguno —</option>${teamOptions}</select></div>
      <div class="field"><label for="set-theme">Tema</label><select id="set-theme" data-setting="theme">${themeOptions}</select></div>
      <div class="btn-row"><a class="btn" href="#/">Listo</a></div>
    </section>
    <section class="card card-pad small subtle">
      <p style="margin-top:0"><b>Midnight Stats</b> es una app no oficial. Calendario, horarios, marcadores y clasificación llegan en directo
      de la API pública de NBN23 que usa la web de L'Alqueria del Basket.</p>
      <p style="margin-bottom:0">Las estadísticas de jugadores se calculan a partir de las actas oficiales en PDF
      ${ctx.stats?.generated_at ? `(última actualización ${esc(timeAgo(ctx.stats.generated_at))})` : ""}.</p>
    </section>
  </div>`;
}

/* ======================================================================= charts */

function niceStep(range, target = 4) {
  const raw = range / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
}

function scaleY(values, innerH, top) {
  let max = Math.max(0, ...values);
  let min = Math.min(0, ...values);
  if (max === min) max = min + 1;
  const step = niceStep(max - min);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const y = (v) => top + ((max - v) / (max - min)) * innerH;
  const ticks = [];
  for (let t = min; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 10) / 10);
  return { y, ticks };
}

function roundedBar(x, base, width, top) {
  const r = Math.min(4, width / 2, Math.abs(base - top));
  if (top <= base) {
    return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${base}Z`;
  }
  return `M${x},${base}V${top - r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top - r}V${base}Z`;
}

function axes(width, pad, scale) {
  return scale.ticks.map((t) => `<line class="${t === 0 ? "baseline" : "grid"}" x1="${pad.left}" x2="${width - pad.right}" y1="${scale.y(t)}" y2="${scale.y(t)}"/>
    <text x="${pad.left - 6}" y="${scale.y(t) + 4}" text-anchor="end">${t}</text>`).join("");
}

function categoryLabels(categories, x, height, innerW) {
  const every = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(innerW / 30))));
  return categories.map((c, i) => (i % every === 0 ? `<text x="${x(i)}" y="${height - 6}" text-anchor="middle">${esc(c)}</text>` : "")).join("");
}

function barsSvg(spec, width) {
  const height = spec.height || 190;
  const pad = { top: 18, right: 8, bottom: 24, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const scale = scaleY(spec.series.flatMap((s) => s.values), innerH, pad.top);
  const band = innerW / spec.categories.length;
  const gap = 2;
  const count = spec.series.length;
  const barW = Math.max(3, Math.min(24, (band * 0.7 - gap * (count - 1)) / count));
  const groupW = barW * count + gap * (count - 1);
  const center = (i) => pad.left + band * i + band / 2;
  const maxValue = Math.max(...spec.series[0].values);

  let marks = "";
  spec.categories.forEach((_, i) => {
    marks += `<rect class="hit" x="${pad.left + band * i}" y="${pad.top}" width="${band}" height="${innerH}" data-tip="${esc(spec.tips?.[i] || "")}"/>`;
    spec.series.forEach((s, k) => {
      const v = s.values[i];
      if (v == null || v === 0) return;
      const x = center(i) - groupW / 2 + k * (barW + gap);
      const color = spec.diverging ? (v >= 0 ? "var(--series-1)" : "var(--negative)") : s.color;
      marks += `<path d="${roundedBar(x, scale.y(0), barW, scale.y(v))}" fill="${color}" pointer-events="none"/>`;
      if (spec.labelMax && v === maxValue) {
        marks += `<text class="value-label" x="${x + barW / 2}" y="${scale.y(v) - 5}" text-anchor="middle" pointer-events="none">${v}</text>`;
      }
    });
  });
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${axes(width, pad, scale)}${marks}${categoryLabels(spec.categories, center, height, innerW)}</svg>`;
}

function linesSvg(spec, width) {
  const height = spec.height || 200;
  const pad = { top: 16, right: 34, bottom: 24, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const scale = scaleY(spec.series.flatMap((s) => s.values), innerH, pad.top);
  const n = spec.categories.length;
  const x = (i) => pad.left + (n > 1 ? (innerW * i) / (n - 1) : innerW / 2);
  const step = n > 1 ? innerW / (n - 1) : innerW;

  let hits = "";
  spec.categories.forEach((_, i) => {
    hits += `<rect class="hit" x="${x(i) - step / 2}" y="${pad.top}" width="${step}" height="${innerH}" data-tip="${esc(spec.tips?.[i] || "")}"/>`;
  });
  const ends = spec.series.map((s) => scale.y(s.values[s.values.length - 1]));
  if (ends.length === 2 && Math.abs(ends[0] - ends[1]) < 14) {
    const [hi, lo] = ends[0] <= ends[1] ? [0, 1] : [1, 0];
    ends[hi] -= 7;
    ends[lo] += 7;
  }
  const lines = spec.series.map((s, k) => {
    const points = s.values.map((v, i) => `${x(i)},${scale.y(v)}`).join(" ");
    const dots = s.values.map((v, i) => `<circle cx="${x(i)}" cy="${scale.y(v)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2" pointer-events="none"/>`).join("");
    const last = s.values[s.values.length - 1];
    return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>${dots}
      <text class="value-label" x="${x(n - 1) + 9}" y="${ends[k] + 4}" pointer-events="none">${last}</text>`;
  }).join("");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${axes(width, pad, scale)}${hits}${lines}${categoryLabels(spec.categories, x, height, innerW)}</svg>`;
}

function drawCharts() {
  for (const el of document.querySelectorAll(".chart[data-chart]")) {
    const spec = JSON.parse(el.dataset.chart);
    const width = Math.max(260, el.clientWidth - 16);
    el.innerHTML = spec.type === "lines" ? linesSvg(spec, width) : barsSvg(spec, width);
  }
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 150);
});

/* --------------------------------------------------------------------- tooltip */

let tipPinned = false;

function placeTip(event) {
  const margin = 12;
  const rect = tooltip.getBoundingClientRect();
  let left = event.clientX + margin;
  let top = event.clientY - rect.height - margin;
  if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - margin;
  if (top < 8) top = event.clientY + margin;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${top}px`;
}

function showTip(target, event) {
  const text = target.getAttribute("data-tip");
  if (!text) return;
  tooltip.textContent = text;
  tooltip.hidden = false;
  placeTip(event);
}

document.addEventListener("pointerover", (event) => {
  if (event.pointerType === "touch") return;
  const target = event.target.closest?.("[data-tip]");
  if (target) showTip(target, event);
});
document.addEventListener("pointermove", (event) => {
  if (!tooltip.hidden && !tipPinned) placeTip(event);
});
document.addEventListener("pointerout", (event) => {
  if (tipPinned || !event.target.closest?.("[data-tip]")) return;
  if (!event.relatedTarget?.closest?.("[data-tip]")) tooltip.hidden = true;
});
document.addEventListener("pointerdown", (event) => {
  const target = event.target.closest?.("[data-tip]");
  if (event.pointerType === "touch" && target) {
    tipPinned = true;
    showTip(target, event);
  } else if (tipPinned) {
    tipPinned = false;
    tooltip.hidden = true;
  }
});

/* ======================================================================= router */

const routes = [
  { re: /^\/?$/, nav: "home", view: viewHome },
  { re: /^\/calendario(?:\/([\w-]+))?$/, nav: "calendar", view: viewCalendar },
  { re: /^\/clasificacion$/, nav: "standings", view: viewStandings },
  { re: /^\/lideres(?:\/(\w+))?$/, nav: "leaders", view: viewLeaders },
  { re: /^\/partido\/(\w+)(?:\/(\w+))?$/, nav: "calendar", view: viewMatch, live: true },
  { re: /^\/equipo\/(\w+)(?:\/(\w+))?$/, nav: "standings", view: viewTeam },
  { re: /^\/mi-equipo$/, nav: "team", view: viewMyTeam },
  { re: /^\/jugador\/([^/]+)$/, nav: "leaders", view: viewPlayer },
  { re: /^\/ajustes$/, nav: null, view: viewSettings },
];

let renderToken = 0;
let refreshTimer = null;

function applyTheme() {
  const theme = storage.get("theme", "light");
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;

  const isDark = theme === "dark" || (theme === "auto" && systemTheme.matches);
  const label = isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro";
  themeToggle.dataset.nextTheme = isDark ? "light" : "dark";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
  themeToggle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${isDark
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41m0-16.14-1.41 1.41M6.34 17.66l-1.41 1.41"/>'
    : '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>'}</svg>`;
  const themeSelect = document.querySelector('[data-setting="theme"]');
  if (themeSelect) themeSelect.value = theme;
}

function updateChrome(ctx, route, args) {
  let nav = route.nav;
  if (route.view === viewTeam && args[0] === ctx.favoriteId) nav = "team";
  for (const link of document.querySelectorAll(".tabbar a")) {
    if (link.dataset.nav === nav) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function render({ keepScroll = false } = {}) {
  const token = ++renderToken;
  clearTimeout(refreshTimer);
  tooltip.hidden = true;
  tipPinned = false;
  const path = location.hash.replace(/^#/, "") || "/";
  const route = routes.find((r) => r.re.test(path)) || routes[0];
  const args = (path.match(route.re) || []).slice(1).map((a) => (a ? decodeURIComponent(a) : a));
  if (!keepScroll) app.innerHTML = '<div class="stack"><div class="skeleton"></div><div class="skeleton"></div></div>';

  try {
    const ctx = await getContext();
    const html = await route.view(ctx, ...args);
    if (token !== renderToken) return;
    const scroll = window.scrollY;
    currentContext = ctx;
    app.innerHTML = html;
    window.scrollTo(0, keepScroll ? scroll : 0);
    updateChrome(ctx, route, args);
    drawCharts();
    document.querySelector('.chip[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
    const hasLive = ctx.matches.some(isLive);
    if (hasLive && (route.live || ["home", "calendar", "standings"].includes(route.nav))) {
      refreshTimer = setTimeout(() => render({ keepScroll: true }), LIVE_REFRESH_MS);
    }
  } catch (error) {
    if (token !== renderToken) return;
    app.innerHTML = `<section class="card card-pad"><h1 class="page-title">No se han podido cargar los datos</h1>
      <p class="subtle">${esc(error.message || error)}</p><button class="btn" data-action="retry">Reintentar</button></section>`;
  }
}

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "toggle-theme") {
    storage.set("theme", themeToggle.dataset.nextTheme);
    applyTheme();
    drawCharts();
  }
  if (action?.dataset.action === "retry") render();
  if (action?.dataset.action === "check-scoresheet") checkScoresheet(action.dataset.matchId, action.dataset.groupId);
  if (action?.dataset.action === "favorite") {
    storage.set("settings", { ...storage.get("settings", {}), favoriteTeamId: action.dataset.team, favoriteTeamName: action.dataset.name });
    render({ keepScroll: true });
  }
  const row = event.target.closest("tr[data-href]");
  if (row && !event.target.closest("a")) location.hash = row.dataset.href;
});

document.addEventListener("change", (event) => {
  const select = event.target.closest("[data-setting]");
  if (!select) return;
  const key = select.dataset.setting;
  if (key === "theme") {
    storage.set("theme", select.value);
    applyTheme();
    drawCharts();
    return;
  }
  const settings = storage.get("settings", {});
  if (key === "seasonId") Object.assign(settings, { seasonId: select.value, groupId: null, favoriteTeamId: null });
  if (key === "groupId") Object.assign(settings, { groupId: select.value, favoriteTeamId: null });
  if (key === "favoriteTeamId") {
    settings.favoriteTeamId = select.value || null;
    settings.favoriteTeamName = select.value ? select.selectedOptions[0].textContent : "";
  }
  storage.set("settings", settings);
  render({ keepScroll: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render({ keepScroll: true });
});

systemTheme.addEventListener("change", () => {
  if (storage.get("theme", "light") === "auto") {
    applyTheme();
    drawCharts();
  }
});

window.addEventListener("hashchange", () => render());
applyTheme();
render();
