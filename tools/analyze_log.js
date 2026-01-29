#!/usr/bin/env node
"use strict";

const fs = require("fs");
const readline = require("readline");

function detectDelimiter(headerLine) {
  const cands = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of cands) {
    const count = headerLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

// "HH:MM:SS.ffffff" -> micros do início do dia (BigInt)
function parseTimeToMicros(ts) {
  const s = ts.trim();
  const m = s.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/);
  if (!m) return null;

  const hh = BigInt(m[1]);
  const mm = BigInt(m[2]);
  const ss = BigInt(m[3]);
  let frac = (m[4] ?? "0");

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

function safeSplit(line, delimiter) {
  // Para CSV com aspas/virgulas internas, me avise que eu te passo um parser completo.
  return line.split(delimiter);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log("Uso: node tools/analyze_log.js <caminho-do-arquivo.csv/txt>");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error("Arquivo não encontrado:", filePath);
    process.exit(1);
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let delimiter = null;
  let idxTimestamp = -1;
  let idxMessage = -1;
  let headerParsed = false;

  const lastSeen = new Map(); // msg -> timeMicros
  const stats = new Map();    // msg -> {count,min,max,sum}

  const DAY = 24n * 60n * 60n * 1000000n;

  let lineCount = 0;
  let parsedRows = 0;

  for await (const raw of rl) {
    const line = raw.trimEnd();
    if (!line) continue;

    lineCount++;

    if (!headerParsed) {
      delimiter = detectDelimiter(line);
      const headers = safeSplit(line, delimiter).map(h => h.trim().toLowerCase());

      idxTimestamp = headers.findIndex(h => h === "timestamp");
      idxMessage = headers.findIndex(h => h === "message");

      if (idxTimestamp === -1 || idxMessage === -1) {
        console.error("Não encontrei colunas 'Timestamp' e 'Message' no cabeçalho.");
        console.error("Cabeçalho lido:", line);
        process.exit(1);
      }

      headerParsed = true;
      continue;
    }

    const cols = safeSplit(line, delimiter);
    const ts = (cols[idxTimestamp] ?? "").trim();
    const msg = (cols[idxMessage] ?? "").trim();
    if (!ts || !msg) continue;

    const t = parseTimeToMicros(ts);
    if (t == null) continue;

    parsedRows++;

    if (lastSeen.has(msg)) {
      const prev = lastSeen.get(msg);
      let dt = t - prev;
      if (dt < 0n) dt += DAY;

      let st = stats.get(msg);
      if (!st) {
        st = { count: 0n, min: dt, max: dt, sum: 0n };
        stats.set(msg, st);
      }

      st.count += 1n;
      st.sum += dt;
      if (dt < st.min) st.min = dt;
      if (dt > st.max) st.max = dt;
    }

    lastSeen.set(msg, t);

    if (parsedRows % 1000000 === 0) {
      console.log(`Processadas: ${parsedRows.toString()} linhas válidas...`);
    }
  }

  const entries = Array.from(stats.entries());
  entries.sort((a, b) => {
    const avgA = a[1].sum / a[1].count;
    const avgB = b[1].sum / b[1].count;
    return avgB > avgA ? 1 : avgB < avgA ? -1 : 0;
  });

  console.log("\n=== RESUMO (Δt até a PRÓXIMA ocorrência da MESMA Message) ===");
  console.log(`Linhas lidas (não vazias): ${lineCount}`);
  console.log(`Linhas válidas (Timestamp+Message parseáveis): ${parsedRows}`);
  console.log(`Mensagens com intervalos calculados: ${entries.length}\n`);

  if (entries.length === 0) {
    console.log("Nenhuma mensagem teve ocorrência repetida suficiente para calcular Δt.");
    return;
  }

  for (const [msg, st] of entries) {
    const avg = st.sum / st.count;
    console.log(msg);
    console.log(
      `  N=${st.count.toString()} | min=${formatMicros(st.min)} | media=${formatMicros(avg)} | max=${formatMicros(st.max)}`
    );
  }
}

main().catch(err => {
  console.error("Erro:", err);
  process.exit(1);
});
