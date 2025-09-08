// pages/index.js
import { useState, useMemo } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [onlyTotals, setOnlyTotals] = useState(true);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(null);
    setResult(null);
    if (!file) {
      setErr("Selecciona un PDF.");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("onlyTotals", String(onlyTotals));
    setLoading(true);
    try {
      const resp = await fetch("/api/extractResumen", { method: "POST", body: fd });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error || "Error");
      setResult(json);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  function formatMoney(n) {
    if (n == null) return "—";
    return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 });
  }
  function formatPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return `${Number(n).toFixed(2)}%`;
  }

  // Derivados útiles para UI
  const historia = result?.historia || [];
  const kpis = result?.kpisHistoria || null;

  const promedioRatio12m = useMemo(() => {
    if (!kpis?.ratiosVencidoSobreVigente?.length) return null;
    const vals = kpis.ratiosVencidoSobreVigente.map(r => r.ratio).filter(v => v != null);
    if (!vals.length) return null;
    const sum = vals.reduce((a,b) => a + b, 0);
    return sum / vals.length;
  }, [kpis]);

  return (
    <div style={{ maxWidth: 980, margin: "40px auto", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Extractor – Resumen de Créditos Activos</h1>
      <p style={{ color: "#555", marginBottom: 16 }}>
        Sube el Buró en PDF. Se tomará la fila <strong>“Totales”</strong> de <em>Créditos Activos / Capital + Intereses</em>.
        Se convierte a pesos si el reporte viene en miles. Además se extrae la sección <strong>“Historia”</strong> (serie mensual).
      </p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={onlyTotals} onChange={(e) => setOnlyTotals(e.target.checked)} />
          Usar solo “Totales” (si no existe, marcar error)
        </label>
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px 16px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: loading ? "#eee" : "#111",
            color: loading ? "#666" : "#fff",
            cursor: loading ? "default" : "pointer",
            fontWeight: 600,
            width: "fit-content"
          }}
        >
          {loading ? "Procesando..." : "Extraer"}
        </button>
      </form>

      {err && <div style={{ marginTop: 16, color: "#b00020" }}>{err}</div>}

      {result?.ok && (
        <div style={{ marginTop: 24, padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
          <h2 style={{ marginTop: 0, fontSize: 20 }}>Totales</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div><strong>Monto Original:</strong></div>
            <div>{formatMoney(result.data.montoOriginal)} <small>({result.data.unidades})</small></div>

            <div><strong>Saldo Vigente:</strong></div>
            <div>{formatMoney(result.data.saldoVigente)}</div>

            <div><strong>Saldo Vencido (total):</strong></div>
            <div>{formatMoney(result.data.saldoVencido)}</div>

            <div><strong>Saldo Total:</strong></div>
            <div>{formatMoney(result.data.saldoTotal)}</div>
          </div>

          <h3 style={{ marginTop: 16 }}>Buckets vencidos</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>1–29 días: {formatMoney(result.data.buckets["1_29"])}</li>
            <li>30–59 días: {formatMoney(result.data.buckets["30_59"])}</li>
            <li>60–89 días: {formatMoney(result.data.buckets["60_89"])}</li>
            <li>90–119 días: {formatMoney(result.data.buckets["90_119"])}</li>
            <li>120–179 días: {formatMoney(result.data.buckets["120_179"])}</li>
            <li>180+ días: {formatMoney(result.data.buckets["180_mas"])}</li>
          </ul>

          <div style={{ marginTop: 12, fontSize: 13, color: "#666" }}>
            Fuente: <strong>{result.data.fuente}</strong> · “Miles de pesos” detectado: {String(result.meta?.milesDePesosDetectado)}
          </div>

          {/* ==================== HISTORIA ==================== */}
          {historia.length > 0 && (
            <>
              <h2 style={{ marginTop: 28, fontSize: 20 }}>Historia (mensual)</h2>

              {/* KPIs */}
              {kpis && (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                  marginBottom: 12
                }}>
                  <Kpi title="Meses con atraso (últ. 12m)" value={kpis.mesesConAtraso} />
                  <Kpi title="Peor bucket (últ. 12m)" value={`${kpis.peorBucket}${kpis.mesPeorBucket ? ` · ${kpis.mesPeorBucket}` : ""}`} />
                  <Kpi title="Meses desde último 90+" value={kpis.mesesDesdeUltimo90mas ?? "—"} />
                  <Kpi title="Promedio Vencido/Vigente (12m)" value={formatPct(promedioRatio12m)} />
                </div>
              )}

              {/* Totales de buckets 12m */}
              {kpis && (
                <div style={{ marginBottom: 12, fontSize: 14 }}>
                  <strong>Acumulado 12m por bucket: </strong>
                  1–29: {formatMoney(kpis.sumasPorBucket["1_29"])} ·{" "}
                  30–59: {formatMoney(kpis.sumasPorBucket["30_59"])} ·{" "}
                  60–89: {formatMoney(kpis.sumasPorBucket["60_89"])} ·{" "}
                  90+: {formatMoney(kpis.sumasPorBucket["90_mas"])}
                </div>
              )}

              {/* Tabla Historia */}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr>
                      <Th>Periodo</Th>
                      <Th>Vigente</Th>
                      <Th>1–29</Th>
                      <Th>30–59</Th>
                      <Th>60–89</Th>
                      <Th>90+</Th>
                      <Th>Total mes</Th>
                      <Th>Calificación de Cartera</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {historia.map((r) => (
                      <tr key={r.periodo}>
                        <Td mono>{r.periodo}</Td>
                        <Td>{formatMoney(r.vigente)}</Td>
                        <Td>{formatMoney(r.venc_1_29)}</Td>
                        <Td>{formatMoney(r.venc_30_59)}</Td>
                        <Td>{formatMoney(r.venc_60_89)}</Td>
                        <Td>{formatMoney(r.venc_90_mas)}</Td>
                        <Td>{formatMoney(r.total_mes)}</Td>
                        <Td mono>{(r.calificacion_cartera || []).join(" ") || "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Ratios Vencido/Vigente (lista simple) */}
              {kpis?.ratiosVencidoSobreVigente?.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer" }}>Ver ratios Vencido/Vigente por mes (últ. 12m)</summary>
                  <ul style={{ marginTop: 8 }}>
                    {kpis.ratiosVencidoSobreVigente.map((r) => (
                      <li key={r.periodo}>
                        {r.periodo}: {formatPct(r.ratio)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- mini componentes de UI ---------- */
function Th({ children }) {
  return (
    <th
      style={{
        textAlign: "left",
        borderBottom: "1px solid #ddd",
        padding: "8px 6px",
        background: "#fafafa",
        fontWeight: 600
      }}
    >
      {children}
    </th>
  );
}
function Td({ children, mono = false }) {
  return (
    <td
      style={{
        borderBottom: "1px solid #eee",
        padding: "8px 6px",
        fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined
      }}
    >
      {children}
    </td>
  );
}
function Kpi({ title, value }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
