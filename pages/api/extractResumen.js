// pages/api/extractResumen.js
import { IncomingForm } from "formidable";
import fs from "fs";
import PDFParser from "pdf2json";

export const config = { api: { bodyParser: false } };

/* ======================== UTILIDADES BÁSICAS ======================== */
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

/* ======================== FILAS (para localizar secciones) ======================== */
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
function textOfRow(row) { return row.cells.map(c => c.text).join(" ").replace(/[ \t]+/g, " ").trim(); }

/* ======================== UBICACIÓN "CRÉDITOS ACTIVOS" (Totales) ======================== */
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

/* ======================== TOTALES POR COORDENADAS ======================== */
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
      for (const c of merged.cells) {
        const txt = c.text.replace(/\s+/g, " ");
        if (col.re.test(txt)) { colCenters[col.key] = c.x; break; }
      }
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

/* ======================== TOTALES “BRIDOVA” (texto) ======================== */
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

/* ======================== FALLBACKS (texto) ======================== */
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

/* ======================== RESPUESTA TOTALES ======================== */
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

/* ======================== HISTORIA (1: nearest 1↔1, 3: autocal, 5: cruce Total) ======================== */
const MONTHS = { Ene:"01", Feb:"02", Mar:"03", Abr:"04", May:"05", Jun:"06", Jul:"07", Ago:"08", Sep:"09", Oct:"10", Nov:"11", Dic:"12" };
const MES_RE = /\b(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+\d{4}\b/;
const ROW_LABELS = {
  vigente: /\bVigente\b/i,
  v1_29: /Vencido.*(1\s*a\s*29|1\s*[–-]\s*29)\s*d[ií]as?/i,
  v30_59: /Vencido.*(30\s*a\s*59|30\s*[–-]\s*59)\s*d[ií]as?/i,
  v60_89: /Vencido.*(60\s*a\s*89|60\s*[–-]\s*89)\s*d[ií]as?/i,
  v90_mas: /(Vencido.*(m[aá]s\s*de\s*89|90\+|89\+))|Vencido.*(90\s*y\s*m[aá]s)/i,
  totalMes: /\bTotal\s*mes\b/i,
  calif: /Calificaci[oó]n de Cartera/i,
};

function toPeriodo(token) { const [mes, anio] = token.trim().split(/\s+/); const mm = MONTHS[mes]; return mm ? `${anio}-${mm}` : null; }
function tokensOfPage(pg) {
  const out = [];
  for (const t of (pg.Texts || [])) {
    const text = (t.R || []).map(r => decodeTxt(r.T)).join("");
    if (!text.trim()) continue;
    out.push({ x: t.x, y: t.y, text });
  }
  return out;
}
function centersFromMonths(row) {
  const months = row.cells
    .filter(c => MES_RE.test(c.text))
    .map(c => ({ x: c.x, periodo: toPeriodo(c.text.trim()) }))
    .filter(m => !!m.periodo)
    .sort((a,b)=>a.x-b.x);
  const centers = months.map(m => m.x);
  const gap = centers.length > 1
    ? centers.slice(1).reduce((a,x,i)=>a+(x-centers[i]),0)/(centers.length-1)
    : 6;
  return { months, centers, avgGap: gap };
}

// agrupa tokens horizontales y devuelve “números consolidados” con su X promedio
function numericGroupsInBand(allTokens, yCenter, yTol = 1.6, groupDx = 1.0) {
  const band = allTokens.filter(t => Math.abs(t.y - yCenter) <= yTol).sort((a,b)=>a.x-b.x);
  const groups = [];
  for (const t of band) {
    const last = groups[groups.length-1];
    if (!last || (t.x - last._lastX) > groupDx) groups.push({ _lastX: t.x, tokens:[t] });
    else { last.tokens.push(t); last._lastX = t.x; }
  }
  const out = [];
  for (const g of groups) {
    const joined = g.tokens.map(t=>t.text).join("");
    const parts = joined.match(/[-$()0-9.,]+/g);
    if (!parts || !parts.length) continue;
    const chosen = parts.reduce((best,cur)=> (cur.length >= best.length ? cur : best), "");
    const n = parseNumberMX(chosen);
    if (n == null) continue;
    const x = g.tokens.reduce((a,t)=>a+t.x,0)/g.tokens.length;
    out.push({ x, n });
  }
  return out;
}

// 1) Asignación por centro más cercano PERO 1↔1 (cada token a lo sumo una columna)
function assignNearestUnique(consolTokens, centers, maxFrac = 0.85, avgGap = 6) {
  const maxDx = (avgGap || 6) * maxFrac;
  // construir pares (token, centro) con distancia y ordenar por distancia asc
  const pairs = [];
  consolTokens.forEach((t, ti) => {
    centers.forEach((cx, ci) => {
      const d = Math.abs(t.x - cx);
      if (d <= maxDx) pairs.push({ ti, ci, d });
    });
  });
  pairs.sort((a,b)=> a.d - b.d);

  const usedToken = new Set(), usedCol = new Set();
  const assign = new Array(centers.length).fill(null);
  for (const p of pairs) {
    if (usedToken.has(p.ti) || usedCol.has(p.ci)) continue;
    usedToken.add(p.ti); usedCol.add(p.ci);
    assign[p.ci] = consolTokens[p.ti];
  }
  const values = centers.map((_,ci) => assign[ci] ? { value: assign[ci].n, used: assign[ci], delta: (assign[ci].x - centers[ci]) } : { value: 0, used: null, delta: 0 });
  return values;
}

// 3) Auto-calibración: usa la mediana del sesgo de Vigente
function autoCalibrate(centers, valoresVigente, avgGap) {
  const deltas = valoresVigente.map(v => (v && v.used ? v.delta : null)).filter(v => v != null);
  if (deltas.length < 3) return centers;
  const sorted = [...deltas].sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length/2)];
  const limit = (avgGap || 6) * 0.35;
  if (Math.abs(median) < (avgGap * 0.12)) return centers;
  const shift = Math.max(-limit, Math.min(limit, median));
  return centers.map(x => x + shift);
}

