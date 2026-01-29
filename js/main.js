"use strict";

let rows = []; // { timestamp: string, message: string }

const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");
const preview = document.getElementById("preview");
const filteredWordSpan = document.getElementById("filteredWord");

const targetMsg = document.getElementById("targetMsg");
const calcTargetBtn = document.getElementById("calcTargetBtn");
const report = document.getElementById("report");
const fileName = document.getElementById("fileName");
const logSource = document.getElementById("logSource");

// NOVO: elementos de stats
const stOccurrences = document.getElementById("stOccurrences");
const stDeltas = document.getElementById("stDeltas");
const stIntra = document.getElementById("stIntra");
const stInter = document.getElementById("stInter");
const stCycles = document.getElementById("stCycles");

// NOVO: botões
const copyReportBtn = document.getElementById("copyReportBtn");
const downloadTxtBtn = document.getElementById("downloadTxtBtn");

function updateFilteredWord() {
  filteredWordSpan.textContent = targetMsg.value || "—";
}

targetMsg.addEventListener("change", updateFilteredWord);

function setStats(s) {
  const dash = "—";
  if (!stOccurrences) return;

  if (!s) {
    stOccurrences.textContent = dash;
    stDeltas.textContent = dash;
    stIntra.textContent = dash;
    stInter.textContent = dash;
    stCycles.textContent = dash;
    return;
  }

  stOccurrences.textContent = String(s.occurrences ?? dash);
  stDeltas.textContent = String(s.deltas ?? dash);
  stIntra.textContent = s.intra != null ? `${s.intra.toFixed(2)} s` : dash;
  stInter.textContent = s.inter != null ? `${s.inter.toFixed(2)} s` : dash;
  stCycles.textContent = s.cycles != null ? String(s.cycles) : dash;
}

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
  // Rápido: funciona para logs típicos.
  // Se seu CSV tiver aspas e vírgulas dentro de campos, posso te dar parser CSV completo depois.
  return line.split(delimiter);
}

// Detecta a origem do log pelo conteúdo (opcional, mas ajuda muito)
function detectLogSource(lines) {
  const firstNonEmpty = (lines.find(l => l.trim()) || "").toLowerCase();
  if (firstNonEmpty.includes("message log") || firstNonEmpty.includes("simulation start time")) return "md8475a";

  const header = (lines[0] || "").toLowerCase();
  if (header.includes("no.,progress time") && header.includes(",message")) return "md8475a";
  if (header.includes("timestamp") && header.includes("message")) return "agilent";

  // fallback
  return "agilent";
}

