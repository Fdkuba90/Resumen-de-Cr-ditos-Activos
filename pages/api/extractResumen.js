// pages/api/extractResumen.js
import { IncomingForm } from "formidable";
import fs from "fs";
import PDFParser from "pdf2json";

export const config = { api: { bodyParser: false } };

/* ======================== Utilidades ======================== */
function decodeTxt(t = "") { try { return decodeURIComponent(t); } catch { return t; } }
function normalizeSpaces(s = "") { return (s || "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim(); }
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
function parseNumberLoose(str) { const m = String(str||"").match(/[-$()0-9.,]+/); return m ? parseNumberMX(m[0]) : null; }
function detectMilesDePesos(text) { return /(todas las cantidades?.*?en.*?miles de pesos)/i.test(text); }

/* ======================== Rows & tokens ======================== */
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
function tokensOfPage(pg) {
  const out = [];
  for (const t of (pg.Texts || [])) {
    const text = (t.R || []).map(r => decodeTxt(r.T)).join("");
    if (!text.trim()) continue;
    out.push({ x: t.x, y: t.y, text });
  }
  return out;
}
function textOfRow(row) { return row.cells.map(c => c.text).join(" ").replace(/[ \t]+/g, " ").trim(); }

/* ======================== TOTALES (igual que antes) ======================== */
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
      for (const c of merged.cells) {
        const txt = c.text.replace(/\s+/g, " ");
        if (col.re.test(txt)) { colCenters[col.key] = c.x; break; }
      }
    }
    if (colCenters.original == null || colCenters.vigente == null) continue;
    const xsAll = Object.values(colCenters).sort((a,b)=>a-b);
    const g=[]; for(let k=1;k<xsAll.length;k++) g.push(xsAll[k]-xsAll[k-1]);
    const medGap = g.sort((a,b)=>a-b)[Math.floor(g.length/2)] || 5;
    const maxDist = Math.max(2.0, medGap * 0.6);
    return { headerRowY: r0.y, colCenters, maxDist };
  }
  return null;
}
function assignRowToColumns(row, colCenters, maxDist) {
  const acc = {
    original: [], vigente: [],
    v1_29: [], v30_59: [], v60_89: [], v90_119: [], v120_179: [], v180p: [],
    hasTotales: false, numericByX: []
  };
  if (row.cells.some(c => /(Total(?:es)?)\s*:?/i.test(c.text))) acc.hasTotales = true;
  for (const c of row.cells) {
    const n = parseNumberLoose(c.text);
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
  const ordered = acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n);
  if (ordered.length >= 2) {
    if (original == null || original === 0) original = ordered[0];
    if (vigente  == null || vigente  === 0) vigente  = ordered[1];
  }
  const fillIfZero = (cur, idx) => (cur && cur !== 0) ? cur : (ordered.length > idx ? ordered[idx] : cur);
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
function extractTotalsBridova(allText) {
  const lines = allText.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const idxs = [];
  for (let i = 0; i < lines.length; i++) if (/(Total(?:es)?)\s*:?/i.test(lines[i])) idxs.push(i);
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
    return { original, vigente,
      buckets: { v1_29:b1||0, v30_59:b2||0, v60_89:b3||0, v90_119:b4||0, v120_179:b5||0, v180p:b6||0 } };
  };
  for (const i of idxs) {
    const candidates = [
      lines[i], lines[i-1] || "", lines[i+1] || "",
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

/* ======================== HISTORIA: filas por periodo (coordenadas fijas) ======================== */
const PERIOD_RE = /\b(20\d{2})\s*[–-]\s*(0[1-9]|1[0-2])\b/; // 2025-03 / 2025–03
const HCOLS = [
  { key: "periodo", re: /\bPeriodo\b/i },
  { key: "vigente", re: /\bVigente\b/i },
  { key: "b129",    re: /1\s*[–-]\s*29\b/ },
  { key: "b3059",   re: /30\s*[–-]\s*59\b/ },
  { key: "b6089",   re: /60\s*[–-]\s*89\b/ },
  { key: "b90m",    re: /90\+\b/ },
  { key: "total",   re: /\bTotal\s*mes\b/i },
  { key: "calif",   re: /Calificaci[oó]n de Cartera/i },
];

function findHistoriaHeader(pdfData) {
  for (let p = 0; p < (pdfData.Pages || []).length; p++) {
    const pg = pdfData.Pages[p];
    const rows = pageToRows(pg, 0.35);
    for (let i = 0; i < rows.length; i++) {
      const line = textOfRow(rows[i]);
      if (!/Periodo/i.test(line) || !/Calificaci[oó]n de Cartera/i.test(line)) continue;

      // Mezcla header+subheader si estuvieran en dos líneas (guiones, etc.)
      const merged = { y: rows[i].y, cells: [...rows[i].cells] };
      if (rows[i+1] && rows[i+1].y - rows[i].y < 1.5) merged.cells.push(...rows[i+1].cells);

      const colX = {};
      for (const def of HCOLS) {
        const hit = merged.cells.find(c => def.re.test(c.text));
        if (hit) colX[def.key] = hit.x;
      }
      // necesitamos al menos periodo, vigente y calif para confiar
      if (colX.periodo == null || colX.vigente == null || colX.calif == null) continue;

      // ordenados por X para límites
      const order = Object.entries(colX).sort((a,b)=>a[1]-b[1]);
      const xs = order.map(([,x])=>x);
      const gaps = []; for (let j=1;j<xs.length;j++) gaps.push(xs[j]-xs[j-1]);
      const medGap = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 6;

      // construir ventanas [left,right] por columna
      const bounds = {};
      const keysByX = order.map(([k])=>k);
      for (let j=0;j<keysByX.length;j++) {
        const key = keysByX[j];
        const x = colX[key];
        const left = j===0 ? x - medGap*0.6 : (x + colX[keysByX[j-1]])/2;
        const right = j===keysByX.length-1 ? x + medGap*0.9 : (x + colX[keysByX[j+1]])/2;
        bounds[key] = { left, right, x };
      }

      return { pageIndex: p, headerIndex: i, rows, pg, bounds };
    }
  }
  return null;
}

function tokensInBand(tokens, yCenter, yTol) {
  return tokens.filter(t => Math.abs(t.y - yCenter) <= yTol).sort((a,b)=>a.x-b.x);
}
function numberFromWindow(tokensRow, left, right) {
  const inWin = tokensRow.filter(t => t.x >= left && t.x <= right);
  if (!inWin.length) return 0;
  const joined = inWin.map(t=>t.text).join("");
  const m = joined.match(/[-$()0-9.,]+/g);
  if (m && m.length) {
    const chosen = m.reduce((best,cur)=> (cur.length >= best.length ? cur : best), "");
    const n = parseNumberMX(chosen);
    if (n != null) return n;
  }
  // si no, sumar piezas numéricas
  let sum = 0, found=false;
  for (const t of inWin) {
    const n = parseNumberLoose(t.text);
    if (n!=null) { sum += n; found = true; }
  }
  return found ? sum : 0;
}
function textFromWindow(tokensRow, left, right) {
  return tokensRow.filter(t => t.x >= left && t.x <= right).map(t=>t.text).join(" ").replace(/\s+/g," ").trim();
}

function extractHistoriaByRowGrid(pdfData) {
  const hit = findHistoriaHeader(pdfData);
  if (!hit) return [];
  const { pageIndex, headerIndex, rows, pg, bounds } = hit;

  const tokens = tokensOfPage(pg);
  const out = new Map();

  // tolerancia vertical (las filas están bastante alineadas en Buró)
  const yTol = 0.9;

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    const line = textOfRow(r);
    // cortar si empieza otra sección
    if (/Cr[ée]ditos Liquidados|INFORMACI[ÓO]N COMERCIAL|Resumen/i.test(line)) break;

    // detectar periodo (en toda la fila o, preferentemente, en la ventana Periodo)
    let periodo = null;
    const fromWin = textFromWindow(tokensInBand(tokens, r.y, yTol), bounds.periodo.left, bounds.periodo.right);
    const m1 = fromWin.match(PERIOD_RE) || line.match(PERIOD_RE);
    if (m1) periodo = `${m1[1]}-${m1[2]}`;
    if (!periodo) continue; // no es una fila de datos

    const bandToks = tokensInBand(tokens, r.y, yTol);

    const vigente = numberFromWindow(bandToks, bounds.vigente.left, bounds.vigente.right);
    const b129    = bounds.b129    ? numberFromWindow(bandToks, bounds.b129.left, bounds.b129.right) : 0;
    const b3059   = bounds.b3059   ? numberFromWindow(bandToks, bounds.b3059.left, bounds.b3059.right) : 0;
    const b6089   = bounds.b6089   ? numberFromWindow(bandToks, bounds.b6089.left, bounds.b6089.right) : 0;
    const b90m    = bounds.b90m    ? numberFromWindow(bandToks, bounds.b90m.left, bounds.b90m.right) : 0;
    const total   = bounds.total   ? numberFromWindow(bandToks, bounds.total.left, bounds.total.right) : (vigente + b129 + b3059 + b6089 + b90m);

    const calTxt  = bounds.calif ? textFromWindow(bandToks, bounds.calif.left, bounds.calif.right) : "";
    const calTokens = (calTxt.match(/\b\d+[A-Z]{1,3}\d?\b/g) || []);

    out.set(periodo, {
      periodo,
      vigente,
      venc_1_29: b129,
      venc_30_59: b3059,
      venc_60_89: b6089,
      venc_90_mas: b90m,
      total_mes: total,
      calificacion_cartera: calTokens,
      sin_atrasos: (b129 + b3059 + b6089 + b90m) === 0
    });
  }

  return Array.from(out.values()).sort((a,b)=>a.periodo.localeCompare(b.periodo));
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
  const level = (r)=> r.venc_90_mas>0?4:r.venc_60_89>0?3:r.venc_30_59>0?2:r.venc_1_29>0?1:0;
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
  for (let i = last12.length - 1; i >= 0; i--) if (last12[i].venc_90_mas > 0) { mesesDesdeUltimo90mas = last12.length - 1 - i; break; }

  return { mesesConAtraso, peorBucket, mesPeorBucket, ratiosVencidoSobreVigente, sumasPorBucket, mesesDesdeUltimo90mas };
}

/* ======================== Handler ======================== */
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

        // ===== TOTALES =====
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
            return res.status(422).json({ ok: false, error: "No se encontró la fila 'Totales' en Créditos Activos." });
          } else {
            const lines = allText.split(/\n+/).map(s => s.trim()).filter(Boolean);
            const original = extractSingleLabeled(lines, /\boriginal\b/i);
            const vigente  = extractSingleLabeled(lines, /\bvigente\b/i);
            const buckets  = extractBuckets(lines);
            payload = buildResult({ original, vigente, buckets, multiplier, fuente: "Fallback por etiquetas (texto)" });
          }
        }

        // ===== HISTORIA (filas por periodo) =====
        const histRaw = extractHistoriaByRowGrid(pdfData);
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
