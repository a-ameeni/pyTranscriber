const get = (id) => document.getElementById(id);
const items = [];
let activeIndex = -1;
let isBusy = false;
let worker = null;
let jobResolve = null;
let jobReject = null;
let previewUrl = null;
let cancelled = false;

const digits = (n) => Number(n).toLocaleString("fa-IR");
const sizeOf = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " مگابایت";
const escapeExt = (s) => s.replace(/\.[^.]+$/, "");
const setStatus = (message, error = false) => {
  get("status").textContent = message;
  get("status").classList.toggle("error", error);
};

function addFiles(fileList) {
  if (isBusy) return;
  const files = [...fileList].filter((f) => f.type.startsWith("audio/") || f.type.startsWith("video/") || /\.(mp3|wav|m4a|mp4|webm|ogg|flac|mov|mkv|wma)$/i.test(f.name));
  for (const file of files) {
    if (items.some((x) => x.file.name === file.name && x.file.size === file.size && x.file.lastModified === file.lastModified)) continue;
    items.push({ file, state: "منتظر", segments: null, fullText: null, duration: 0, error: null });
  }
  if (files.length !== fileList.length) setStatus("برخی پرونده‌ها قالب صوتی یا ویدئویی قابل شناسایی ندارند.", true);
  else setStatus(items.length ? "پرونده‌ها آمادهٔ پردازش هستند." : "هنوز فایلی انتخاب نشده است.");
  renderQueue();
}

function renderQueue() {
  get("queueWrap").hidden = items.length === 0;
  get("fileCount").textContent = digits(items.length);
  get("start").disabled = isBusy || !items.some((x) => x.state !== "تکمیل");
  get("clearFiles").disabled = isBusy;
  const root = get("queue");
  root.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "file-item" + (index === activeIndex ? " active" : "");
    const name = document.createElement("span");
    name.className = "filename";
    name.title = item.file.name;
    name.textContent = item.file.name;
    const size = document.createElement("span");
    size.className = "file-meta";
    size.textContent = sizeOf(item.file.size);
    const status = document.createElement("span");
    status.className = "file-status";
    status.textContent = item.state;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.segments ? "نمایش خروجی" : "×";
    button.title = item.segments ? "نمایش خروجی" : "حذف پرونده";
    button.addEventListener("click", () => {
      if (item.segments) showResult(index);
      else if (!isBusy) {
        items.splice(index, 1);
        activeIndex = -1;
        get("resultSection").hidden = true;
        renderQueue();
      }
    });
    row.append(name, size, status, button);
    root.append(row);
  });
}

function lockUI(busy) {
  isBusy = busy;
  get("files").disabled = busy;
  get("start").disabled = busy;
  get("stop").hidden = !busy;
  for (const id of ["language", "model", "device", "clearFiles"]) get(id).disabled = busy;
  renderQueue();
}

function updateProgress(stage, percentage = null, detail = "") {
  get("progressBox").hidden = false;
  get("progressTitle").textContent = stage;
  get("progressPercent").textContent = percentage == null ? "" : Math.round(percentage) + "٪";
  const bar = get("progress");
  if (percentage == null) bar.removeAttribute("value");
  else bar.value = percentage;
  get("progressDetail").textContent = detail;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "stage") updateProgress(msg.stage);
    if (msg.type === "loading") {
      const fileName = msg.file ? "در حال دریافت: " + msg.file.split("/").pop() : "بارگیری مدل";
      updateProgress(fileName, msg.percent, msg.status === "ready" ? "مدل آماده است." : "بسته به سرعت اتصال، دریافت اولیه ممکن است طولانی باشد.");
    }
    if (msg.type === "done" && jobResolve) {
      const complete = jobResolve;
      jobResolve = null;
      jobReject = null;
      complete(msg.output);
    }
    if (msg.type === "error" && jobReject) {
      const fail = jobReject;
      jobResolve = null;
      jobReject = null;
      fail(new Error(msg.message));
    }
  };
  worker.onerror = (event) => {
    const fail = jobReject;
    jobResolve = null;
    jobReject = null;
    if (worker) worker.terminate();
    worker = null;
    if (fail) fail(new Error("خطا در بارگیری موتور رونویسی. اتصال اینترنت و دسترسی به خدمات مدل را بررسی کنید."));
    event.preventDefault();
  };
  return worker;
}

