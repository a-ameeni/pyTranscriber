import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

let recognizer = null;
let recognizerKey = null;

function notice(type, data = {}) {
  self.postMessage({ type, ...data });
}

async function loadModel(model, requestedDevice) {
  const canGpu = !!self.navigator?.gpu;
  const preferred = requestedDevice === "auto" ? (canGpu ? "webgpu" : "wasm") : requestedDevice;
  const attempts = requestedDevice === "auto" && preferred === "webgpu" ? ["webgpu", "wasm"] : [preferred];
  let lastError;
  for (const device of attempts) {
    const key = model + ":" + device;
    if (recognizer && recognizerKey === key) return { engine: recognizer, device };
    try {
      notice("stage", { stage: "دریافت و آماده‌سازی مدل (" + (device === "webgpu" ? "گرافیکی" : "پردازنده مرکزی") + ")" });
      const engine = await pipeline("automatic-speech-recognition", model, {
        device,
        dtype: device === "webgpu" ? "fp16" : "q8",
        progress_callback: (event) => {
          if (!event) return;
          const percent = typeof event.progress === "number" ? Math.max(0, Math.min(100, event.progress)) : null;
          notice("loading", { status: event.status || "", file: event.file || "", percent });
        },
      });
      recognizer = engine;
      recognizerKey = key;
      return { engine, device };
    } catch (e) {
      lastError = e;
      notice("stage", { stage: "خطا در روش " + device + (attempts.length > 1 ? "؛ تلاش با روش سازگارتر" : "") });
    }
  }
  throw lastError || new Error("بارگیری مدل انجام نشد.");
}

self.onmessage = async (event) => {
  const data = event.data;
  if (data?.type !== "run") return;
  try {
    if (!data.audio || data.audio.length === 0) throw new Error("فایل صوتی داده‌ای برای پردازش ندارد.");
    const { engine, device } = await loadModel(data.model, data.device);
    notice("stage", { stage: "در حال تشخیص گفتار (" + device + ")" });
    const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, task: "transcribe" };
    if (data.language && data.language !== "auto") opts.language = data.language;
    const output = await engine(data.audio, opts);
    notice("done", { output: { text: output?.text || "", chunks: output?.chunks || [] } });
  } catch (e) {
    notice("error", { message: e?.message || String(e) });
  }
};
