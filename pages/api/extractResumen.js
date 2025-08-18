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

function pagesToText(pdfData) {
  const lines = [];
  for (const page of pdfData.Pages || []) {
    const rows = new Map();
    for (const t of page.Texts || []) {
      const y = Math.round(t.y * 4) / 4; // agrupar por cuartos
      const arr = rows.get(y) || [];
      const fragment = (t.R || []).map((r) => decodeTxt(r.T)).join("");
      arr.push({ x: t.x, text: fragment });
      rows.set(y, arr);
    }
    const sortedY = [...rows.keys()].sort((a, b) => a - b);
    for (const y of sortedY) {
      const cols = rows.get(y).sort((a, b) => a.x - b.x);
      const line = cols.map((c) => c.text).join(" ").replace(/[ \t]+/g, " ").trim();
      if (line) lines.push(line);
    }
    lines.push("<<<PAGE_BREAK>>>");
  }
  return lines.join("\n");
}

function parseNumberMX(str) {
  if (!str) return null;
  let s = String(str).replace(/\u00A0/g, " ").trim();
  s = s.replace(/\s/g, "").replace(/\$/g, "");
  const isNeg = /^\(.*\)$/.test(s);
  s = s.replace(/[(),]/g, "");
  if (!s || isNaN(Number(s))) return null;
  const n = Number(s);
  return isNeg ? -n : n;
}

function detectMilesDePesos(text) {
  return /(todas las cantidades?.*?en.*?miles de pesos)/i.test(text);
}

/* ========== FALLBACK por etiquetas (si no se encuentra Totales) ========== */
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

/* ========== NUEVO: Totales de “Créditos Activos / Capital + Intereses” ========== */
/*  Patch: tomar SOLO la línea de "Totales:" o, si hace falta, la línea previa.
    Evita mezclar con filas como "89 87 ..." que pueden estar arriba. */
function extractActivosTotals(lines) {
  let sectionStart = -1;

  // util local: toma números de una línea y regresa los últimos 8 como [orig, vig, b1..b6]
  function takeFromLine(line) {
    const nums = (line.match(/[-$()0-9.,]+/g) || [])
      .map(parseNumberMX)
      .filter((v) => v !== null);
    if (nums.length < 2) return null;
    const take = nums.slice(-8);
    while (take.length < 8) take.push(0);
    const [original, vigente, b1, b2, b3, b4, b5, b6] = take;
    return {
      original,
      vigente,
      buckets: {
        v1_29: b1 || 0,
        v30_59: b2 || 0,
        v60_89: b3 || 0,
        v90_119: b4 || 0,
        v120_179: b5 || 0,
        v180p:  b6 || 0,
      },
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // Marca el inicio de la sección correcta
    if (/(Cr[ée]ditos Activos|Capital \+\s*Intereses)/i.test(ln)) {
      sectionStart = i;
    }

    // Solo buscamos "Totales:" dentro de esa sección (ventana razonable)
    if (/Totales\s*:?/i.test(ln) && sectionStart !== -1 && i - sectionStart < 180) {
      // A) MismA línea: números antes de "Totales:"
      const beforeSameLine = ln.split(/Totales\s*:/i)[0] || "";
      let res = takeFromLine(beforeSameLine);
      if (res) return res;

      // B) Solo la línea previa (algunas plantillas separan la etiqueta)
      const prev = lines[i - 1] || "";
      res = takeFromLine(prev);
      if (res) return res;

      // C) Combinado conservador: previa + misma (en ese orden)
      const combined = (prev + " " + beforeSameLine).trim();
      res = takeFromLine(combined);
      if (res) return res;

      // Si no, seguimos buscando por si hay otra coincidencia
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
      "1_29":   (buckets.v1_29   || 0) * multiplier,
      "30_59":  (buckets.v30_59  || 0) * multiplier,
      "60_89":  (buckets.v60_89  || 0) * multiplier,
      "90_119": (buckets.v90_119 || 0) * multiplier,
      "120_179":(buckets.v120_179|| 0) * multiplier,
      "180_mas":(buckets.v180p   || 0) * multiplier,
    },
    saldoVencido: vencido * multiplier,
    saldoTotal:
      (vigente != null ? vigente * multiplier : 0) + vencido * multiplier,
    unidades: multiplier === 1000 ? "pesos (convertido desde miles)" : "pesos",
    fuente,
  };
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
        const fullText = pagesToText(pdfData);
        const normalized = normalizeSpaces(fullText);
        const lines = normalized.split(/\n+/).map((x) => x.trim()).filter(Boolean);
        const multiplier = detectMilesDePesos(normalized) ? 1000 : 1;

        // 1) Totales (preferido)
        const totals = extractActivosTotals(lines);

        if (totals) {
          const payload = buildResult({
            original: totals.original,
            vigente: totals.vigente,
            buckets: totals.buckets,
            multiplier,
            fuente: "Totales de Créditos Activos",
          });
          return res.status(200).json({
            ok: true,
            meta: { milesDePesosDetectado: multiplier === 1000 },
            data: payload,
          });
        }

        // 2) Si el usuario exige solo Totales, error si no existe
        if (onlyTotals) {
          return res.status(422).json({ ok: false, error: "No se encontró la fila 'Totales' en Créditos Activos." });
        }

        // 3) Fallback por etiquetas
        const original = extractSingleLabeled(lines, /\boriginal\b/i);
        const vigente = extractSingleLabeled(lines, /\bvigente\b/i);
        const buckets = extractBuckets(lines);

        const payload = buildResult({
          original,
          vigente,
          buckets,
          multiplier,
          fuente: "Fallback por etiquetas",
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