async function prepareAudio(file) {
  updateProgress("در حال خواندن و آماده‌سازی صوت");
  const buffer = await file.arrayBuffer();
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error("این مرورگر امکان پردازش صوت را ندارد.");
  const context = new Ctor();
  let decoded;
  try {
    decoded = await context.decodeAudioData(buffer);
  } catch {
    throw new Error("مرورگر نمی‌تواند صدای این فایل را باز کند. فایل را به WAV یا MP3 تبدیل کنید.");
  } finally {
    await context.close().catch(() => {});
  }
  const rate = decoded.sampleRate;
  const channels = decoded.numberOfChannels;
  const targetRate = 16000;
  const total = Math.floor(decoded.duration * targetRate);
  if (!total || !channels) throw new Error("فایل دارای صدای قابل تشخیص نیست.");
  const output = new Float32Array(total);
  const input = Array.from({length: channels}, (_, i) => decoded.getChannelData(i));
  for (let i = 0; i < total; i++) {
    const position = i * rate / targetRate;
    const lo = Math.floor(position);
    const hi = Math.min(lo + 1, input[0].length - 1);
    const fraction = position - lo;
    let average = 0;
    for (const channel of input) average += channel[lo] * (1 - fraction) + channel[hi] * fraction;
    output[i] = average / channels;
  }
  return { data: output, duration: decoded.duration };
}

function dispatchToWorker(samples) {
  return new Promise((resolve, reject) => {
    jobResolve = resolve;
    jobReject = reject;
    ensureWorker().postMessage({
      type: "run",
      audio: samples,
      language: get("language").value,
      model: get("model").value,
      device: get("device").value,
    }, [samples.buffer]);
  });
}

async function start() {
  if (isBusy || !items.length) return;
  cancelled = false;
  lockUI(true);
  let done = 0;
  try {
    for (const item of items) {
      if (cancelled) break;
      if (item.state === "تکمیل") continue;
      item.state = "پردازش";
      renderQueue();
      setStatus("در حال پردازش: " + item.file.name);
      try {
        const { data, duration } = await prepareAudio(item.file);
        if (cancelled) break;
        item.duration = duration;
        updateProgress("در حال تشخیص گفتار", null, "پردازش ممکن است روی گوشی یا رایانه‌های کم‌توان طولانی باشد.");
        const result = await dispatchToWorker(data);
        if (cancelled) break;
        item.segments = Array.isArray(result.chunks) && result.chunks.length
          ? result.chunks.map((x) => ({
              start: Number(x.timestamp?.[0]) || 0,
              end: Number.isFinite(x.timestamp?.[1]) ? x.timestamp[1] : duration,
              text: String(x.text || "").trim(),
            }))
          : [{ start: 0, end: duration, text: String(result.text || "").trim() }];
        item.fullText = null;
        item.state = "تکمیل";
        item.error = null;
        done++;
        showResult(items.indexOf(item));
        setStatus("خروجی «" + item.file.name + "» آماده است.");
      } catch (e) {
        if (cancelled) break;
        item.state = "خطا";
        item.error = e.message;
        setStatus("خطا در «" + item.file.name + "»: " + e.message, true);
      }
      renderQueue();
    }
    if (!cancelled && done > 0) setStatus(digits(done) + " پرونده با موفقیت پردازش شد. برای مشاهده هر خروجی روی نام آن کلیک کنید.");
  } finally {
    lockUI(false);
    get("progressBox").hidden = true;
    if (cancelled) setStatus("عملیات متوقف شد. خروجی‌های تکمیل‌شده حفظ شدند.");
  }
}

function stop() {
  if (!isBusy) return;
  cancelled = true;
  if (worker) worker.terminate();
  worker = null;
  if (jobReject) jobReject(new Error("متوقف شد."));
  jobResolve = null;
  jobReject = null;
  items.filter((x) => x.state === "پردازش").forEach((x) => { x.state = "متوقف"; });
}

