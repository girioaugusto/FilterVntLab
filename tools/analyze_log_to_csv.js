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
  return line.split(delimiter);
}

async function main() {
  const filePath = process.argv[2];
  const outPath = process.argv[3] || "deltas_output.csv";

  if (!filePath) {
    console.log("Uso: node tools/analyze_log_to_csv.js <arquivo.csv/txt> [saida.csv]");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error("Arquivo não encontrado:", filePath);
    process.exit(1);
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const out = fs.createWriteStream(outPath, { encoding: "utf8" });
  out.write("Message,PrevTimestamp,CurrTimestamp,Delta(HH:MM:SS.ffffff),DeltaMicros\n");

  let delimiter = null;
  let idxTimestamp = -1;
  let idxMessage = -1;
  let headerParsed = false;

  const lastSeen = new Map(); // msg -> {tMicros, tsStr}
  const DAY = 24n * 60n * 60n * 1000000n;

  let parsedRows = 0;
  let deltaCount = 0;

  for await (const raw of rl) {
    const line = raw.trimEnd();
    if (!line) continue;

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
      let dt = t - prev.tMicros;
      if (dt < 0n) dt += DAY;

      // CSV (escapa aspas)
      const msgCsv = `"${msg.replaceAll('"', '""')}"`;
      const prevTsCsv = `"${prev.tsStr.replaceAll('"', '""')}"`;
      const tsCsv = `"${ts.replaceAll('"', '""')}"`;

      out.write(`${msgCsv},${prevTsCsv},${tsCsv},${formatMicros(dt)},${dt.toString()}\n`);
      deltaCount++;
    }

    lastSeen.set(msg, { tMicros: t, tsStr: ts });

    if (parsedRows % 1000000 === 0) {
      console.log(`Processadas: ${parsedRows.toString()} | deltas gerados: ${deltaCount.toString()}`);
    }
  }

  out.end();
  console.log(`\n✅ Finalizado! Linhas válidas: ${parsedRows} | deltas gerados: ${deltaCount}`);
  console.log(`✅ Arquivo de saída: ${outPath}`);
}

main().catch(err => {
  console.error("Erro:", err);
  process.exit(1);
});
