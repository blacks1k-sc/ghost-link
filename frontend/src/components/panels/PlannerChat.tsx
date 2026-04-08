"use client";

import { useState, useEffect } from "react";
import { useEntityGraph } from "@/stores/entityGraph";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface ManualTarget {
  id: string;
  label: string;
  lat: number;
  lon: number;
  persisted: boolean;
}

interface Assignment {
  weapon_type: string;
  target_id: string;
  airbase_id: string;
  feasible: boolean;
  distance_km: number;
  flight_time_s: number;
}

interface Route {
  weapon_type: string;
  target_id: string;
  airbase_id: string;
  waypoints: Array<{ lat: number; lon: number; label: string }>;
  total_dist_km: number;
  total_time_s: number;
  uses_tanker: boolean;
  threat_crossings: number;
}

interface PlanSuggestion {
  suggested_airbases: Array<{ id: string; name: string; lat: number; lon: number }>;
  carrier_positions: Array<{ lat: number; lon: number; label: string }>;
  tanker_waypoints: Array<{ lat: number; lon: number; label: string }>;
  assignments: Assignment[];
  routes: Route[];
  rationale: string;
  used_ollama: boolean;
}

const PIPELINE_STEPS = [
  { color: "var(--ac-blue)",  label: "LLM (Ollama llama3.1:8b)",    desc: "Reads your intent + world context, suggests airbases, carrier positions, weapon types, and rationale. Falls back to algorithmic if Ollama is offline." },
  { color: "var(--ac-amber)", label: "Hungarian Algorithm O(n³)",    desc: "Builds a cost matrix (flight-time + SAM penalty) and finds the globally optimal weapon-to-target assignment." },
  { color: "var(--ink-2)",    label: "Dijkstra Routing",             desc: "Plans the shortest safe path for each assigned weapon: airbase → optional tanker waypoint → target, penalising threat-zone crossings." },
  { color: "var(--ac-green)", label: "Greedy Carrier Placement",     desc: "Iteratively places carriers to maximise target coverage within strike radius (≈63% of optimal — set-cover approximation)." },
];

// Shared inner card style
const card = {
  background: "rgba(25,21,15,0.06)",
  border: "1px solid rgba(25,21,15,0.12)",
  borderRadius: 4,
} as const;

const inputStyle = {
  width: "100%",
  background: "rgba(255,255,255,0.45)",
  border: "1px solid rgba(25,21,15,0.18)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
  color: "var(--ink)",
  outline: "none",
} as const;

