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
    if (/Cr[ée]ditos Activos/i.test(joined) && /Capital\s*\+\s*Intereses/i.test(joined)) {
      return { pageIndex: p, rows };
    }
  }
  return null;
}

/* ======================== EXTRACCIÓN POR COORDENADAS ======================== */
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

// Busca el header combinando hasta 3 renglones (multi-línea)
function findHeaderConfig(rows) {
  for (let i = 0; i < rows.length; i++) {
    const r0 = rows[i];
    const l0 = textOfRow(r0);
    if (!/original/i.test(l0) || !/vigente/i.test(l0)) continue;

    // Unimos hasta 3 filas contiguas para capturar etiquetas que bajaron de renglón (p.ej. “30–59” y “días”)
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

    // Aseguramos al menos Original/Vigente y algún bucket
    if (colCenters.original == null || colCenters.vigente == null) continue;

    // Si faltan buckets, infiere centros a partir del patrón de espaciado
    const known = Object.entries(colCenters).sort((a,b)=>a[1]-b[1]);
    const xs = known.map(([,x])=>x);
    const gaps = [];
    for (let k=1;k<xs.length;k++) gaps.push(xs[k]-xs[k-1]);
    const median = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 4.5;

    const want = ["v1_29","v30_59","v60_89","v90_119","v120_179","v180p"];
    for (const key of want) {
      if (colCenters[key] == null) {
        // estima: coloca después del último conocido hacia la derecha con gap ~median
        colCenters[key] = xs.length ? (xs[0] + median * (want.indexOf(key)+2)) : (colCenters.vigente + median*(want.indexOf(key)+1));
      }
    }

    const xsAll = Object.values(colCenters).sort((a,b)=>a-b);
    const medGap = (() => {
      const g=[]; for(let k=1;k<xsAll.length;k++) g.push(xsAll[k]-xsAll[k-1]);
      return g.sort((a,b)=>a-b)[Math.floor(g.length/2)] || 5;
    })();
    const maxDist = Math.max(2.0, medGap * 0.6); // tolera header ancho/multilínea

    return { headerRowY: r0.y, colCenters, maxDist };
  }
  return null;
}

// Asigna tokens numéricos a columnas por cercanía en X; con fallback por orden
function assignRowToColumns(row, colCenters, maxDist) {
  const acc = {
    original: [], vigente: [],
    v1_29: [], v30_59: [], v60_89: [], v90_119: [], v120_179: [], v180p: [],
    hasTotales: false, numericByX: []
  };
  if (row.cells.some(c => /Totales\s*:?/i.test(c.text))) acc.hasTotales = true;

  for (const c of row.cells) {
    const n = parseNumberMX(c.text);
    if (n === null) continue;
    acc.numericByX.push({ x: c.x, n });

    let bestKey = null, bestDist = Infinity;
    for (const [key, x] of Object.entries(colCenters)) {
      const d = Math.abs(c.x - x);
      if (d < bestDist) { bestDist = d; bestKey = key; }
    }
    if (!bestKey || bestDist > maxDist) continue; // demasiado lejos

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

  // Fallback por orden de aparición en “Totales”: O, V, 1–29, 30–59, …
  if ((original == null || original === 0) || (vigente == null || vigente === 0) ||
      (buckets.v1_29 === 0 && buckets.v30_59 === 0 && buckets.v60_89 === 0 && buckets.v90_119 === 0 &&
       buckets.v120_179 === 0 && buckets.v180p === 0)) {
    const ordered = acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n);
    if (ordered[0] != null && (original == null || original === 0)) original = ordered[0];
    if (ordered[1] != null && (vigente  == null || vigente  === 0)) vigente  = ordered[1];
    if (ordered[2] != null && buckets.v1_29   === 0) buckets.v1_29   = ordered[2];
    if (ordered[3] != null && buckets.v30_59  === 0) buckets.v30_59  = ordered[3];
    if (ordered[4] != null && buckets.v60_89  === 0) buckets.v60_89  = ordered[4];
    if (ordered[5] != null && buckets.v90_119 === 0) buckets.v90_119 = ordered[5];
    // Ojo: en algunos reportes el orden de 120–179 y 180+ viene invertido; si sólo uno aparece, lo respetamos
    if (ordered[6] != null && buckets.v120_179 === 0 && buckets.v180p === 0) {
      // heurística: si la palabra "180" está antes que "120-179" en el header, el 6º número es 180+
      const headerOrderHint = Object.entries(colCenters).sort((a,b)=>a[1]-b[1]).map(([k])=>k).join(",");
      if (headerOrderHint.indexOf("v180p") < headerOrderHint.indexOf("v120_179")) buckets.v180p = ordered[6];
      else buckets.v120_179 = ordered[6];
    }
  }

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

/* ======================== RESPUESTA ======================== */
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

        const totals = extractTotalsByCoords(pdfData);
        if (totals) {
          const payload = buildResult({
            original: totals.original,
            vigente: totals.vigente,
            buckets: totals.buckets,
            multiplier,
            fuente: "Totales de Créditos Activos (por coordenadas)"
          });
          return res.status(200).json({ ok: true, meta: { milesDePesosDetectado: multiplier === 1000 }, data: payload });
        }

        if (onlyTotals) {
          return res.status(422).json({ ok: false, error: "No se encontró la fila 'Totales' en Créditos Activos." });
        }

        const lines = allText.split(/\n+/).map(s => s.trim()).filter(Boolean);
        const original = extractSingleLabeled(lines, /\boriginal\b/i);
        const vigente = extractSingleLabeled(lines, /\bvigente\b/i);
        const buckets = extractBuckets(lines);

        const payload = buildResult({
          original,
          vigente,
          buckets,
          multiplier,
          fuente: "Fallback por etiquetas (texto)"
        });
        return res.status(200).json({ ok: true, meta: { milesDePesosDetectado: multiplier === 1000 }, data: payload });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Fallo al extraer los datos", detalle: String(e) });
      }
    });

    pdfParser.parseBuffer(pdfBuffer);
  });
}