// 5) Cruce con “Total mes”: busca el micro-shift que minimiza el error
function refineShiftWithTotals(centers, avgGap, toks, yCenters, yTol) {
  if (yCenters.totalMes == null) return centers;
  const totalsPDF = assignNearestUnique(
    numericGroupsInBand(toks, yCenters.totalMes, yTol), centers, 0.9, avgGap
  ).map(v => v.value);

  const step = (avgGap || 6) * 0.06;
  const limit = (avgGap || 6) * 0.28;
  let best = centers, bestErr = Infinity;

  for (let s = -limit; s <= limit + 1e-6; s += step) {
    const C = centers.map(x=>x+s);
    const vV = assignNearestUnique(numericGroupsInBand(toks, yCenters.vigente, yTol), C, 0.9, avgGap).map(v=>v.value);
    const vA = yCenters.v1_29!=null ? assignNearestUnique(numericGroupsInBand(toks, yCenters.v1_29, yTol), C, 0.9, avgGap).map(v=>v.value) : C.map(()=>0);
    const vB = yCenters.v30_59!=null? assignNearestUnique(numericGroupsInBand(toks, yCenters.v30_59, yTol),C,0.9,avgGap).map(v=>v.value): C.map(()=>0);
    const vC = yCenters.v60_89!=null? assignNearestUnique(numericGroupsInBand(toks, yCenters.v60_89, yTol),C,0.9,avgGap).map(v=>v.value): C.map(()=>0);
    const vD = yCenters.v90_mas!=null? assignNearestUnique(numericGroupsInBand(toks, yCenters.v90_mas, yTol),C,0.9,avgGap).map(v=>v.value): C.map(()=>0);
    const totalsCalc = C.map((_,i)=>(vV[i]||0)+(vA[i]||0)+(vB[i]||0)+(vC[i]||0)+(vD[i]||0));
    const diffs = totalsPDF.map((pdf,i)=> Math.abs((pdf||0) - (totalsCalc[i]||0)));
    const medErr = diffs.slice().sort((a,b)=>a-b)[Math.floor(diffs.length/2)] || 0;
    if (medErr < bestErr) { bestErr = medErr; best = C; }
  }
  return best;
}

