"use client";

import { useEntityGraph } from "@/stores/entityGraph";

const SUDA_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  CRUISE:     { label: "CRUISE",     color: "var(--ac-blue)",  bg: "rgba(26,95,168,0.12)",  border: "rgba(26,95,168,0.28)" },
  EVADING:    { label: "EVADING",    color: "var(--ac-amber)", bg: "rgba(138,74,8,0.12)",   border: "rgba(138,74,8,0.28)" },
  REALIGNING: { label: "REALIGNING", color: "#7a5a10",         bg: "rgba(122,90,16,0.10)",  border: "rgba(122,90,16,0.25)" },
  TERMINAL:   { label: "TERMINAL",   color: "var(--ac-red)",   bg: "rgba(138,26,24,0.12)",  border: "rgba(138,26,24,0.28)" },
  DESTROYED:  { label: "DESTROYED",  color: "var(--ink-4)",    bg: "rgba(25,21,15,0.06)",   border: "rgba(25,21,15,0.10)" },
  IMPACTED:   { label: "IMPACTED",   color: "var(--ac-green)", bg: "rgba(26,96,48,0.12)",   border: "rgba(26,96,48,0.28)" },
};

interface Props { entityId: string; onClose: () => void; }

export default function EntityInspector({ entityId, onClose }: Props) {
  const entity = useEntityGraph((s) => s.getEntity(entityId));

  if (!entity) {
    return (
      <div className="p-4 font-mono text-[10px]" style={{ color: "var(--ink-3)" }}>
        Entity not found.
        <button onClick={onClose} className="block mt-2 transition-colors duration-150"
          style={{ color: "var(--ink-4)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-4)")}>
          ✕ Close
        </button>
      </div>
    );
  }

  const p = entity.properties as Record<string, unknown>;
  const sudaState = (p.suda_state as string) ?? "CRUISE";
  const sudaMeta = SUDA_META[sudaState] ?? SUDA_META.CRUISE;
  const tauI    = typeof p.tau_i     === "number" ? p.tau_i     : null;
  const fuelPct = typeof p.fuel_pct  === "number" ? p.fuel_pct * 100 : null;

  const divider = { borderTop: "1px solid rgba(25,21,15,0.10)", paddingTop: 14 };

  return (
    <div className="font-mono">

      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3.5"
        style={{ borderBottom: "1px solid rgba(25,21,15,0.10)" }}>
        <div>
          <div className="text-[8px] tracking-[0.16em] mb-1 uppercase"
            style={{ color: "var(--ink-3)" }}>
            {entity.type} · {entity.domain}
          </div>
          <div className="text-[14px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>
            {(p.weapon_type as string) ?? (p.label as string) ?? entityId.slice(0, 8)}
          </div>
        </div>
        <button onClick={onClose}
          className="text-[12px] leading-none transition-colors duration-150 mt-0.5"
          style={{ color: "var(--ink-3)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-3)")}>
          ✕
        </button>
      </div>

      <div className="px-4 py-3 space-y-4">

        {/* SUDA state */}
        {entity.type === "WEAPON" && (
          <div>
            <div className="gl-label mb-2">SUDA State</div>
            <span className="font-mono text-[9px] font-semibold px-2.5 py-1 rounded tracking-[0.12em]"
              style={{ color: sudaMeta.color, background: sudaMeta.bg, border: `1px solid ${sudaMeta.border}` }}>
              {sudaMeta.label}
            </span>
          </div>
        )}

        {/* τ_i */}
        {tauI !== null && (
          <div style={divider}>
            <div className="gl-label mb-1.5">Time-to-Go (τᵢ)</div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono font-semibold tabular-nums" style={{ fontSize: 20, color: "var(--ac-blue)" }}>
                {tauI.toFixed(1)}
              </span>
              <span className="font-mono text-[10px]" style={{ color: "var(--ink-3)" }}>s</span>
            </div>
          </div>
        )}

        {/* Fuel */}
        {fuelPct !== null && (
          <div style={divider}>
            <div className="flex items-center justify-between mb-2">
              <div className="gl-label">Fuel</div>
              <span className="font-mono text-[10px] tabular-nums" style={{ color: "var(--ink-2)" }}>
                {fuelPct.toFixed(0)}%
              </span>
            </div>
            <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(25,21,15,0.12)" }}>
              <div
                className="h-full rounded-full transition-all duration-400"
                style={{
                  width: `${fuelPct}%`,
                  background: fuelPct > 50 ? "var(--ac-green)" : fuelPct > 20 ? "var(--ac-amber)" : "var(--ac-red)",
                }}
              />
            </div>
          </div>
        )}

        {/* Position */}
        {p.lat != null && (
          <div style={divider}>
            <div className="gl-label mb-2">Position</div>
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] tabular-nums" style={{ color: "var(--ink)" }}>
                {(p.lat as number).toFixed(4)}° N
              </div>
              <div className="font-mono text-[11px] tabular-nums" style={{ color: "var(--ink)" }}>
                {(p.lon as number).toFixed(4)}° E
              </div>
              {p.alt_km != null && (
                <div className="font-mono text-[9px] tabular-nums mt-1" style={{ color: "var(--ink-3)" }}>
                  {((p.alt_km as number) * 1000).toFixed(0)} m MSL
                </div>
              )}
            </div>
          </div>
        )}

        {/* Speed */}
        {p.speed_mach != null && (
          <div style={divider}>
            <div className="gl-label mb-1.5">Speed</div>
            <div className="font-mono text-[11px]" style={{ color: "var(--ink)" }}>
              Mach <span className="tabular-nums">{(p.speed_mach as number).toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* P(intercept) — threats */}
        {entity.type === "THREAT" && p.p_intercept_base != null && (
          <div style={divider}>
            <div className="gl-label mb-1.5">P(Intercept)</div>
            <div className="font-mono font-semibold tabular-nums" style={{ fontSize: 18, color: "var(--ac-red)" }}>
              {((p.p_intercept_base as number) * 100).toFixed(0)}%
            </div>
            <div className="font-mono text-[9px] mt-0.5" style={{ color: "var(--ink-3)" }}>
              Radius: {p.radius_km as number} km
            </div>
          </div>
        )}

        {/* Raw properties */}
        <details style={divider}>
          <summary className="font-mono text-[9px] cursor-pointer tracking-[0.12em] uppercase transition-colors duration-150"
            style={{ color: "var(--ink-4)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink-2)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-4)")}>
            Raw Properties
          </summary>
          <pre className="font-mono text-[8px] mt-2 overflow-x-auto leading-relaxed"
            style={{ color: "var(--ink-3)" }}>
            {JSON.stringify(p, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