function parseAgilent(lines) {
  const delimiter = detectDelimiter(lines[0]);
  const headers = safeSplit(lines[0], delimiter).map(h => h.trim().toLowerCase());

  const idxTimestamp = headers.findIndex(h => h === "timestamp");
  const idxMessage = headers.findIndex(h => h === "message");

  if (idxTimestamp === -1 || idxMessage === -1) {
    return { rows: [], error: "⚠️ Não encontrei as colunas 'Timestamp' e 'Message'. Confirme se o arquivo tem cabeçalho com esses nomes." };
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
  // Acha o cabeçalho da “tabela” do MD8475A
  const headerIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith("no.,progress time"));
  if (headerIdx === -1) {
    return { rows: [], error: "⚠️ Não encontrei o cabeçalho 'No.,Progress Time,...' do MD8475A. Confirme se o arquivo é do tipo 'Message Log'." };
  }

  const header = lines[headerIdx];
  const delimiter = detectDelimiter(header); // geralmente ","
  const headers = safeSplit(header, delimiter).map(h => h.trim().toLowerCase());

  const idxProgress = headers.findIndex(h => h === "progress time");
  const idxMessage = headers.findIndex(h => h === "message");

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

// "HH:MM:SS.ffffff" -> micros desde 00:00:00 (BigInt)
function parseTimeToMicros(ts) {
  const s = ts.trim();
  const m = s.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/);
  if (!m) return null;

  const hh = BigInt(m[1]);
  const mm = BigInt(m[2]);
  const ss = BigInt(m[3]);

  let frac = (m[4] ?? "0");
  frac = (frac + "000000").slice(0, 6); // microsegundos
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

function microsToSeconds(us) {
  return Number(us) / 1_000_000;
}

function median(nums) {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Detecta padrão de ciclos:
 * - intra = deltas curtos (tentativas dentro do ciclo)
 * - inter = deltas médios (pausa entre ciclos)
 * - long  = deltas muito longos (backoff / espera longa)
 *
 * Heurística:
 * - mediana tende a virar intra
 * - intra <= intra*1.35
 * - inter  > intra*1.35 e <= intra*3.0
 * - long > intra*3.0
 */
function detectCycles(deltasMicros) {
  const deltasSec = deltasMicros.map(microsToSeconds);
  const intra = median(deltasSec);
  if (intra == null) return null;

  const intraMax = intra * 1.35;
  const interMax = intra * 3.0;

  const intraList = [];
  const interList = [];
  const longList = [];

  for (const d of deltasSec) {
    if (d <= intraMax) intraList.push(d);
    else if (d <= interMax) interList.push(d);
    else longList.push(d);
  }

  const cycles = interList.length ? (interList.length + 1) : 1;
  const attemptsPerCycle = cycles ? Math.round((intraList.length / cycles) + 1) : null;

  const intraMed = median(intraList) ?? intra;
  const interMed = median(interList);

  return {
    cycles,
    attemptsPerCycle,
    intraMed,
    interMed,
    intraList,
    interList,
    longList
  };
}

function fillTargetSelectFromRows() {
  const uniqMsgs = Array.from(new Set(rows.map(r => r.message))).sort();

  targetMsg.innerHTML = "";
  for (const m of uniqMsgs) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    targetMsg.appendChild(opt);
  }

  // tenta selecionar Attach Reject automaticamente (case-insensitive)
  const idx = uniqMsgs.findIndex(x => x.toLowerCase().includes("attach reject"));
  if (idx >= 0) targetMsg.selectedIndex = idx;

  updateFilteredWord();
}

function buildDeltasForTargetMessage(rows, target) {
  const DAY = 24n * 60n * 60n * 1000000n;

  const occurrences = [];
  for (const r of rows) {
    if (r.message !== target) continue;
    const t = parseTimeToMicros(r.timestamp);
    if (t == null) continue;
    occurrences.push({ ts: r.timestamp, t });
  }

  if (occurrences.length < 2) {
    setStats(null);
    return `⚠️ Mensagem "${target}" tem poucas ocorrências (${occurrences.length}).`;
  }

  let min = null;
  let max = null;
  let sum = 0n;

  const deltasMicros = [];
  const lines = [];
  lines.push(`Mensagem alvo: ${target}`);
  lines.push(`Ocorrências encontradas: ${occurrences.length}`);
  lines.push(`Deltas calculados: ${occurrences.length - 1}`);
  lines.push("");
  lines.push("Lista de deltas (ocorrência -> próxima ocorrência):");

  for (let i = 0; i < occurrences.length - 1; i++) {
    let dt = occurrences[i + 1].t - occurrences[i].t;

    // se cruzar meia-noite, ajusta
    if (dt < 0n) dt += DAY;

    deltasMicros.push(dt);
    lines.push(`${occurrences[i].ts} -> ${occurrences[i + 1].ts} = ${formatMicros(dt)}`);

    sum += dt;
    if (min === null || dt < min) min = dt;
    if (max === null || dt > max) max = dt;
  }

  const count = BigInt(deltasMicros.length);
  const avg = sum / count;

  const cyc = detectCycles(deltasMicros);

  lines.push("");
  lines.push("Resumo:");
  lines.push(`N=${count.toString()} | min=${formatMicros(min)} | media=${formatMicros(avg)} | max=${formatMicros(max)}`);

  if (cyc && cyc.interMed != null) {
    lines.push("");
    lines.push("Padrão detectado:");
    lines.push(`- Ciclos: ${cyc.cycles}`);
    lines.push(`- Tentativas por ciclo (estimado): ${cyc.attemptsPerCycle}`);
    lines.push(`- Δt típico intra-ciclo: ~${cyc.intraMed.toFixed(2)} s`);
    lines.push(`- Pausa típica entre ciclos: ~${cyc.interMed.toFixed(2)} s`);
  }

  setStats({
    occurrences: occurrences.length,
    deltas: deltasMicros.length,
    intra: cyc?.intraMed,
    inter: cyc?.interMed,
    cycles: cyc?.cycles
  });

  return lines.join("\n");
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  fileName.textContent = file.name;
  fileInfo.textContent = `Arquivo: ${file.name} (${Math.round(file.size / 1024)} KB)`;

  preview.textContent = "";
  report.textContent = "";
  rows = [];
  setStats(null);

  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result ?? "";
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

    preview.textContent = lines.slice(0, 30).join("\n");

    if (lines.length < 2) {
      report.textContent = "⚠️ Arquivo tem poucas linhas para analisar.";
      return;
    }

    // escolhe fonte (auto / agilent / md8475a)
    let src = (logSource?.value || "auto");
    if (src === "auto") src = detectLogSource(lines);

    let parsed;
    if (src === "md8475a") parsed = parseMD8475A(lines);
    else parsed = parseAgilent(lines);

    if (parsed.error) {
      report.textContent = parsed.error;
      return;
    }

    rows = parsed.rows;

    fillTargetSelectFromRows();

    report.textContent =
      `✅ Fonte detectada/selecionada: ${src}\n` +
      `✅ Linhas válidas carregadas: ${rows.length}\n` +
      `✅ Mensagens únicas: ${new Set(rows.map(r => r.message)).size}\n\n` +
      `Selecione a mensagem alvo e clique em "Calcular deltas".`;
  };

  reader.readAsText(file);
});

calcTargetBtn.addEventListener("click", () => {
  if (!rows.length) {
    report.textContent = "⚠️ Carregue um arquivo primeiro.";
    return;
  }
  updateFilteredWord();
  const target = targetMsg.value;
  report.textContent = buildDeltasForTargetMessage(rows, target);
});

// NOVO: copiar/baixar
copyReportBtn?.addEventListener("click", async () => {
  const text = report.textContent || "";
  if (!text.trim()) return;

  try {
    await navigator.clipboard.writeText(text);
    copyReportBtn.textContent = "Copiado ✅";
    setTimeout(() => copyReportBtn.textContent = "Copiar relatório", 1200);
  } catch {
    alert("Não foi possível copiar. Verifique permissões do navegador.");
  }
});

downloadTxtBtn?.addEventListener("click", () => {
  const text = report.textContent || "";
  if (!text.trim()) return;

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `projanalyze_${(filteredWordSpan.textContent || "relatorio").replaceAll(" ", "_")}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
});
