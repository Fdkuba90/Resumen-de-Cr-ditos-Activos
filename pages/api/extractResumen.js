// pages/api/extractResumen.js
import { IncomingForm } from "formidable";
import fs from "fs";
import PDFParser from "pdf2json";

export const config = { api: { bodyParser: false } };

/* ======================== UTILIDADES ======================== */
function decodeTxt(t = "") { try { return decodeURIComponent(t); } catch { return t; } }
function normalizeSpaces(s = "") {
  return (s || "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();
}
function pageToRows(page, yTol = 0.35) {
  const rows = [];
  for (const t of page.Texts || []) {
    const text = (t.R || []).map(r => decodeTxt(r.T)).join("");
    if (!text.trim()) continue;
    const y = t.y;
    let row = null;
    for (const r of rows) if (Math.abs(r.y - y) <= yTol) { row = r; break; }
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x: t.x, text });
  }
  rows.sort((a,b) => a.y - b.y);
  for (const r of rows) r.cells.sort((a,b) => a.x - b.x);
  return rows;
}
function parseNumberMX(str) {
  if (str == null) return null;
  let s = String(str).replace(/\u00A0/g, " ").trim();
  s = s.replace(/\s/g, "").replace(/\$/g, "");
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[(),]/g, "");
  if (!s || isNaN(Number(s))) return null;
  const n = Number(s);
  return neg ? -n : n;
}
function detectMilesDePesos(text) { return /(todas las cantidades?.*?en.*?miles de pesos)/i.test(text); }
function textOfRow(row) { return row.cells.map(c => c.text).join(" ").replace(/[ \t]+/g, " ").trim(); }

/* ======================== UBICACIÓN DE LA TABLA ======================== */
function findActivosPage(pdfData) {
  const pages = pdfData.Pages || [];
  for (let p = 0; p < pages.length; p++) {
    const rows = pageToRows(pages[p], 0.35);
    const joined = rows.map(textOfRow).join("\n");
    if (/Cr[ée]ditos Activos/i.test(joined) || (/Original/i.test(joined) && /Vigente/i.test(joined))) {
      return { pageIndex: p, rows };
    }
  }
  return null;
}

