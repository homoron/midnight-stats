// The same Python parser runs in a worker so the interface stays responsive.
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js";
let runtimePromise = null;
let queue = Promise.resolve();

const progress = (id, message) => postMessage({ id, type: "progress", message });

async function getRuntime(id) {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      progress(id, "Preparando lector…");
      importScripts(PYODIDE_URL);
      const runtime = await loadPyodide();
      await runtime.loadPackage(["micropip", "cryptography"]);
      // Rendering libraries are not needed: pdfplumber imports them lazily.
      await runtime.runPythonAsync(`import micropip
await micropip.install(["pdfminer.six==20260107", "pdfplumber==0.11.10"], deps=False)
await micropip.install("charset-normalizer==3.4.7")`);
      const response = await fetch("reader.zip?v=10");
      if (!response.ok) throw new Error("The scoresheet reader sources are unavailable");
      runtime.unpackArchive(await response.arrayBuffer(), "zip", { extractDir: "/reader" });
      runtime.runPython(`import sys, json
sys.path.insert(0, "/reader")
from midnight_stats.browser import parse_match, merge_matches`);
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
      progress(id, "Leyendo acta…");
      runtime.globals.set("pdf_data", bytes);
      result = runtime.runPython(`request = json.loads(request_json)
result = parse_match(bytes(pdf_data.to_py()), request["calendar"], request["detail"], request["roster"], request.get("uploadedAt"))
json.dumps(result, ensure_ascii=False)`);
      runtime.globals.delete("pdf_data");
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