const fixed = (v) => Number.isFinite(v) ? Math.max(0, v).toFixed(2) : "0.00";
const toSeconds = (value) => {
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function showResult(index) {
  const item = items[index];
  if (!item?.segments) return;
  activeIndex = index;
  renderQueue();
  get("resultSection").hidden = false;
  get("resultFile").textContent = item.file.name;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(item.file);
  const media = document.createElement(item.file.type.startsWith("video/") ? "video" : "audio");
  media.controls = true;
  media.preload = "metadata";
  media.src = previewUrl;
  get("player").replaceChildren(media);
  const segmentsRoot = get("segments");
  segmentsRoot.replaceChildren();
  item.segments.forEach((segment) => {
    const row = document.createElement("div");
    row.className = "segment";
    const start = document.createElement("input");
    start.type = "number";
    start.min = "0";
    start.step = "0.01";
    start.title = "زمان آغاز (ثانیه)";
    start.value = fixed(segment.start);
    const end = document.createElement("input");
    end.type = "number";
    end.min = "0";
    end.step = "0.01";
    end.title = "زمان پایان (ثانیه)";
    end.value = fixed(segment.end);
    const text = document.createElement("textarea");
    text.rows = 2;
    text.dir = "auto";
    text.value = segment.text;
    const save = () => {
      segment.start = toSeconds(start.value);
      segment.end = Math.max(segment.start + 0.01, toSeconds(end.value));
      segment.text = text.value;
      item.fullText = null;
      get("allText").value = textOf(item);
    };
    start.addEventListener("change", save);
    end.addEventListener("change", save);
    text.addEventListener("input", save);
    row.append(start, end, text);
    segmentsRoot.append(row);
  });
  get("allText").value = textOf(item);
}

function textOf(item) {
  return item.fullText == null ? item.segments.map((s) => s.text.trim()).filter(Boolean).join(" ") : item.fullText;
}

function timestamp(seconds, separator) {
  const milliseconds = Math.floor(Math.max(0, seconds) * 1000);
  const h = String(Math.floor(milliseconds / 3600000)).padStart(2, "0");
  const m = String(Math.floor(milliseconds % 3600000 / 60000)).padStart(2, "0");
  const s = String(Math.floor(milliseconds % 60000 / 1000)).padStart(2, "0");
  const ms = String(milliseconds % 1000).padStart(3, "0");
  return h + ":" + m + ":" + s + separator + ms;
}

function subtitles(item, type) {
  const vtt = type === "vtt";
  const cues = item.segments.filter((c) => c.text.trim()).map((c, i) => {
    const from = timestamp(c.start, vtt ? "." : ",");
    const to = timestamp(Math.max(c.end, c.start + .01), vtt ? "." : ",");
    return (i + 1) + "\n" + from + " --> " + to + "\n" + c.text.trim();
  });
  return (vtt ? "WEBVTT\n\n" : "") + cues.join("\n\n") + "\n";
}

function download(type) {
  const item = items[activeIndex];
  if (!item?.segments) return;
  const body = type === "txt" ? textOf(item) + "\n" : subtitles(item, type);
  const mime = type === "vtt" ? "text/vtt" : "text/plain";
  const blob = new Blob(["\ufeff", body], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = escapeExt(item.file.name) + "." + type;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

get("files").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
const dropzone = get("dropzone");
dropzone.addEventListener("click", () => { if (!isBusy) get("files").click(); });
dropzone.addEventListener("keydown", (e) => { if (!isBusy && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); get("files").click(); } });
for (const name of ["dragenter", "dragover"]) dropzone.addEventListener(name, (e) => { e.preventDefault(); if (!isBusy) dropzone.classList.add("drag"); });
for (const name of ["dragleave", "drop"]) dropzone.addEventListener(name, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); });
dropzone.addEventListener("drop", (e) => { if (!isBusy) addFiles(e.dataTransfer.files); });
get("clearFiles").addEventListener("click", () => {
  if (isBusy) return;
  items.length = 0;
  activeIndex = -1;
  get("resultSection").hidden = true;
  renderQueue();
  setStatus("فهرست پرونده‌ها پاک شد.");
});
get("start").addEventListener("click", start);
get("stop").addEventListener("click", stop);
get("downloadTxt").addEventListener("click", () => download("txt"));
get("downloadSrt").addEventListener("click", () => download("srt"));
get("downloadVtt").addEventListener("click", () => download("vtt"));
get("allText").addEventListener("input", (e) => { if (items[activeIndex]) items[activeIndex].fullText = e.target.value; });
get("copyText").addEventListener("click", async () => {
  const item = items[activeIndex];
  if (!item) return;
  try {
    await navigator.clipboard.writeText(textOf(item));
    setStatus("متن در حافظهٔ موقت کپی شد.");
  } catch {
    get("allText").select();
    setStatus("کپی مستقیم پشتیبانی نمی‌شود؛ متن برای کپی انتخاب شد.");
  }
});
window.addEventListener("beforeunload", () => { if (previewUrl) URL.revokeObjectURL(previewUrl); if (worker) worker.terminate(); });
renderQueue();
