// The same Python parser runs in a worker so the interface stays responsive.
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js";
let runtimePromise = null;
let queue = Promise.resolve();
const RUNTIME_TASKS = ["runtime-script", "runtime", "runtime-packages", "pdf-packages", "reader-sources"];
const READING_MESSAGES = {
  "pdf-text": "Texto del acta leído…",
  "pdf-header": "Cabecera y resultado leídos…",
  "pdf-home": "Jugadores del equipo local leídos…",
  "pdf-away": "Jugadores del equipo visitante leídos…",
  "pdf-scoring": "Anotación leída…",
  match: "Datos del partido preparados…",
  validated: "Puntos validados…",
};

const progress = (id, message, stage, completed = []) => postMessage({ id, type: "progress", message, stage, completed });

async function getRuntime(id) {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      progress(id, "Preparando lector…", "prepare");
      importScripts(PYODIDE_URL);
      progress(id, "Preparando lector…", "prepare", ["runtime-script"]);
      const runtime = await loadPyodide();
      progress(id, "Preparando lector…", "prepare", ["runtime"]);
      await runtime.loadPackage(["micropip", "cryptography"]);
      progress(id, "Preparando lector…", "prepare", ["runtime-packages"]);
      // Rendering libraries are not needed: pdfplumber imports them lazily.
      await runtime.runPythonAsync(`import micropip
await micropip.install(["pdfminer.six==20260107", "pdfplumber==0.11.10"], deps=False)
await micropip.install("charset-normalizer==3.4.7")`);
      progress(id, "Preparando lector…", "prepare", ["pdf-packages"]);
      const response = await fetch("reader.zip?v=13");
      if (!response.ok) throw new Error("The scoresheet reader sources are unavailable");
      runtime.unpackArchive(await response.arrayBuffer(), "zip", { extractDir: "/reader" });
      runtime.runPython(`import sys, json
sys.path.insert(0, "/reader")
from midnight_stats.browser import parse_match, merge_matches`);
      progress(id, "Lector preparado…", "prepare", ["reader-sources"]);
      return runtime;
    })();
  }
  return runtimePromise;
}

async function handle({ id, action, payload }) {
  try {
    const runtime = await getRuntime(id);
    const { bytes, ...parameters } = payload;
    runtime.globals.set("request_json", JSON.stringify(parameters));
    let result;
    if (action === "parse") {
      // A reused runtime has already finished all setup operations.
      progress(id, "Leyendo acta…", "read", RUNTIME_TASKS);
      runtime.globals.set("report_task", (task) => progress(id, READING_MESSAGES[task], "read", [task]));
      runtime.globals.set("pdf_data", bytes);
      result = runtime.runPython(`request = json.loads(request_json)
result = parse_match(bytes(pdf_data.to_py()), request["calendar"], request["detail"], request["roster"], request.get("uploadedAt"), on_progress=report_task)
json.dumps(result, ensure_ascii=False)`);
      runtime.globals.delete("pdf_data");
      runtime.globals.delete("report_task");
    } else if (action === "merge") {
      result = runtime.runPython(`request = json.loads(request_json)
result = merge_matches(request["base"], request["matches"], request.get("checkedAt"))
json.dumps(result, ensure_ascii=False)`);
    } else {
      throw new Error("Unknown scoresheet reader request");
    }
    runtime.runPython("del request, result");
    postMessage({ id, type: "result", result: JSON.parse(result) });
  } catch (error) {
    postMessage({ id, type: "error", message: String(error) });
  }
}

self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
