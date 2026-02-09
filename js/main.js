"use strict";

let rows = []; // { timestamp, message }

// Elements
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");
const fileName = document.getElementById("fileName");
const logSource = document.getElementById("logSource");

const preview = document.getElementById("preview");

const testMode = document.getElementById("testMode");
const runTestBtn = document.getElementById("runTestBtn");

const deltaControls = document.getElementById("deltaControls");
const targetMsg = document.getElementById("targetMsg");

const pdpControls = document.getElementById("pdpControls");
const pdpSecondary = document.getElementById("pdpSecondary");

const report = document.getElementById("report");
const filteredWordSpan = document.getElementById("filteredWord");

const copyReportBtn = document.getElementById("copyReportBtn");
const printBtn = document.getElementById("printBtn");

// Buffers
let rawLinesAll = [];
let previewLines = [];
let previewNormalText = "";

// ✅ força change disparar mesmo com mesmo arquivo
fileInput?.addEventListener("click", () => (fileInput.value = ""));

// ============ Parsing helpers ============

function detectDelimiter(headerLine) {
  const candidates = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = -1;

  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function safeSplit(line, delimiter) {
  return line.split(delimiter);
}

function detectLogSource(lines) {
  const firstNonEmpty = (lines.find((l) => l.trim()) || "").toLowerCase();
  if (firstNonEmpty.includes("message log") || firstNonEmpty.includes("simulation start time")) return "md8475a";

  const header = (lines[0] || "").toLowerCase();
  if (header.includes("no.,progress time") && header.includes(",message")) return "md8475a";
  if (header.includes("timestamp") && header.includes("message")) return "agilent";

  return "agilent";
}

function parseAgilent(lines) {
  const delimiter = detectDelimiter(lines[0]);
  const headers = safeSplit(lines[0], delimiter).map((h) => h.trim().toLowerCase());

  const idxTimestamp = headers.findIndex((h) => h === "timestamp");
  const idxMessage = headers.findIndex((h) => h === "message");

  if (idxTimestamp === -1 || idxMessage === -1) {
    return { rows: [], error: "⚠️ Não encontrei as colunas 'Timestamp' e 'Message'." };
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = safeSplit(lines[i], delimiter);
    const timestamp = (cols[idxTimestamp] ?? "").trim();
    const message = (cols[idxMessage] ?? "").trim();
    if (!timestamp || !message) continue;
    out.push({ timestamp, message });
  }
  return { rows: out, error: null };
}

function parseMD8475A(lines) {
  const headerIdx = lines.findIndex((l) => l.trim().toLowerCase().startsWith("no.,progress time"));
  if (headerIdx === -1) {
    return { rows: [], error: "⚠️ Não encontrei o cabeçalho 'No.,Progress Time,...' do MD8475A." };
  }

  const header = lines[headerIdx];
  const delimiter = detectDelimiter(header);
  const headers = safeSplit(header, delimiter).map((h) => h.trim().toLowerCase());

  const idxProgress = headers.findIndex((h) => h === "progress time");
  const idxMessage = headers.findIndex((h) => h === "message");

  if (idxProgress === -1 || idxMessage === -1) {
    return { rows: [], error: "⚠️ Cabeçalho MD8475A inválido: faltou 'Progress Time' ou 'Message'." };
  }

  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    if (line.startsWith("---")) continue;

    const cols = safeSplit(line, delimiter);
    const timestamp = (cols[idxProgress] ?? "").trim();
    const message = (cols[idxMessage] ?? "").trim();
    if (!timestamp || !message) continue;

    out.push({ timestamp, message });
  }
  return { rows: out, error: null };
}

// ============ Time helpers ============

function parseTimeToMicros(ts) {
  const s = ts.trim();
  const m = s.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/);
  if (!m) return null;

  const hh = BigInt(m[1]);
  const mm = BigInt(m[2]);
  const ss = BigInt(m[3]);

  let frac = m[4] ?? "0";
  frac = (frac + "000000").slice(0, 6);
  const us = BigInt(frac);

  return (((hh * 60n + mm) * 60n + ss) * 1000000n) + us;
}