/* ======================== EXTRACCIÓN POR COORDENADAS (TOTALES) ======================== */
const HEADER_COLS = [
  { key: "original",   re: /\boriginal\b/i },
  { key: "vigente",    re: /\bvigente\b/i },
  { key: "v1_29",      re: /(1\s*[–-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
  { key: "v30_59",     re: /(30\s*[–-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
  { key: "v60_89",     re: /(60\s*[–-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
  { key: "v90_119",    re: /(90\s*[–-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
  { key: "v120_179",   re: /(120\s*[–-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
  { key: "v180p",      re: /(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i },
];

// Header multi-línea + centros de columna + tolerancia dinámica
function findHeaderConfig(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r0 = rows[i];
    const l0 = textOfRow(r0);
    if (!/original/i.test(l0) || !/vigente/i.test(l0)) continue;

    const merged = { y: r0.y, cells: [...r0.cells] };
    if (rows[i+1] && rows[i+1].y - r0.y < 1.8) merged.cells.push(...rows[i+1].cells);
    if (rows[i+2] && rows[i+2].y - r0.y < 2.6) merged.cells.push(...rows[i+2].cells);
    merged.cells.sort((a,b)=>a.x-b.x);

    const hasDias = merged.cells.some(c => /d[ií]as/i.test(c.text));
    if (!hasDias) continue;

    const colCenters = {};
    for (const col of HEADER_COLS) {
      let best = null;
      for (const c of merged.cells) {
        const txt = c.text.replace(/\s+/g, " ");
        if (col.re.test(txt)) { best = c; break; }
      }
      if (best) colCenters[col.key] = best.x;
    }
    if (colCenters.original == null || colCenters.vigente == null) continue;

    const known = Object.entries(colCenters).sort((a,b)=>a[1]-b[1]);
    const xs = known.map(([,x])=>x);
    const gaps = []; for (let k=1;k<xs.length;k++) gaps.push(xs[k]-xs[k-1]);
    const median = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 4.5;

    const want = ["v1_29","v30_59","v60_89","v90_119","v120_179","v180p"];
    for (const key of want) {
      if (colCenters[key] == null) {
        colCenters[key] = (colCenters.vigente ?? xs[0]) + median * (want.indexOf(key)+1);
      }
    }

    const xsAll = Object.values(colCenters).sort((a,b)=>a-b);
    const medGap = (() => {
      const g=[]; for(let k=1;k<xsAll.length;k++) g.push(xsAll[k]-xsAll[k-1]);
      return g.sort((a,b)=>a-b)[Math.floor(g.length/2)] || 5;
    })();
    const maxDist = Math.max(2.0, medGap * 0.6);

    return { headerRowY: r0.y, colCenters, maxDist };
  }
  return null;
}

// Asigna por cercanía en X; guarda también los números ordenados por X para fallback por orden
function assignRowToColumns(row, colCenters, maxDist) {
  const acc = {
    original: [], vigente: [],
    v1_29: [], v30_59: [], v60_89: [], v90_119: [], v120_179: [], v180p: [],
    hasTotales: false, numericByX: []
  };
  if (row.cells.some(c => /(Total(?:es)?)\s*:?/i.test(c.text))) acc.hasTotales = true;

  for (const c of row.cells) {
    const n = parseNumberMX(c.text);
    if (n === null) continue;
    acc.numericByX.push({ x: c.x, n });

    let bestKey = null, bestDist = Infinity;
    for (const [key, x] of Object.entries(colCenters)) {
      const d = Math.abs(c.x - x);
      if (d < bestDist) { bestDist = d; bestKey = key; }
    }
    if (!bestKey || bestDist > maxDist) continue;
    acc[bestKey].push(n);
  }

  const sum = arr => (arr || []).reduce((a,b)=>a+(Number(b)||0), 0);
  const maxVal = arr => (arr || []).reduce((m,v)=> (m==null || Math.abs(v)>Math.abs(m)) ? v : m, null);

  let original = maxVal(acc.original);
  let vigente  = maxVal(acc.vigente);
  const buckets = {
    v1_29:   sum(acc.v1_29),
    v30_59:  sum(acc.v30_59),
    v60_89:  sum(acc.v60_89),
    v90_119: sum(acc.v90_119),
    v120_179:sum(acc.v120_179),
    v180p:   sum(acc.v180p),
  };

  // -------- Fallback por ORDEN FIJO (8 columnas) --------
  const ordered = acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n); // izquierda -> derecha
  if (ordered.length >= 2) {
    if (original == null || original === 0) original = ordered[0];
    if (vigente  == null || vigente  === 0) vigente  = ordered[1];
  }
  const fillIfZero = (cur, idx) => (cur && cur !== 0) ? cur : (ordered.length > idx ? ordered[idx] : cur);
  // 0:O, 1:V, 2:1-29, 3:30-59, 4:60-89, 5:90-119, 6:120-179, 7:180+
  buckets.v1_29   = fillIfZero(buckets.v1_29,   2);
  buckets.v30_59  = fillIfZero(buckets.v30_59,  3);
  buckets.v60_89  = fillIfZero(buckets.v60_89,  4);
  buckets.v90_119 = fillIfZero(buckets.v90_119, 5);
  buckets.v120_179= fillIfZero(buckets.v120_179,6);
  buckets.v180p   = fillIfZero(buckets.v180p,   7);

  return { original, vigente, buckets, hasTotales: acc.hasTotales };
}

function extractTotalsByCoords(pdfData) {
  const hit = findActivosPage(pdfData);
  if (!hit) return null;
  const { pageIndex } = hit;
  const rows = pageToRows(pdfData.Pages[pageIndex], 0.35);

  const header = findHeaderConfig(rows);
  if (!header) return null;

  const { headerRowY, colCenters, maxDist } = header;
  const startIdx = rows.findIndex(r => Math.abs(r.y - headerRowY) < 1e-6);
  const candidates = rows.slice(startIdx + 1);

  for (const row of candidates) {
    const line = textOfRow(row);
    if (/Resumen Cr[ée]ditos Activos|Cr[ée]ditos Liquidados|INFORMACI[ÓO]N COMERCIAL/i.test(line)) break;
    const mapped = assignRowToColumns(row, colCenters, maxDist);
    if (mapped.hasTotales) {
      return { original: mapped.original, vigente: mapped.vigente, buckets: mapped.buckets };
    }
  }
  return null;
}

/* ======================== “MODO BRIDOVA” (texto robusto) ======================== */
function extractTotalsBridova(allText) {
  const lines = allText.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const idxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(Total(?:es)?)\s*:?/i.test(lines[i])) idxs.push(i);
  }
  if (!idxs.length) return null;

  const tryParseLine = (line) => {
    const raw = (line.match(/[-$()0-9.,]+/g) || []).map(t => t.replace(/[^\d()-]/g, ""));
    const cleaned = raw
      .map(t => t.replace(/[(),]/g, ""))
      .map(t => t.replace(/^0+(\d)/, "$1"))
      .map(t => parseInt(t || "0", 10))
      .filter(n => !Number.isNaN(n));
    if (cleaned.length < 2) return null;
    const take = cleaned.slice(-8);
    while (take.length < 8) take.unshift(0);
    const [original, vigente, b1,b2,b3,b4,b5,b6] = take;
    return {
      original, vigente,
      buckets: { v1_29:b1||0, v30_59:b2||0, v60_89:b3||0, v90_119:b4||0, v120_179:b5||0, v180p:b6||0 }
    };
  };

  for (const i of idxs) {
    const candidates = [
      lines[i],
      lines[i-1] || "",
      lines[i+1] || "",
      ((lines[i-1]||"") + " " + lines[i]).trim(),
      ((lines[i]||"") + " " + (lines[i+1]||"")).trim(),
    ];
    for (const c of candidates) {
      const res = tryParseLine(c);
      if (res) return res;
    }
  }
  return null;
}

/* ======================== FALLBACKS (texto clásico) ======================== */
function extractSingleLabeled(lines, labelRegex) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (labelRegex.test(line)) {
      const nums = line.match(/[-$()0-9.,]+/g);
      if (nums) {
        const candidates = nums.map(parseNumberMX).filter((v) => v !== null);
        if (candidates.length) return candidates[candidates.length - 1];
      }
      for (let k = 1; k <= 3 && i + k < lines.length; k++) {
        const ln = lines[i + k];
        const cand = ln.match(/[-$()0-9.,]+/g);
        if (cand) {
          const vals = cand.map(parseNumberMX).filter((v) => v !== null);
          if (vals.length) return vals[vals.length - 1];
        }
      }
    }
  }
  return null;
}
function extractBuckets(lines) {
  const bucketDefs = [
    { key: "v1_29", re: /(1\s*[–-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
    { key: "v30_59", re: /(30\s*[–-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
    { key: "v60_89", re: /(60\s*[–-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
    { key: "v90_119", re: /(90\s*[–-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
    { key: "v120_179", re: /(120\s*[–-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
    { key: "v180p", re: /(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i },
  ];
  const out = { v1_29: 0, v30_59: 0, v60_89: 0, v90_119: 0, v120_179: 0, v180p: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const b of bucketDefs) {
      if (b.re.test(line)) {
        const nums = line.match(/[-$()0-9.,]+/g);
        if (nums) {
          const candidates = nums.map(parseNumberMX).filter((v) => v !== null);
          if (candidates.length) out[b.key] += candidates[candidates.length - 1] || 0;
        }
      }
    }
  }
  return out;
}

/* ======================== RESPUESTA (TOTALES) ======================== */
function buildResult({ original, vigente, buckets, multiplier, fuente }) {
  const vencido =
    (buckets.v1_29 || 0) +
    (buckets.v30_59 || 0) +
    (buckets.v60_89 || 0) +
    (buckets.v90_119 || 0) +
    (buckets.v120_179 || 0) +
    (buckets.v180p || 0);

  return {
    montoOriginal: original != null ? original * multiplier : null,
    saldoVigente: vigente != null ? vigente * multiplier : null,
    buckets: {
      "1_29":    (buckets.v1_29   || 0) * multiplier,
      "30_59":   (buckets.v30_59  || 0) * multiplier,
      "60_89":   (buckets.v60_89  || 0) * multiplier,
      "90_119":  (buckets.v90_119 || 0) * multiplier,
      "120_179": (buckets.v120_179|| 0) * multiplier,
      "180_mas": (buckets.v180p   || 0) * multiplier,
    },
    saldoVencido: vencido * multiplier,
    saldoTotal: (vigente != null ? vigente * multiplier : 0) + vencido * multiplier,
    unidades: multiplier === 1000 ? "pesos (convertido desde miles)" : "pesos",
    fuente,
  };
}

/* ======================== HISTORIA (serie mensual) ======================== */
// Meses y regex
const MONTHS = { Ene:"01", Feb:"02", Mar:"03", Abr:"04", May:"05", Jun:"06", Jul:"07", Ago:"08", Sep:"09", Oct:"10", Nov:"11", Dic:"12" };
const MES_RE = /\b(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+\d{4}\b/;

function toPeriodo(token) {
  const [mes, anio] = token.trim().split(/\s+/);
  const mm = MONTHS[mes];
  if (!mm) return null;
  return `${anio}-${mm}`;
}
function parseCalifTokens(text) {
  if (!text) return [];
  const t = (text.match(/\b\d+[A-Z]{1,3}\d?\b/g) || []);
  return t;
}
function nearestNumberAtX(row, x, tol = 2.5) {
  let best = null, bestDist = Infinity;
  for (const c of row.cells) {
    const n = parseNumberMX(c.text);
    if (n == null) continue;
    const d = Math.abs(c.x - x);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return bestDist <= tol ? best : 0;
}
function nearestTextAtX(row, x, tol = 2.8) {
  let best = null, bestDist = Infinity;
  for (const c of row.cells) {
    const d = Math.abs(c.x - x);
    if (d < bestDist) { bestDist = d; best = c.text; }
  }
  return bestDist <= tol ? best : "";
}

// Detecta bloques de encabezado de meses y mapea las 6 filas siguientes (vigente, 4 buckets, calificación)
function extractHistoriaFromPdf(pdfData) {
  const pages = pdfData.Pages || [];
  const map = new Map(); // periodo -> rec

  for (const pg of pages) {
    const rows = pageToRows(pg, 0.35);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const monthCells = r.cells.filter(c => MES_RE.test(c.text));
      if (!monthCells.length) continue;

      // Columnas de meses detectadas en esta banda
      const months = monthCells
        .map(c => ({ x: c.x, label: c.text.trim(), periodo: toPeriodo(c.text.trim()) }))
        .filter(m => !!m.periodo)
        .sort((a,b)=>a.x-b.x);

      // Tolerancia horizontal basada en distancia mediana entre meses
      const gaps = []; for (let k = 1; k < months.length; k++) gaps.push(months[k].x - months[k-1].x);
      const tol = Math.max(2.2, (gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 6) * 0.45);

      // Buscar filas de métricas cerca
      const metrics = { vigente:null, v1_29:null, v30_59:null, v60_89:null, v90_mas:null, calif:null };
      for (let j = i + 1; j < Math.min(i + 12, rows.length); j++) {
        const line = textOfRow(rows[j]);
        if (MES_RE.test(line)) break; // nuevo bloque de meses
        if (!metrics.vigente && /\bVigente\b/i.test(line)) metrics.vigente = rows[j];
        else if (!metrics.v1_29 && /Vencido.*(1\s*a\s*29|1\s*[–-]\s*29)\s*d[ií]as?/i.test(line)) metrics.v1_29 = rows[j];
        else if (!metrics.v30_59 && /Vencido.*(30\s*a\s*59|30\s*[–-]\s*59)\s*d[ií]as?/i.test(line)) metrics.v30_59 = rows[j];
        else if (!metrics.v60_89 && /Vencido.*(60\s*a\s*89|60\s*[–-]\s*89)\s*d[ií]as?/i.test(line)) metrics.v60_89 = rows[j];
        else if (!metrics.v90_mas && /(Vencido.*(m[aá]s\s*de\s*89|90\+|89\+))|Vencido.*(90\s*y\s*m[aá]s)/i.test(line)) metrics.v90_mas = rows[j];
        else if (!metrics.calif && /Calificaci[oó]n de Cartera/i.test(line)) metrics.calif = rows[j];
      }

      // Armar registros por mes
      for (const m of months) {
        const rec = {
          periodo: m.periodo,
          vigente: metrics.vigente ? nearestNumberAtX(metrics.vigente, m.x, tol) : 0,
          venc_1_29: metrics.v1_29 ? nearestNumberAtX(metrics.v1_29, m.x, tol) : 0,
          venc_30_59: metrics.v30_59 ? nearestNumberAtX(metrics.v30_59, m.x, tol) : 0,
          venc_60_89: metrics.v60_89 ? nearestNumberAtX(metrics.v60_89, m.x, tol) : 0,
          venc_90_mas: metrics.v90_mas ? nearestNumberAtX(metrics.v90_mas, m.x, tol) : 0,
          calificacion_cartera: metrics.calif ? parseCalifTokens(nearestTextAtX(metrics.calif, m.x, Math.max(2.8, tol))) : [],
          total_mes: 0,
          sin_atrasos: true
        };
        const venc = (rec.venc_1_29||0)+(rec.venc_30_59||0)+(rec.venc_60_89||0)+(rec.venc_90_mas||0);
        rec.total_mes = (rec.vigente||0) + venc;
        rec.sin_atrasos = venc === 0;

        // Guardar último valor si el mes aparece dos veces en la página (bloques apilados)
        map.set(rec.periodo, rec);
      }
    }
  }

  // Ordenar por periodo ascendente
  const out = Array.from(map.values()).sort((a,b)=>a.periodo.localeCompare(b.periodo));
  return out;
}

function applyMultiplierHistoria(rows, multiplier) {
  return (rows || []).map(r => ({
    ...r,
    vigente: (r.vigente || 0) * multiplier,
    venc_1_29: (r.venc_1_29 || 0) * multiplier,
    venc_30_59: (r.venc_30_59 || 0) * multiplier,
    venc_60_89: (r.venc_60_89 || 0) * multiplier,
    venc_90_mas: (r.venc_90_mas || 0) * multiplier,
    total_mes: (r.total_mes || 0) * multiplier
  }));
}

function computeKPIsHistoria(rows) {
  if (!rows?.length) {
    return {
      mesesConAtraso: 0,
      peorBucket: "sin datos",
      mesPeorBucket: null,
      ratiosVencidoSobreVigente: [],
      sumasPorBucket: { "1_29":0, "30_59":0, "60_89":0, "90_mas":0 },
      mesesDesdeUltimo90mas: null
    };
  }
  const last12 = rows.slice(-12);
  const mesesConAtraso = last12.filter(r => (r.venc_1_29+r.venc_30_59+r.venc_60_89+r.venc_90_mas) > 0).length;

  let worstLevel = -1, peorBucket = "sin atraso", mesPeorBucket = null;
  function level(r){
    return r.venc_90_mas>0?4:r.venc_60_89>0?3:r.venc_30_59>0?2:r.venc_1_29>0?1:0;
  }
  for (const r of last12) {
    const lv = level(r);
    if (lv > worstLevel) { worstLevel = lv; peorBucket = lv===4?"90+":lv===3?"60-89":lv===2?"30-59":lv===1?"1-29":"sin atraso"; mesPeorBucket = r.periodo; }
  }

  const ratiosVencidoSobreVigente = last12.map(r => ({
    periodo: r.periodo,
    ratio: r.vigente ? Math.round(((r.venc_1_29+r.venc_30_59+r.venc_60_89+r.venc_90_mas)/r.vigente)*10000)/100 : null
  }));

  const sumasPorBucket = last12.reduce((acc,r)=>({
    "1_29": acc["1_29"] + (r.venc_1_29||0),
    "30_59": acc["30_59"] + (r.venc_30_59||0),
    "60_89": acc["60_89"] + (r.venc_60_89||0),
    "90_mas": acc["90_mas"] + (r.venc_90_mas||0)
  }), { "1_29":0, "30_59":0, "60_89":0, "90_mas":0 });

  let mesesDesdeUltimo90mas = null;
  for (let i = last12.length - 1; i >= 0; i--) {
    if (last12[i].venc_90_mas > 0) { mesesDesdeUltimo90mas = last12.length - 1 - i; break; }
  }

  return { mesesConAtraso, peorBucket, mesPeorBucket, ratiosVencidoSobreVigente, sumasPorBucket, mesesDesdeUltimo90mas };
}

/* ======================== HANDLER ======================== */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  const form = new IncomingForm({ multiples: false, keepExtensions: true });
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: "No se pudo leer el formulario", detalle: String(err) });

    const onlyTotals = String(fields.onlyTotals || "").toLowerCase() === "true";
    const file = files.file || files.pdf || files.upload || null;
    if (!file) return res.status(400).json({ error: "Falta el archivo PDF (campo 'file')" });

    const pdfPath = Array.isArray(file) ? file[0].filepath : file.filepath;
    let pdfBuffer;
    try { pdfBuffer = fs.readFileSync(pdfPath); }
    catch { return res.status(400).json({ error: "No se pudo leer el archivo subido" }); }

    const pdfParser = new PDFParser(this, 1);

    pdfParser.on("pdfParser_dataError", (e) => {
      console.error("pdf2json error:", e?.parserError || e);
      return res.status(500).json({ error: "Error al procesar el PDF" });
    });

    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      try {
        const allText = normalizeSpaces(
          (pdfData.Pages || []).map(p => pageToRows(p).map(textOfRow).join("\n")).join("\n")
        );
        const multiplier = detectMilesDePesos(allText) ? 1000 : 1;

        // ===== Totales (misma lógica de antes) =====
        let payload = null;

        const totalsCoords = extractTotalsByCoords(pdfData);
        if (totalsCoords) {
          payload = buildResult({
            original: totalsCoords.original,
            vigente: totalsCoords.vigente,
            buckets: totalsCoords.buckets,
            multiplier,
            fuente: "Totales de Créditos Activos (por coordenadas)",
          });
        } else {
          const totalsBridova = extractTotalsBridova(allText);
          if (totalsBridova) {
            payload = buildResult({
              original: totalsBridova.original,
              vigente: totalsBridova.vigente,
              buckets: totalsBridova.buckets,
              multiplier,
              fuente: "Totales (modo Bridova)",
            });
          } else if (onlyTotals) {
            // Si el cliente pidió solo totales, no seguimos con historia.
            return res.status(422).json({ ok: false, error: "No se encontró la fila 'Totales' en Créditos Activos." });
          } else {
            // Fallback por etiquetas
            const lines = allText.split(/\n+/).map(s => s.trim()).filter(Boolean);
            const original = extractSingleLabeled(lines, /\boriginal\b/i);
            const vigente  = extractSingleLabeled(lines, /\bvigente\b/i);
            const buckets  = extractBuckets(lines);
            payload = buildResult({ original, vigente, buckets, multiplier, fuente: "Fallback por etiquetas (texto)" });
          }
        }

        // ===== Historia (nuevo) =====
        const histRaw = extractHistoriaFromPdf(pdfData);
        const historia = applyMultiplierHistoria(histRaw, multiplier);
        const kpisHistoria = computeKPIsHistoria(historia);

        return res.status(200).json({
          ok: true,
          meta: { milesDePesosDetectado: multiplier === 1000 },
          data: payload,
          historia,
          kpisHistoria
        });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Fallo al extraer los datos", detalle: String(e) });
      }
    });

    pdfParser.parseBuffer(pdfBuffer);
  });
}
