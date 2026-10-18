// On-demand scoresheet reading and private, per-browser results.
const memory = new Map();
const requests = new Map();
let worker = null;
let sequence = 0;

export function publicScoresheetUrl(value) {
  const url = new URL(value);
  const [bucket, ...parts] = url.pathname.slice(1).split("/");
  if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com" || bucket !== "match-scorecard-pdf") {
    throw new Error("Unsupported scoresheet URL");
  }
  const object = decodeURIComponent(parts.join("/"));
  return `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
}

export function unpublishedRecords(base, records) {
  return Object.values(records || {}).filter((record) => record?.match?.id && record.match.home && record.match.away
    && !base?.matches?.[record.match.id]);
}

function resetWorker(error) {
  worker?.terminate();
  worker = null;
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  requests.clear();
}

function requestReader(action, payload, onProgress = () => {}) {
  if (!worker) {
    worker = new Worker(new URL("reader-worker.js?v=11", import.meta.url));
    worker.onerror = () => resetWorker(new Error("The scoresheet reader could not start"));
    worker.onmessage = ({ data }) => {
      const request = requests.get(data.id);
      if (!request) return;
      if (data.type === "progress") {
        request.onProgress(data.message, data.stage);
      } else if (data.type === "error") {
        resetWorker(new Error(data.message));
      } else {
        clearTimeout(request.timer);
        requests.delete(data.id);
        request.resolve(data.result);
      }
    };
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resetWorker(new Error("The scoresheet reader timed out")), 120000);
    requests.set(id, { resolve, reject, timer, onProgress });
    worker.postMessage({ id, action, payload });
  });
}

export async function readScoresheet(calendar, detail, roster, onProgress) {
  onProgress("Descargando acta…", "download");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let bytes;
  let uploadedAt = null;
  try {
    const response = await fetch(publicScoresheetUrl(detail.scoresheetUrl), {
      cache: "no-store", credentials: "omit", signal: controller.signal,
    });
    if (response.status === 404) {
      const error = new Error("The scoresheet PDF is not available yet");
      error.code = "not-published";
      throw error;
    }
    if (!response.ok) throw new Error(`Scoresheet download failed: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("The scoresheet is not a PDF");
    const modified = response.headers.get("Last-Modified");
    if (modified && !Number.isNaN(Date.parse(modified))) uploadedAt = new Date(modified).toISOString();
  } finally {
    clearTimeout(timer);
  }
  return requestReader("parse", { calendar, detail, roster, uploadedAt, bytes }, onProgress);
}

const cacheKey = (groupId) => `manual-scoresheets.v1.${groupId}`;
const readCache = (storage, groupId) => memory.get(groupId) || storage.get(cacheKey(groupId), null);
function writeCache(storage, groupId, value) {
  memory.set(groupId, value);
  storage.set(cacheKey(groupId), value);
}

export async function restoreManualStats(base, groupId, storage) {
  const saved = readCache(storage, groupId);
  const records = unpublishedRecords(base, saved?.records);
  if (!records.length) {
    if (saved) writeCache(storage, groupId, null);
    return base;
  }
  const serverGeneratedAt = base?.generated_at || null;
  if (saved.baseGeneratedAt === serverGeneratedAt && saved.snapshot) return saved.snapshot;
  try {
    const source = { ...(base || saved.snapshot), _server_generated_at: serverGeneratedAt };
    const checkedAt = records.map((record) => record.checkedAt).sort().pop();
    const merged = await requestReader("merge", { base: source, matches: records.map((record) => record.match), checkedAt });
    writeCache(storage, groupId, {
      baseGeneratedAt: serverGeneratedAt, snapshot: merged,
      records: Object.fromEntries(records.map((record) => [record.match.id, record])),
    });
    return merged;
  } catch (error) {
    console.warn("Locally read scoresheets could not be restored", error);
    return base;
  }
}

export async function incorporateManualMatch(base, groupId, match, storage, onProgress) {
  const checkedAt = new Date().toISOString();
  onProgress("Actualizando estadísticas…", "update");
  const merged = await requestReader("merge", { base, matches: [match], checkedAt }, onProgress);
  const saved = readCache(storage, groupId);
  const baseGeneratedAt = Object.prototype.hasOwnProperty.call(base, "_server_generated_at")
    ? base._server_generated_at : base.generated_at || null;
  const snapshot = { ...merged, _server_generated_at: baseGeneratedAt };
  writeCache(storage, groupId, {
    baseGeneratedAt, snapshot,
    records: { ...saved?.records, [match.id]: { match, checkedAt } },
  });
  return snapshot;
}