function formatMicros(us) {
  if (us < 0n) return "-" + formatMicros(-us);

  const totalSeconds = us / 1000000n;
  const micro = us % 1000000n;

  const h = totalSeconds / 3600n;
  const m = (totalSeconds % 3600n) / 60n;
  const s = totalSeconds % 60n;

  const pad2 = (x) => x.toString().padStart(2, "0");
  const pad6 = (x) => x.toString().padStart(6, "0");
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad6(micro)}`;
}

function diffMicrosWithRollover(a, b) {
  const DAY = 24n * 60n * 60n * 1000000n;
  let dt = b - a;
  if (dt < 0n) dt += DAY;
  return dt;
}

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ============ Δt normal (padrão original) ============

function buildDeltasForTargetMessage(rows, target) {
  const occurrences = [];
  for (const r of rows) {
    if (r.message !== target) continue;
    const t = parseTimeToMicros(r.timestamp);
    if (t == null) continue;
    occurrences.push({ ts: r.timestamp, t });
  }

  if (occurrences.length < 2) {
    return `⚠️ Mensagem "${target}" tem poucas ocorrências (${occurrences.length}).`;
  }

  let min = null, max = null, sum = 0n;

  const lines = [];
  lines.push(`Mensagem alvo: ${target}`);
  lines.push(`Ocorrências encontradas: ${occurrences.length}`);
  lines.push(`Deltas calculados: ${occurrences.length - 1}`);
  lines.push("");
  lines.push("Lista de deltas (ocorrência -> próxima ocorrência):");

  for (let i = 0; i < occurrences.length - 1; i++) {
    const dt = diffMicrosWithRollover(occurrences[i].t, occurrences[i + 1].t);

    lines.push(`(${i + 1}) ${occurrences[i].ts} -> (${i + 2}) ${occurrences[i + 1].ts} = ${formatMicros(dt)}`);

    sum += dt;
    if (min === null || dt < min) min = dt;
    if (max === null || dt > max) max = dt;
  }

  const avg = sum / BigInt(occurrences.length - 1);

  lines.push("");
  lines.push("Resumo:");
  lines.push(`N=${occurrences.length - 1} | min=${formatMicros(min)} | media=${formatMicros(avg)} | max=${formatMicros(max)}`);

  return lines.join("\n");
}

// ============ Preview (SEMPRE sem pintar) ============

function renderPreviewNormal() {
  preview.textContent = previewNormalText || "";
}

// ============ PDP mode ============

function fillSecondarySelectFromRows() {
  const uniqMsgs = Array.from(new Set(rows.map((r) => r.message))).sort();
  const current = pdpSecondary?.value;

  if (!pdpSecondary) return;

  pdpSecondary.innerHTML = "";

  const optNone = document.createElement("option");
  optNone.value = "__none__";
  optNone.textContent = "Nenhum";
  pdpSecondary.appendChild(optNone);

  const optDetach = document.createElement("option");
  optDetach.value = "__detach__";
  optDetach.textContent = "Detach";
  pdpSecondary.appendChild(optDetach);

  for (const m of uniqMsgs) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    pdpSecondary.appendChild(opt);
  }

  if (current) pdpSecondary.value = current;
}

function fillTargetSelectFromRows() {
  const uniqMsgs = Array.from(new Set(rows.map((r) => r.message))).sort();
  if (!targetMsg) return;

  targetMsg.innerHTML = "";
  for (const m of uniqMsgs) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    targetMsg.appendChild(opt);
  }
}

function buildSecondaryMatcher() {
  const v = pdpSecondary?.value || "__none__";
  if (v === "__none__") return null;

  if (v === "__detach__") {
    const re = /\bdetach\b/i;
    return {
      kind: "detach",
      matchRow: (msg) => re.test(msg),
    };
  }

  // qualquer mensagem exata do log
  return {
    kind: "secondary",
    exact: v,
    matchRow: (msg) => msg === v,
  };
}

/**
 * PDP report:
 * - Primary fixo: Activate PDP Context Reject
 * - Δt SOMENTE entre rejects
 * - Secundário marcado ENTRE reject_i e reject_{i+1} (sem delta)
 * - Se secundário for "__detach__" OU "GMM - Detach Request", fecha ciclo e avalia 2..5 + constância
 * - Espaçamento delicado: linha em branco após cada delta
 * - Visual: no output (#report) com badges (R amarelo, DETACH vermelho, SEC verde)
 */
function buildPdpReport(rows) {
  const rejectRe = /activate\s*pdp\s*context.*reject/i;

  const secondary = buildSecondaryMatcher();

  // ✅ também fecha ciclo se secundário = "GMM - Detach Request"
  const isGmmDetachRequestSelected =
    (pdpSecondary?.value || "") === "GMM - Detach Request";

  // Stream de eventos em ordem
  const events = []; // { type:"reject"|"detach"|"secondary", tsStr, tMicros, msg }
  for (const r of rows) {
    const msg = r.message || "";
    const t = parseTimeToMicros(r.timestamp);
    if (t == null) continue;

    if (rejectRe.test(msg)) {
      events.push({ type: "reject", tsStr: r.timestamp, tMicros: t, msg });
      continue;
    }

    if (secondary && secondary.matchRow(msg)) {
      if (isGmmDetachRequestSelected) {
        // trata esse secundário como detach (fecha ciclo)
        events.push({ type: "detach", tsStr: r.timestamp, tMicros: t, msg });
      } else {
        events.push({ type: secondary.kind, tsStr: r.timestamp, tMicros: t, msg });
      }
    }
  }

  // Índices dos rejects dentro do stream
  const rejectIdxs = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "reject") rejectIdxs.push(i);
  }

  // ===== Ciclos =====
  const errors = [];
  let counts = [];
  let constancyText = "—";

  const cycleEnabled =
    (secondary && secondary.kind === "detach") || isGmmDetachRequestSelected;

  if (cycleEnabled) {
    let cur = 0;
    for (const ev of events) {
      if (ev.type === "reject") cur++;
      if (ev.type === "detach") {
        if (cur > 0) {
          counts.push(cur);
          cur = 0;
        }
      }
    }
    if (cur > 0) errors.push(`Rejects sem Detach (final): ${cur}`);

    for (let i = 0; i < counts.length; i++) {
      const n = counts[i];
      if (n < 2 || n > 5) errors.push(`Ciclo ${i + 1}: Rejects = ${n} (esperado 2 a 5).`);
    }

    const uniq = Array.from(new Set(counts));
    if (counts.length === 0) constancyText = "—";
    else if (uniq.length === 1) constancyText = `OK (sempre ${uniq[0]})`;
    else {
      constancyText = `VARIOU (${uniq.join(", ")})`;
      errors.push(`Constância: variou entre ciclos: [${uniq.join(", ")}].`);
    }
  } else {
    constancyText = "— (selecione Detach ou 'GMM - Detach Request' para avaliar ciclos)";
  }

  // ===== Relatório =====
  const totalRejects = rejectIdxs.length;

  const secondaryLabel = (() => {
    if (!secondary) return "Nenhum";
    if (isGmmDetachRequestSelected) return "GMM - Detach Request (fecha ciclo)";
    if (secondary.kind === "detach") return "Detach (fecha ciclo)";
    return "Mensagem selecionada (marcador)";
  })();

  const out = [];
  out.push("Modo PDP (Δt entre Rejects PDP)");
  out.push("");
  out.push("Primário fixo:");
  out.push("- Activate PDP Context Reject");
  out.push("");
  out.push("Regras de ciclo (avaliadas quando secundário fecha ciclo):");
  out.push("- Aceita 2 a 5 Rejects antes do Detach");
  out.push("- Após Detach, reinicia mantendo a mesma quantidade");
  out.push("");
  out.push("Resumo:");
  out.push(`- Total de Rejects: ${totalRejects}`);
  out.push(`- Secundário: ${secondaryLabel}`);
  out.push(`- Ciclos: ${counts.length ? counts.length : "—"}`);
  out.push(`- Rejects por ciclo: ${counts.length ? counts.join(", ") : "—"}`);
  out.push(`- Constância: ${constancyText}`);
  out.push("");
  out.push("Erros:");
  out.push(errors.length ? errors.map((e) => `- ${e}`).join("\n") : "- Nenhum");
  out.push("");
  out.push("Linha do tempo:");
  out.push("Δt é calculado SOMENTE entre Rejects.");
  out.push("O secundário aparece apenas como marcador no meio (sem delta).");
  out.push("");

  if (totalRejects < 2) {
    out.push("⚠️ Precisa de pelo menos 2 Rejects para calcular Δt.");
  } else {
    for (let i = 0; i < rejectIdxs.length - 1; i++) {
      const idxA = rejectIdxs[i];
      const idxB = rejectIdxs[i + 1];
      const A = events[idxA];
      const B = events[idxB];

      const dt = diffMicrosWithRollover(A.tMicros, B.tMicros);
      out.push(`(R${i + 1}) ${A.tsStr} -> (R${i + 2}) ${B.tsStr} = ${formatMicros(dt)}`);

      const middle = events.slice(idxA + 1, idxB).filter((e) => e.type !== "reject");
      if (middle.length) {
        for (const m of middle) {
          if (m.type === "detach") {
            out.push(""); // dá um respiro antes do DETACH
            out.push(`└─[DETACH] ${m.tsStr}`); // ✅ mais recuado e sem "└─" colado
            out.push(""); // respiro depois do DETACH
          } else {
            out.push(`└─ [SEC] ${m.tsStr}`);
          }
        }
      }

      // ✅ espaçamento delicado
      out.push("");
    }
  }

  const text = out.join("\n");

  // Visual no report
  const html = escapeHtml(text)
    .replaceAll(
      "[DETACH]",
      `<span style="background:#e53e3e;color:#fff;padding:1px 8px;border-radius:999px;font-weight:800;">DETACH</span>`
    )
    .replaceAll(
      "[SEC]",
      `<span style="background:#22c55e;color:#0b1b0f;padding:1px 8px;border-radius:999px;font-weight:800;">SEC</span>`
    )
    .replace(/\(R(\d+)\)/g,
      `<span style="background:#f6e05e;color:#111;padding:1px 8px;border-radius:999px;font-weight:800;">R$1</span>`
    );

  return html;
}

// ============ UI behavior ============

function updateControlsVisibility() {
  const mode = testMode?.value || "none";
  if (deltaControls) deltaControls.style.display = (mode === "delta_t") ? "block" : "none";
  if (pdpControls) pdpControls.style.display = (mode === "pdp_reject_timeline") ? "block" : "none";
}

testMode?.addEventListener("change", () => {
  updateControlsVisibility();
});

// ============ Load file ============

fileInput?.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  fileName.textContent = file.name;
  fileInfo.textContent = `Arquivo: ${file.name} (${Math.round(file.size / 1024)} KB)`;

  // reset
  preview.textContent = "";
  report.textContent = "";
  filteredWordSpan.textContent = "—";
  rows = [];
  rawLinesAll = [];
  previewLines = [];
  previewNormalText = "";

  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result ?? "";
    rawLinesAll = String(text).split(/\r?\n/);
    previewLines = rawLinesAll.filter((l) => l.trim().length > 0);

    // ✅ preview SEMPRE normal (sem pintar)
    previewNormalText = previewLines.slice(0, 30).join("\n");
    renderPreviewNormal();

    if (previewLines.length < 2) {
      report.textContent = "⚠️ Arquivo tem poucas linhas para analisar.";
      return;
    }

    let src = (logSource?.value || "auto");
    if (src === "auto") src = detectLogSource(previewLines);

    const parsed = (src === "md8475a") ? parseMD8475A(previewLines) : parseAgilent(previewLines);
    if (parsed.error) {
      report.textContent = parsed.error;
      return;
    }

    rows = parsed.rows;

    // preenche selects
    fillTargetSelectFromRows();
    fillSecondarySelectFromRows();

    report.textContent =
      `✅ Arquivo carregado\n` +
      `✅ Fonte: ${src}\n` +
      `✅ Linhas válidas: ${rows.length}\n\n` +
      `Selecione um modo e clique em "Executar".`;
  };

  reader.readAsText(file);
});

// ============ Execute ============

runTestBtn?.addEventListener("click", () => {
  if (!previewLines.length) {
    report.textContent = "⚠️ Carregue um arquivo primeiro.";
    return;
  }

  const mode = testMode?.value || "none";
  if (mode === "none") {
    report.textContent = "Selecione um modo e clique em Executar.";
    return;
  }

  // ✅ preview nunca pinta
  renderPreviewNormal();

  if (mode === "pdp_reject_timeline") {
    filteredWordSpan.textContent = "PDP Reject (Δt entre Rejects)";
    report.innerHTML = buildPdpReport(rows);
    return;
  }

  if (mode === "delta_t") {
    const target = targetMsg?.value;
    if (!target) {
      report.textContent = "⚠️ Selecione uma mensagem alvo para calcular Δt.";
      return;
    }
    filteredWordSpan.textContent = target;
    report.textContent = buildDeltasForTargetMessage(rows, target);
    return;
  }
});

// ============ Copy / Print ============

copyReportBtn?.addEventListener("click", async () => {
  const text = report.textContent || ""; // pega texto mesmo se report estiver em HTML
  if (!text.trim()) return;

  try {
    await navigator.clipboard.writeText(text);
    copyReportBtn.textContent = "Copiado ✅";
    setTimeout(() => (copyReportBtn.textContent = "Copiar relatório"), 1200);
  } catch {
    alert("Não foi possível copiar. Verifique permissões do navegador.");
  }
});

printBtn?.addEventListener("click", async () => {
  const text = report.textContent || "";
  if (!text.trim()) return;

  try {
    const blob = await preTextToPngBlob(report);

    const baseName =
      `projanalyze_${(filteredWordSpan.textContent || "relatorio")}`
        .replaceAll(" ", "_")
        .replaceAll("/", "_");

    await saveBlobWithDialog(blob, `${baseName}.png`);
  } catch (err) {
    console.error(err);
    alert("Não foi possível gerar/salvar o print.");
  }
});

async function preTextToPngBlob(preEl) {
  const style = getComputedStyle(preEl);

  const fontSizePx = parseFloat(style.fontSize) || 14;
  const fontFamily = style.fontFamily || "monospace";
  const fontWeight = style.fontWeight || "400";
  const lineHeightPx = parseFloat(style.lineHeight) || Math.ceil(fontSizePx * 1.4);

  const padding = 24;
  const lines = (preEl.textContent || "").replace(/\r\n/g, "\n").split("\n");

  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  mctx.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`;

  let maxWidth = 0;
  for (const line of lines) {
    const w = mctx.measureText(line).width;
    if (w > maxWidth) maxWidth = w;
  }

  const width = Math.max(320, Math.ceil(maxWidth + padding * 2));
  const height = Math.max(200, Math.ceil(lines.length * lineHeightPx + padding * 2));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`;
  ctx.textBaseline = "top";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#000000";
  let y = padding;
  for (const line of lines) {
    ctx.fillText(line, padding, y);
    y += lineHeightPx;
  }

  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("Falha ao gerar PNG."));
      resolve(blob);
    }, "image/png");
  });
}

async function saveBlobWithDialog(blob, suggestedName) {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "Imagem PNG", accept: { "image/png": [".png"] } }],
    });

    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Inicial
updateControlsVisibility();
renderPreviewNormal();
