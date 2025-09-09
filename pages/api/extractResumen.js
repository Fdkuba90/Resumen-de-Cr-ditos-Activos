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
// NUEVO: toma el 1er token numérico aunque esté pegado a letras (p. ej. "42942Vigente")
function parseNumberLoose(str) {
  if (str == null) return null;
  const m = String(str).match(/[-$()0-9.,]+/);
  if (!m) return null;
  return parseNumberMX(m[0]);
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
    for (const key of want) if (colCenters[key] == null) colCenters[key] = (colCenters.vigente ?? xs[0]) + median * (want.indexOf(key)+1);

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
function assignRowToColumns(row, colCenters, maxDist) {
  const acc = {
    original: [], vigente: [],
    v1_29: [], v30_59: [], v60_89: [], v90_119: [], v120_179: [], v180p: [],
    hasTotales: false, numericByX: []
  };
  if (row.cells.some(c => /(Total(?:es)?)\s*:?/i.test(c.text))) acc.hasTotales = true;

  for (const c of row.cells) {
    const n = parseNumberLoose(c.text); // <-- suelto
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

/* ======================== “MODO BRIDOVA” (texto robusto) ======================== */
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

/* ======================== HISTORIA (grid + merge filas + fallback) ======================== */
const MONTHS = { Ene:"01", Feb:"02", Mar:"03", Abr:"04", May:"05", Jun:"06", Jul:"07", Ago:"08", Sep:"09", Oct:"10", Nov:"11", Dic:"12" };
const MES_RE = /\b(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+\d{4}\b/;

const ROW_LABELS = {
  vigente: /\bVigente\b/i,
  v1_29: /Vencido.*(1\s*a\s*29|1\s*[–-]\s*29)\s*d[ií]as?/i,
  v30_59: /Vencido.*(30\s*a\s*59|30\s*[–-]\s*59)\s*d[ií]as?/i,
  v60_89: /Vencido.*(60\s*a\s*89|60\s*[–-]\s*89)\s*d[ií]as?/i,
  v90_mas: /(Vencido.*(m[aá]s\s*de\s*89|90\+|89\+))|Vencido.*(90\s*y\s*m[aá]s)/i,
  calif: /Calificaci[oó]n de Cartera/i,
};

function toPeriodo(token) {
  const [mes, anio] = token.trim().split(/\s+/);
  const mm = MONTHS[mes];
  return mm ? `${anio}-${mm}` : null;
}

// Combina la fila base con vecinas (±N) si |Δy| <= maxDy
function mergeWithNeighbors(rows, baseIdx, span = 2, maxDy = 1.4) {
  const base = rows[baseIdx];
  const merged = { y: base.y, cells: [...base.cells] };
  for (let k = 1; k <= span; k++) {
    const prev = rows[baseIdx - k], next = rows[baseIdx + k];
    if (prev && Math.abs(prev.y - base.y) <= maxDy) merged.cells.push(...prev.cells);
    if (next && Math.abs(next.y - base.y) <= maxDy) merged.cells.push(...next.cells);
  }
  merged.cells.sort((a,b)=>a.x-b.x);
  return merged;
}

// límites por columna; extremos más anchos
function columnBoundaries(xCenters) {
  const xs = [...xCenters].sort((a,b)=>a-b);
  const gaps = []; for (let i = 1; i < xs.length; i++) gaps.push(xs[i]-xs[i-1]);
  const medianGap = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 6;
  const pad = medianGap * 0.6; // ensanchar extremos

  return xs.map((x, idx) => {
    const left  = idx === 0 ? x - pad : (xs[idx-1] + x) / 2;
    const right = idx === xs.length - 1 ? x + pad : (x + xs[idx+1]) / 2;
    return { left, right, center: x };
  });
}

function numsInCell(row, left, right) {
  const nums = [];
  const pieces = [];
  for (const c of row.cells) {
    if (c.x < left || c.x > right) continue;
    pieces.push(c.text);
    const n = parseNumberLoose(c.text); // <-- suelto
    if (n != null) nums.push(n);
  }
  // si viene partido (p.ej. "54" + "300"), intenta concatenar
  if (!nums.length && pieces.length) {
    const concat = pieces.join("").replace(/[^\d()-.,]/g, "");
    const n2 = parseNumberMX(concat);
    if (n2 != null) return n2;
  }
  return nums.length ? nums.reduce((a,b)=>a+b,0) : 0;
}
function textInCell(row, left, right) {
  const parts = [];
  for (const c of row.cells) if (c.x >= left && c.x <= right) parts.push(c.text);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function parseCalifTokens(s) {
  if (!s) return [];
  return (s.match(/\b\d+[A-Z]{1,3}\d?\b/g) || []);
}

// fallback si celda queda 0: número más cercano al centro
function nearestNumberAtX(row, x, tol = 4.0) {
  let best = null, bestDist = Infinity;
  for (const c of row.cells) {
    const n = parseNumberLoose(c.text); // <-- suelto
    if (n == null) continue;
    const d = Math.abs(c.x - x);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return bestDist <= tol ? best : 0;
}

// EXTRACTOR Historia (grid + merge y fallback)
function extractHistoriaByGrid(pdfData) {
  const pages = pdfData.Pages || [];
  const out = new Map(); // periodo -> rec

  for (const pg of pages) {
    const rows = pageToRows(pg, 0.35);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const monthCells = r.cells.filter(c => MES_RE.test(c.text));
      if (monthCells.length < 2) continue;

      const months = monthCells
        .map(c => ({ x: c.x, periodo: toPeriodo(c.text.trim()) }))
        .filter(m => !!m.periodo)
        .sort((a,b)=>a.x-b.x);
      if (!months.length) continue;

      const bounds = columnBoundaries(months.map(m => m.x));

      // localizar índices de filas de métricas
      const mIdx = { vigente:null, v1_29:null, v30_59:null, v60_89:null, v90_mas:null, calif:null };
      for (let j = i + 1; j < Math.min(rows.length, i + 16); j++) {
        const line = textOfRow(rows[j]);
        if (MES_RE.test(line)) break; // nuevo bloque
        if (mIdx.vigente==null && ROW_LABELS.vigente.test(line)) mIdx.vigente = j;
        else if (mIdx.v1_29==null && ROW_LABELS.v1_29.test(line)) mIdx.v1_29 = j;
        else if (mIdx.v30_59==null && ROW_LABELS.v30_59.test(line)) mIdx.v30_59 = j;
        else if (mIdx.v60_89==null && ROW_LABELS.v60_89.test(line)) mIdx.v60_89 = j;
        else if (mIdx.v90_mas==null && ROW_LABELS.v90_mas.test(line)) mIdx.v90_mas = j;
        else if (mIdx.calif==null && ROW_LABELS.calif.test(line)) mIdx.calif = j;
      }

      // merge filas cercanas
      const metrics = {};
      for (const k of Object.keys(mIdx)) {
        metrics[k] = mIdx[k] != null ? mergeWithNeighbors(rows, mIdx[k], 2, 1.4) : null;
      }
      if (!metrics.vigente) continue;

      for (let k = 0; k < months.length; k++) {
        const periodo = months[k].periodo;
        const { left, right, center } = bounds[k];

        let vigente   = numsInCell(metrics.vigente, left, right);
        let v1_29     = metrics.v1_29 ? numsInCell(metrics.v1_29, left, right) : 0;
        let v30_59    = metrics.v30_59 ? numsInCell(metrics.v30_59, left, right) : 0;
        let v60_89    = metrics.v60_89 ? numsInCell(metrics.v60_89, left, right) : 0;
        let v90_mas   = metrics.v90_mas ? numsInCell(metrics.v90_mas, left, right) : 0;

        // fallback por centro si quedó 0
        if (!vigente) vigente = nearestNumberAtX(metrics.vigente, center, 4.0);
        if (!v1_29 && metrics.v1_29) v1_29 = nearestNumberAtX(metrics.v1_29, center, 4.0);
        if (!v30_59 && metrics.v30_59) v30_59 = nearestNumberAtX(metrics.v30_59, center, 4.0);
        if (!v60_89 && metrics.v60_89) v60_89 = nearestNumberAtX(metrics.v60_89, center, 4.0);
        if (!v90_mas && metrics.v90_mas) v90_mas = nearestNumberAtX(metrics.v90_mas, center, 4.0);

        const calTxt    = metrics.calif ? textInCell(metrics.calif, left, right) : "";
        const calTokens = parseCalifTokens(calTxt);

        const venc = (v1_29||0) + (v30_59||0) + (v60_89||0) + (v90_mas||0);
        out.set(periodo, {
          periodo,
          vigente,
          venc_1_29: v1_29,
          venc_30_59: v30_59,
          venc_60_89: v60_89,
          venc_90_mas: v90_mas,
          calificacion_cartera: calTokens,
          total_mes: (vigente||0) + venc,
          sin_atrasos: venc === 0
        });
      }
    }
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

        // ===== Totales =====
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

        // ===== Historia =====
        const histRaw = extractHistoriaByGrid(pdfData);
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