function extractHistoria(pdfData) {
  const out = new Map();

  for (const pg of (pdfData.Pages || [])) {
    const rows = pageToRows(pg, 0.35);
    const toks = tokensOfPage(pg);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.cells.filter(c=>MES_RE.test(c.text)).length < 2) continue;

      const months = r.cells
        .filter(c => MES_RE.test(c.text))
        .map(c => ({ x: c.x, periodo: toPeriodo(c.text.trim()) }))
        .filter(m => !!m.periodo)
        .sort((a,b)=>a.x-b.x);
      if (!months.length) continue;

      const centers = months.map(m => m.x);
      const avgGap = centers.length>1 ? centers.slice(1).reduce((a,x,idx)=>a+(x-centers[idx]),0)/(centers.length-1) : 6;

      // localizar y de rótulos
      const yCenters = { vigente:null, v1_29:null, v30_59:null, v60_89:null, v90_mas:null, totalMes:null, calif:null };
      for (let j = i + 1; j < Math.min(rows.length, i + 24); j++) {
        const line = textOfRow(rows[j]);
        if (MES_RE.test(line)) break;
        if (yCenters.vigente==null   && ROW_LABELS.vigente.test(line))  yCenters.vigente = rows[j].y;
        else if (yCenters.v1_29==null   && ROW_LABELS.v1_29.test(line)) yCenters.v1_29 = rows[j].y;
        else if (yCenters.v30_59==null  && ROW_LABELS.v30_59.test(line))yCenters.v30_59 = rows[j].y;
        else if (yCenters.v60_89==null  && ROW_LABELS.v60_89.test(line))yCenters.v60_89 = rows[j].y;
        else if (yCenters.v90_mas==null && ROW_LABELS.v90_mas.test(line))yCenters.v90_mas = rows[j].y;
        else if (yCenters.totalMes==null&& ROW_LABELS.totalMes.test(line))yCenters.totalMes = rows[j].y;
        else if (yCenters.calif==null   && ROW_LABELS.calif.test(line))  yCenters.calif = rows[j].y;
      }
      if (!yCenters.vigente) continue;

      // tolerancia vertical amplia y fija (funciona mejor en reportes Buró)
      const yTol = 1.8;

      // 1) nearest 1↔1 con centros crudos
      const vig0 = assignNearestUnique(numericGroupsInBand(toks, yCenters.vigente, yTol), centers, 0.9, avgGap);

      // 3) autocalibración por sesgo de “Vigente”
      const centersCal = autoCalibrate(centers, vig0, avgGap);

      // 5) cruce con “Total mes”
      const C = refineShiftWithTotals(centersCal, avgGap, toks, yCenters, yTol);

      // asignación final (todas las bandas)
      const vV = assignNearestUnique(numericGroupsInBand(toks, yCenters.vigente, yTol), C, 0.9, avgGap).map(v=>v.value);
      const vA = yCenters.v1_29!=null ? assignNearestUnique(numericGroupsInBand(toks, yCenters.v1_29, yTol), C, 0.9, avgGap).map(v=>v.value) : C.map(()=>0);
      const vB = yCenters.v30_59!=null? assignNearestUnique(numericGroupsInBand(toks, yCenters.v30_59, yTol),C,0.9,avgGap).map(v=>v.value): C.map(()=>0);
      const vC = yCenters.v60_89!=null? assignNearestUnique(numericGroupsInBand(toks, yCenters.v60_89, yTol),C,0.9,avgGap).map(v=>v.value): C.map(()=>0);
      const vD = yCenters.v90_mas!=null? assignNearestUnique(numericGroupsInBand(toks, yCenters.v90_mas, yTol),C,0.9,avgGap).map(v=>v.value): C.map(()=>0);

      // calificación (texto, por proximidad al centro)
      const calRow = (yCenters.calif!=null) ? toks.filter(t => Math.abs(t.y - yCenters.calif) <= yTol) : [];
      const calByCol = C.map(cx => {
        const near = calRow
          .map(t => ({ t, d: Math.abs(t.x - cx) }))
          .filter(o => o.d <= (avgGap*0.9))
          .sort((a,b)=>a.d-b.d)
          .slice(0,6)
          .map(o=>o.t.text)
          .join(" ");
        return (near.match(/\b\d+[A-Z]{1,3}\d?\b/g) || []);
      });

      for (let k = 0; k < months.length; k++) {
        const periodo = months[k].periodo;
        const vigente = vV[k] || 0;
        const v1_29   = vA[k] || 0;
        const v30_59  = vB[k] || 0;
        const v60_89  = vC[k] || 0;
        const v90_mas = vD[k] || 0;
        const venc = v1_29 + v30_59 + v60_89 + v90_mas;
        out.set(periodo, {
          periodo,
          vigente,
          venc_1_29: v1_29,
          venc_30_59: v30_59,
          venc_60_89: v60_89,
          venc_90_mas: v90_mas,
          total_mes: vigente + venc,
          calificacion_cartera: calByCol[k] || [],
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
        const histRaw = extractHistoria(pdfData);
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
