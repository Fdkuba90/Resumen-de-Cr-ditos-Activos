// pages/index.js
import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
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
    setLoading(true);
    try {
      const resp = await fetch("/api/extractResumen", {
        method: "POST",
        body: fd,
      });
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

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Extractor Resumen Buró (PDF)</h1>
      <p style={{ color: "#555", marginBottom: 24 }}>
        Sube el reporte PDF del Buró de Crédito empresarial. Se extraerán: Original, Vigente, buckets de vencido y totales.
      </p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
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
          }}
        >
          {loading ? "Procesando..." : "Extraer"}
        </button>
      </form>

      {err && (
        <div style={{ marginTop: 16, color: "#b00020" }}>
          {err}
        </div>
      )}

      {result?.ok && (
        <div style={{ marginTop: 24, padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
          <h2 style={{ marginTop: 0, fontSize: 20 }}>Resultado</h2>
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

          <details style={{ marginTop: 12 }}>
            <summary>Debug</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>
{JSON.stringify(result.debug, null, 2)}
            </pre>
            <div>“Miles de pesos” detectado: {String(result.meta?.milesDePesosDetectado)}</div>
          </details>
        </div>
      )}
    </div>
  );
}
