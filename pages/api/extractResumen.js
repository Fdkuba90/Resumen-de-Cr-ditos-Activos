// pages/api/extractResumen.js
import { IncomingForm } from "formidable";
import fs from "fs";
import PDFParser from "pdf2json";

export const config = { api: { bodyParser: false } };

/* ======================== UTILIDADES ======================== */
function decodeTxt(t = "") { try { return decodeURIComponent(t); } catch { return t; } }

function normalizeSpaces(s = "") {
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .trim();
}

// Agrupa en "renglones" por coordenada Y con tolerancia (sin perder X/Y originales)
function pageToRows(page, yTol = 0.35) {
  const rows = []; // [{y, cells:[{x,text}]}]
  for (const t of page.Texts || []) {
    const text = (t.R || []).map(r => decodeTxt(r.T)).join("");
    if (!text.trim()) continue;
    const y = t.y;
    let row = null;
    for (const r of rows) {
      if (Math.abs(r.y - y) <= yTol) { row = r; break; }
    }
    if (!row) { row = { y, cells: [] }; rows.push(row); }
    row.cells.push({ x: t.x, text });
  }
  // ordena filas por y y cada fila por x
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

function detectMilesDePesos(text) {
  return /(todas las cantidades?.*?en.*?miles de pesos)/i.test(text);
}

function textOfRow(row) {
  return row.cells.map(c => c.text).join(" ").replace(/[ \t]+/g, " ").trim();
}

// Busca página y bloque donde aparece la tabla “Créditos Activos / Capital + Intereses”
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

/* ======================== EXTRACCIÓN POR COORDENADAS ======================== */
// Etiquetas esperadas del header y sus regex (columna -> regex)
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

// Encuentra la fila de encabezado (donde estén “Original”, “Vigente”, “1–29 días”, …)
function findHeaderConfig(rows) {
  for (const row of rows) {
    const line = textOfRow(row);
    const hasOriginal = /original/i.test(line);
    const hasVigente  = /vigente/i.test(line);
    const hasDias     = /d[ií]as/i.test(line);
    if (hasOriginal && hasVigente && hasDias) {
      // Mapea cada columna a su posición X aproximada
      const colCenters = {};
      for (const col of HEADER_COLS) {
        // Busca el token del header que matchee ese col en la fila
        let best = null;
        for (const c of row.cells) {
          if (col.re.test(c.text)) { best = c; break; }
        }
        if (best) colCenters[col.key] = best.x;
      }
      // Debemos tener al menos Original + Vigente para seguir
      if (colCenters.original != null && colCenters.vigente != null) {
        return { headerRowY: row.y, colCenters };
      }
    }
  }
  return null;
}

// Dada una fila (cells con x/text), asigna valores numéricos a cada columna del header por cercanía en X
function assignRowToColumns(row, colCenters) {
  const result = { original:null, vigente:null, v1_29:0, v30_59:0, v60_89:0, v90_119:0, v120_179:0, v180p:0, hasTotales:false };

  // ¿trae "Totales"?
  if (row.cells.some(c => /Totales\s*:?/i.test(c.text))) {
    result.hasTotales = true;
  }

  // Por cada celda numérica, la enviamos a la columna con X más cercana (si existe)
  for (const c of row.cells) {
    const n = parseNumberMX(c.text);
    if (n === null) continue;

    // Encuentra columna más cercana
    let bestKey = null, bestDist = Infinity;
    for (const [key, x] of Object.entries(colCenters)) {
      const d = Math.abs(c.x - x);
      if (d < bestDist) { bestDist = d; bestKey = key; }
    }
    if (!bestKey) continue;

    if (bestKey === "original" || bestKey === "vigente") {
      // en estas columnas esperamos un único valor; si aparece más de uno, nos quedamos con el último
      result[bestKey] = n;
    } else {
      // buckets se acumulan por si el PDF divide la cifra en varios tokens
      result[bestKey] = (result[bestKey] || 0) + n;
    }
  }
  return result;
}

// Orquesta: localizar encabezado, luego recorrer filas hasta hallar "Totales"
function extractTotalsByCoords(pdfData) {
  const hit = findActivosPage(pdfData);
  if (!hit) return null;

  const { pageIndex } = hit;
  const rows = pageToRows(pdfData.Pages[pageIndex], 0.35);

  const header = findHeaderConfig(rows);
  if (!header) return null;

  // Tomamos las filas DESPUÉS del encabezado, hasta que empiece otra sección o se acabe página
  const startIdx = rows.findIndex(r => r.y === rows.find(rr => rr.y === header.headerRowY).y);
  const candidates = rows.slice(startIdx + 1);

  for (const row of candidates) {
    const line = textOfRow(row);
    // Heurística de corte: si empieza otra sección grande (Resumen Créditos Activos, Créditos Liquidados, etc.)
    if (/Resumen Cr[ée]ditos Activos|Cr[ée]ditos Liquidados|INFORMACI[ÓO]N COMERCIAL/i.test(line)) break;

    const mapped = assignRowToColumns(row, header.colCenters);
    if (mapped.hasTotales) {
      return {
        original: mapped.original,
        vigente:  mapped.vigente,
        buckets: {
          v1_29: mapped.v1_29 || 0,
          v30_59: mapped.v30_59 || 0,
          v60_89: mapped.v60_89 || 0,
          v90_119: mapped.v90_119 || 0,
          v120_179: mapped.v120_179 || 0,
          v180p: mapped.v180p || 0,
        }
      };
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
        let val = null;
        if (nums) {
          const candidates = nums.map(parseNumberMX).filter((v) => v !== null);
          if (candidates.length) val = candidates[candidates.length - 1];
        }
        if (val === null) {
          for (let k = 1; k <= 2 && i + k < lines.length; k++) {
            const nn = lines[i + k].match(/[-$()0-9.,]+/g);
            if (nn) {
              const c2 = nn.map(parseNumberMX).filter((v) => v !== null);
              if (c2.length) { val = c2[c2.length - 1]; break; }
            }
          }
        }
        if (typeof val === "number") out[b.key] += val;
      }
    }
  }
  return out;
}

/* ======================== HANDLER ======================== */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

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
        // Texto normalizado solo para detectar "miles de pesos" y fallback de etiquetas
        const allLinesText = normalizeSpaces(
          (pdfData.Pages || []).map(p => pageToRows(p).map(textOfRow).join("\n")).join("\n")
        );
        const multiplier = detectMilesDePesos(allLinesText) ? 1000 : 1;

        // ===== 1) Método principal: COORDENADAS (fila Totales) =====
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

        // ===== 2) Si exige solo Totales, error si no se localizó por coordenadas =====
        if (onlyTotals) {
          return res.status(422).json({ ok: false, error: "No se encontró la fila 'Totales' en Créditos Activos." });
        }

        // ===== 3) Fallback por texto/etiquetas =====
        const lines = allLinesText.split(/\n+/).map(s => s.trim()).filter(Boolean);
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

        return res.status(200).json({
          ok: true,
          meta: { milesDePesosDetectado: multiplier === 1000 },
          data: payload,
        });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Fallo al extraer los datos", detalle: String(e) });
      }
    });

    pdfParser.parseBuffer(pdfBuffer);
  });
}