export default function PlannerChat({ onPlanResult, onWeaponHover, pinModeActive = false, onPinModeToggle, pinnedCoords }: {
  onPlanResult?: (plan: PlanSuggestion | null) => void;
  onWeaponHover?: (weaponType: string | null) => void;
  pinModeActive?: boolean;
  onPinModeToggle?: (active: boolean) => void;
  pinnedCoords?: { lat: number; lon: number } | null;
}) {
  const [query, setQuery]     = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan]       = useState<PlanSuggestion | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [showHow, setShowHow] = useState(false);
  const [inputMode, setInputMode] = useState<"PIN" | "COORDS">("COORDS");

  const [tLabel, setTLabel] = useState("");
  const [tLat,   setTLat]   = useState("");
  const [tLon,   setTLon]   = useState("");
  const [manualTargets, setManualTargets] = useState<ManualTarget[]>([]);
  const [addingTarget, setAddingTarget]   = useState(false);

  useEffect(() => {
    if (pinnedCoords) {
      setTLat(pinnedCoords.lat.toFixed(6));
      setTLon(pinnedCoords.lon.toFixed(6));
      setInputMode("PIN");
    }
  }, [pinnedCoords]);

  const getTargets    = useEntityGraph((s) => s.getTargets);
  const getThreats    = useEntityGraph((s) => s.getThreats);
  const upsertEntity  = useEntityGraph((s) => s.upsertEntity);
  const removeEntity  = useEntityGraph((s) => s.removeEntity);

  const handleAddTarget = async () => {
    const lat = parseFloat(tLat.replace(/[Ee]$/, ""));
    const lon = parseFloat(tLon.replace(/[Ee]$/, ""));
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
    const label = tLabel.trim() || `Target ${Date.now()}`;
    setAddingTarget(true);

    const tempId = `manual-${Date.now()}`;
    setManualTargets((prev) => [...prev, { id: tempId, label, lat, lon, persisted: false }]);

    try {
      const res = await fetch(`${API}/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "TARGET", domain: "LAND", properties: { lat, lon, alt_km: 0, label } }),
      });
      if (res.ok) {
        const data = await res.json();
        const serverId: string = data.id ?? tempId;
        setManualTargets((prev) => prev.map((t) => t.id === tempId ? { ...t, id: serverId, persisted: true } : t));
        upsertEntity(data);
      }
    } catch { /* mark as persisted anyway */ }

    setTLabel(""); setTLat(""); setTLon("");
    setAddingTarget(false);
  };

  const handleRemoveTarget = (id: string) => {
    setManualTargets((prev) => prev.filter((t) => t.id !== id));
    removeEntity(id);
    fetch(`${API}/entities/${id}`, { method: "DELETE" }).catch(() => null);
  };

  const handleSuggest = async () => {
    if (!query.trim()) return;
    setLoading(true); setError(null); setPlan(null);

    const graphTargets = getTargets().map((t) => ({
      id: t.id, lat: t.properties.lat as number, lon: t.properties.lon as number,
      label: (t.properties.label as string) ?? "",
    }));
    const allTargetIds = new Set(graphTargets.map((t) => t.id));
    const extraTargets = manualTargets.filter((t) => !allTargetIds.has(t.id))
      .map(({ id, lat, lon, label }) => ({ id, lat, lon, label }));
    const targets = [...graphTargets, ...extraTargets];
    const threats = getThreats().map((t) => ({
      lat: t.properties.lat as number, lon: t.properties.lon as number,
      radius_km: (t.properties.radius_km as number) ?? 100,
    }));

    try {
      const res = await fetch(`${API}/planner/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, context: { targets, threats } }),
      });
      if (!res.ok) throw new Error(`Planner error ${res.status}: ${await res.text()}`);
      const result = await res.json();
      setPlan(result);
      onPlanResult?.(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const fmtTime = (s: number) => {
    if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
    if (s >= 60)   return `${Math.round(s / 60)}m`;
    return `${Math.round(s)}s`;
  };

  const allTargetCount = getTargets().length + manualTargets.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, gap: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, overflowY: "auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: "0.16em", color: "var(--ac-blue)" }}>
          AI MISSION PLANNER
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {plan && (
            <span style={{
              fontSize: 9, padding: "2px 6px", borderRadius: 3,
              color: plan.used_ollama ? "var(--ac-blue)" : "var(--ink-3)",
              background: plan.used_ollama ? "rgba(26,95,168,0.10)" : "rgba(25,21,15,0.06)",
              border: `1px solid ${plan.used_ollama ? "rgba(26,95,168,0.22)" : "rgba(25,21,15,0.12)"}`,
            }}>
              {plan.used_ollama ? "LLM + ALGO" : "ALGO ONLY"}
            </span>
          )}
          <button
            onClick={() => setShowHow((v) => !v)}
            style={{ fontSize: 10, color: "var(--ink-3)", border: "1px solid rgba(25,21,15,0.18)", borderRadius: 3, padding: "2px 6px", background: "rgba(255,255,255,0.30)", cursor: "pointer" }}
          >?</button>
        </div>
      </div>

      {/* How it works */}
      {showHow && (
        <div style={{ ...card, padding: 10 }}>
          <div className="gl-label" style={{ marginBottom: 8 }}>HOW IT WORKS</div>
          {PIPELINE_STEPS.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <span style={{ color: s.color, flexShrink: 0 }}>{i + 1}.</span>
              <div>
                <div style={{ color: s.color, fontSize: 10, fontWeight: 600 }}>{s.label}</div>
                <div style={{ color: "var(--ink-3)", fontSize: 10, lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── TARGETS ──────────────────────────────────────────────────── */}
      <div style={{ border: "1px solid rgba(25,21,15,0.14)", borderRadius: 4, overflow: "hidden" }}>

        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "rgba(25,21,15,0.08)", borderBottom: "1px solid rgba(25,21,15,0.10)" }}>
          <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 9, fontWeight: 600, letterSpacing: "0.18em", color: "var(--ac-red)", textTransform: "uppercase" }}>TARGETS</span>
          <span style={{ fontSize: 9, color: "var(--ink-3)" }}>{allTargetCount} total</span>
        </div>

        {/* Entity-graph targets */}
        {getTargets().map((t) => (
          <div key={t.id}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 10px", borderTop: "1px solid rgba(25,21,15,0.06)" }}
            className="group"
          >
            <span style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
              {(t.properties.label as string) || "Target"}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 9, color: "var(--ink-4)" }}>
                {(t.properties.lat as number).toFixed(2)}, {(t.properties.lon as number).toFixed(2)}
              </span>
              <button
                onClick={() => handleRemoveTarget(t.id)}
                style={{ color: "var(--ink-4)", cursor: "pointer", border: "none", background: "none", fontSize: 11, lineHeight: 1 }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ac-red)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-4)")}
              >✕</button>
            </div>
          </div>
        ))}

        {/* Manual targets */}
        {manualTargets.map((t) => (
          <div key={t.id}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 10px", borderTop: "1px solid rgba(25,21,15,0.06)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: t.persisted ? "var(--ac-red)" : "var(--ac-amber)", display: "inline-block" }} />
              <span style={{ color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>{t.label}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 9, color: "var(--ink-4)" }}>{t.lat.toFixed(2)}, {t.lon.toFixed(2)}</span>
              <button
                onClick={() => handleRemoveTarget(t.id)}
                style={{ color: "var(--ink-4)", cursor: "pointer", border: "none", background: "none", fontSize: 11, lineHeight: 1 }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ac-red)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-4)")}
              >✕</button>
            </div>
          </div>
        ))}

        {/* Add target form */}
        <div style={{ borderTop: "1px solid rgba(25,21,15,0.10)", background: "rgba(25,21,15,0.04)" }}>

          {/* Mode tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid rgba(25,21,15,0.10)" }}>
            {(["PIN", "COORDS"] as const).map((mode) => {
              const active = inputMode === mode;
              const activeColor = mode === "PIN" ? "var(--ac-blue)" : "var(--ac-red)";
              return (
                <button
                  key={mode}
                  onClick={() => { setInputMode(mode); if (mode === "COORDS" && pinModeActive) onPinModeToggle?.(false); }}
                  style={{
                    flex: 1, padding: "6px 0", fontSize: 9, fontFamily: "'Syne', sans-serif", fontWeight: 600,
                    letterSpacing: "0.14em", textTransform: "uppercase", cursor: "pointer",
                    color: active ? activeColor : "var(--ink-4)",
                    background: active ? "rgba(25,21,15,0.05)" : "transparent",
                    border: "none",
                    borderBottom: active ? `2px solid ${activeColor}` : "2px solid transparent",
                    transition: "color 0.15s",
                  }}
                >
                  {mode === "PIN" ? "📍 PIN ON MAP" : "⌨ COORDS"}
                </button>
              );
            })}
          </div>

          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              type="text"
              placeholder="Label (e.g. Radar Site Alpha)"
              value={tLabel}
              onChange={(e) => setTLabel(e.target.value)}
              style={inputStyle}
            />

            {inputMode === "PIN" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pinModeActive ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "rgba(26,95,168,0.08)", border: "1px solid rgba(26,95,168,0.22)", borderRadius: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ac-blue)", flexShrink: 0, animation: "dot-pulse 1.8s ease-in-out infinite" }} />
                    <span style={{ fontSize: 10, color: "var(--ac-blue)" }}>Click anywhere on the globe to place target</span>
                  </div>
                ) : (
                  <button
                    onClick={() => onPinModeToggle?.(true)}
                    style={{ padding: "6px 0", fontSize: 10, fontFamily: "'Syne', sans-serif", letterSpacing: "0.12em", border: "1px solid rgba(26,95,168,0.28)", background: "rgba(26,95,168,0.08)", color: "var(--ac-blue)", borderRadius: 4, cursor: "pointer" }}
                  >ACTIVATE PIN MODE</button>
                )}
                {tLat && tLon && (
                  <div style={{ fontSize: 10, color: "var(--ink-3)", paddingLeft: 2 }}>
                    Pinned: {parseFloat(tLat).toFixed(4)}°, {parseFloat(tLon).toFixed(4)}°
                  </div>
                )}
                <button
                  onClick={() => { handleAddTarget(); onPinModeToggle?.(false); }}
                  disabled={addingTarget || !tLat || !tLon || isNaN(parseFloat(tLat)) || isNaN(parseFloat(tLon))}
                  style={{ padding: "6px 0", fontSize: 10, fontFamily: "'Syne', sans-serif", letterSpacing: "0.14em", border: "1px solid rgba(138,26,24,0.30)", background: "rgba(138,26,24,0.08)", color: "var(--ac-red)", borderRadius: 4, cursor: "pointer", opacity: addingTarget ? 0.5 : 1 }}
                >
                  {addingTarget ? "ADDING…" : "⊕  ADD TARGET"}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <input type="text" inputMode="decimal" placeholder="Lat (−90 to 90)"    value={tLat} onChange={(e) => setTLat(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleAddTarget(); }} style={{ ...inputStyle, width: "50%" }} />
                  <input type="text" inputMode="decimal" placeholder="Lon (−180 to 180)"  value={tLon} onChange={(e) => setTLon(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleAddTarget(); }} style={{ ...inputStyle, width: "50%" }} />
                </div>
                <button
                  onClick={handleAddTarget}
                  disabled={addingTarget || isNaN(parseFloat(tLat)) || isNaN(parseFloat(tLon))}
                  style={{ padding: "6px 0", fontSize: 10, fontFamily: "'Syne', sans-serif", letterSpacing: "0.14em", border: "1px solid rgba(138,26,24,0.30)", background: "rgba(138,26,24,0.08)", color: "var(--ac-red)", borderRadius: 4, cursor: "pointer", opacity: addingTarget ? 0.5 : 1 }}
                >
                  {addingTarget ? "ADDING…" : "⊕  ADD TARGET"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── INTENT ──────────────────────────────────────────────────── */}
      <div>
        <div className="gl-label" style={{ marginBottom: 6 }}>Strike Intent</div>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) handleSuggest(); }}
          placeholder='e.g. "Strike targets from NATO bases, avoid S-400 coverage"'
          rows={3}
          style={{ ...inputStyle, resize: "none", lineHeight: 1.6 }}
        />
      </div>

      <button
        onClick={handleSuggest}
        disabled={loading || !query.trim() || allTargetCount === 0}
        style={{
          padding: "8px 0", fontSize: 10, fontFamily: "'Syne', sans-serif", fontWeight: 600, letterSpacing: "0.16em",
          borderRadius: 4, cursor: loading || allTargetCount === 0 ? "not-allowed" : "pointer",
          color: loading || allTargetCount === 0 ? "var(--ink-4)" : "var(--linen)",
          background: loading || allTargetCount === 0 ? "rgba(25,21,15,0.08)" : "var(--ac-blue)",
          border: `1px solid ${loading || allTargetCount === 0 ? "rgba(25,21,15,0.14)" : "rgba(26,95,168,0.60)"}`,
          transition: "all 0.15s",
        }}
      >
        {loading ? "PLANNING…" : allTargetCount === 0 ? "ADD TARGETS FIRST" : "GET PLAN SUGGESTION"}
      </button>

      {error && (
        <div style={{ fontSize: 10, color: "var(--ac-red)", border: "1px solid rgba(138,26,24,0.25)", borderRadius: 4, padding: 8, whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}

      {/* ── RESULTS ─────────────────────────────────────────────────── */}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          <div style={{ ...card, padding: 10 }}>
            <div className="gl-label" style={{ marginBottom: 6 }}>Rationale</div>
            <div style={{ color: "var(--ink-2)", lineHeight: 1.6, fontSize: 10 }}>{plan.rationale}</div>
          </div>

          {plan.suggested_airbases.length > 0 && (
            <div style={{ ...card, padding: 10 }}>
              <div className="gl-label" style={{ marginBottom: 6, color: "var(--ac-amber)" }}>
                Airbases ({plan.suggested_airbases.length})
              </div>
              {plan.suggested_airbases.map((ab, i) => (
                <div key={i} style={{ fontSize: 10, color: "var(--ink-2)" }}>
                  · {ab.name || ab.id}
                  <span style={{ color: "var(--ink-4)", marginLeft: 6 }}>{ab.lat.toFixed(2)}°, {ab.lon.toFixed(2)}°</span>
                </div>
              ))}
            </div>
          )}

          {plan.carrier_positions.length > 0 && (
            <div style={{ ...card, padding: 10 }}>
              <div className="gl-label" style={{ marginBottom: 6, color: "var(--ac-blue)" }}>
                Carriers ({plan.carrier_positions.length})
              </div>
              {plan.carrier_positions.map((cp, i) => (
                <div key={i} style={{ fontSize: 10, color: "var(--ink-2)" }}>
                  · {cp.label}
                  <span style={{ color: "var(--ink-4)", marginLeft: 6 }}>{cp.lat.toFixed(2)}°, {cp.lon.toFixed(2)}°</span>
                </div>
              ))}
            </div>
          )}

          {plan.assignments.length > 0 && (
            <div style={{ ...card, padding: 10 }}>
              <div className="gl-label" style={{ marginBottom: 6, color: "var(--ac-green)" }}>
                Assignments ({plan.assignments.length})
              </div>
              {plan.assignments.map((a, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: a.feasible ? "var(--ink-2)" : "var(--ac-red)" }}>
                  <span>· {a.weapon_type.replace(/_/g, " ").toUpperCase()}</span>
                  <span style={{ color: "var(--ink-4)" }}>{a.distance_km} km</span>
                </div>
              ))}
            </div>
          )}

          {plan.routes.length > 0 && (
            <div style={{ ...card, padding: 10 }}>
              <div className="gl-label" style={{ marginBottom: 6, color: "var(--ink-2)" }}>
                Routes ({plan.routes.length})
              </div>
              {plan.routes.map((r, i) => (
                <div
                  key={i}
                  style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--ink-2)", cursor: "pointer", padding: "2px 4px", borderRadius: 3 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "rgba(25,21,15,0.06)"; onWeaponHover?.(r.weapon_type); }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; onWeaponHover?.(null); }}
                >
                  <span>· {r.weapon_type.replace(/_/g, " ").toUpperCase()}</span>
                  <span style={{ color: "var(--ink-4)" }}>
                    {r.total_dist_km} km · {fmtTime(r.total_time_s)}
                    {r.uses_tanker && " ⛽"}
                    {r.threat_crossings > 0 && ` ⚠×${r.threat_crossings}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
