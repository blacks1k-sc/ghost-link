"use client";

import { useState } from "react";
import { useEntityGraph } from "@/stores/entityGraph";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface ManualTarget {
  id: string;   // temp client-side id; replaced by server id after POST
  label: string;
  lat: number;
  lon: number;
  persisted: boolean; // true once POSTed to /entities
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

// ── how-it-works copy ────────────────────────────────────────────────────────
const PIPELINE_STEPS = [
  { color: "text-indigo-400", label: "LLM (Ollama llama3.1:8b)", desc: "Reads your intent + world context, suggests airbases, carrier positions, weapon types, and rationale. Falls back to algorithmic if Ollama is offline." },
  { color: "text-yellow-400", label: "Hungarian Algorithm O(n³)", desc: "Builds a cost matrix (flight-time + SAM penalty) and finds the globally optimal weapon-to-target assignment." },
  { color: "text-purple-400", label: "Dijkstra Routing", desc: "Plans the shortest safe path for each assigned weapon: airbase → optional tanker waypoint → target, penalising threat-zone crossings." },
  { color: "text-cyan-400",   label: "Greedy Carrier Placement", desc: "Iteratively places carriers to maximise target coverage within strike radius (≈63% of optimal — set-cover approximation)." },
];

export default function PlannerChat({ onPlanResult, onWeaponHover }: {
  onPlanResult?: (plan: PlanSuggestion | null) => void;
  onWeaponHover?: (weaponType: string | null) => void;
}) {
  const [query, setQuery]     = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan]       = useState<PlanSuggestion | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [showHow, setShowHow] = useState(false);

  // Manual target form
  const [tLabel, setTLabel] = useState("");
  const [tLat,   setTLat]   = useState("");
  const [tLon,   setTLon]   = useState("");
  const [manualTargets, setManualTargets] = useState<ManualTarget[]>([]);
  const [addingTarget, setAddingTarget]   = useState(false);

  const getTargets = useEntityGraph((s) => s.getTargets);
  const getThreats = useEntityGraph((s) => s.getThreats);
  const upsertEntity = useEntityGraph((s) => s.upsertEntity);

  // ── add target ─────────────────────────────────────────────────────────────
  const handleAddTarget = async () => {
    // Strip trailing E/e (scientific notation remnant from number inputs)
    const lat = parseFloat(tLat.replace(/[Ee]$/, ""));
    const lon = parseFloat(tLon.replace(/[Ee]$/, ""));
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
    const label = tLabel.trim() || `Target ${Date.now()}`;
    setAddingTarget(true);

    const tempId = `manual-${Date.now()}`;
    // Optimistically add, then persist
    setManualTargets((prev) => [...prev, { id: tempId, label, lat, lon, persisted: false }]);

    try {
      const res = await fetch(`${API}/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "TARGET",
          domain: "LAND",
          properties: { lat, lon, alt_km: 0, label },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const serverId: string = data.id ?? tempId;
        setManualTargets((prev) =>
          prev.map((t) => t.id === tempId ? { ...t, id: serverId, persisted: true } : t)
        );
        // Push into Zustand store so CesiumGlobe renders the target immediately
        upsertEntity(data);
      }
    } catch {
      // mark as persisted anyway — will be picked up on suggest
    }

    setTLabel(""); setTLat(""); setTLon("");
    setAddingTarget(false);
  };

  const handleRemoveTarget = (id: string) => {
    setManualTargets((prev) => prev.filter((t) => t.id !== id));
    // Best-effort DELETE from entity graph
    fetch(`${API}/entities/${id}`, { method: "DELETE" }).catch(() => null);
  };

  // ── get plan ────────────────────────────────────────────────────────────────
  const handleSuggest = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setPlan(null);

    // Merge: entity-graph targets + manually entered targets
    const graphTargets = getTargets().map((t) => ({
      id: t.id,
      lat: t.properties.lat as number,
      lon: t.properties.lon as number,
      label: (t.properties.label as string) ?? "",
    }));
    const allTargetIds = new Set(graphTargets.map((t) => t.id));
    const extraTargets = manualTargets
      .filter((t) => !allTargetIds.has(t.id))
      .map(({ id, lat, lon, label }) => ({ id, lat, lon, label }));
    const targets = [...graphTargets, ...extraTargets];

    const threats = getThreats().map((t) => ({
      lat: t.properties.lat as number,
      lon: t.properties.lon as number,
      radius_km: (t.properties.radius_km as number) ?? 100,
    }));

    try {
      const res = await fetch(`${API}/planner/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, context: { targets, threats } }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Planner error ${res.status}: ${detail}`);
      }
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
    <div className="flex flex-col h-full p-3 gap-3 font-mono text-xs overflow-y-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-cyan-400 font-bold text-sm tracking-widest">AI MISSION PLANNER</div>
        <div className="flex items-center gap-2">
          {plan && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              plan.used_ollama
                ? "border-cyan-800 bg-cyan-950 text-cyan-400"
                : "border-gray-700 bg-gray-900 text-gray-500"
            }`}>
              {plan.used_ollama ? "LLM + ALGO" : "ALGO ONLY"}
            </span>
          )}
          <button
            onClick={() => setShowHow((v) => !v)}
            className="text-[10px] text-gray-600 hover:text-gray-300 border border-[#1a2a40] rounded px-1.5 py-0.5 transition-colors"
            title="How it works"
          >
            ?
          </button>
        </div>
      </div>

      {/* How it works */}
      {showHow && (
        <div className="bg-[#060c18] border border-[#1a2a40] rounded p-2.5 space-y-2">
          <div className="text-gray-500 text-[9px] tracking-widest mb-1">HOW IT WORKS</div>
          {PIPELINE_STEPS.map((s, i) => (
            <div key={i} className="flex gap-2">
              <span className={`${s.color} shrink-0`}>{i + 1}.</span>
              <div>
                <div className={`${s.color} text-[10px] font-bold`}>{s.label}</div>
                <div className="text-gray-600 text-[10px] leading-relaxed">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── TARGETS ─────────────────────────────────────────────────────── */}
      <div className="border border-[#1a2a40] rounded overflow-hidden">
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-[#080e1a]">
          <span className="text-red-400 text-[10px] tracking-widest">TARGETS</span>
          <span className="text-gray-600 text-[9px]">{allTargetCount} total</span>
        </div>

        {/* Existing entity-graph targets (read-only) */}
        {getTargets().map((t) => (
          <div key={t.id} className="flex items-center justify-between px-2.5 py-1 border-t border-[#0f1828]">
            <span className="text-gray-400 truncate max-w-[140px]">
              {(t.properties.label as string) || "Target"}
            </span>
            <span className="text-gray-600 text-[9px] shrink-0">
              {(t.properties.lat as number).toFixed(2)}, {(t.properties.lon as number).toFixed(2)}
            </span>
          </div>
        ))}

        {/* Manually added targets */}
        {manualTargets.map((t) => (
          <div key={t.id} className="flex items-center justify-between px-2.5 py-1 border-t border-[#0f1828] group">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.persisted ? "bg-red-500" : "bg-yellow-500 animate-pulse"}`} />
              <span className="text-gray-300 truncate max-w-[120px]">{t.label}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-gray-600 text-[9px]">{t.lat.toFixed(2)}, {t.lon.toFixed(2)}</span>
              <button
                onClick={() => handleRemoveTarget(t.id)}
                className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity leading-none"
              >
                ✕
              </button>
            </div>
          </div>
        ))}

        {/* Add target form */}
        <div className="border-t border-[#1a2a40] p-2 space-y-1.5 bg-[#060c18]">
          <input
            type="text"
            placeholder="Label (e.g. Radar Site Alpha)"
            value={tLabel}
            onChange={(e) => setTLabel(e.target.value)}
            className="w-full bg-[#0a1628] border border-[#1a2a40] focus:border-red-900 rounded px-2 py-1 text-[11px] text-white placeholder-gray-700 outline-none"
          />
          <div className="flex gap-1">
            <input
              type="text"
              inputMode="decimal"
              placeholder="Lat (−90 to 90)"
              value={tLat}
              onChange={(e) => setTLat(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddTarget(); }}
              className="w-1/2 bg-[#0a1628] border border-[#1a2a40] focus:border-red-900 rounded px-2 py-1 text-[11px] text-white placeholder-gray-700 outline-none"
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Lon (−180 to 180)"
              value={tLon}
              onChange={(e) => setTLon(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddTarget(); }}
              className="w-1/2 bg-[#0a1628] border border-[#1a2a40] focus:border-red-900 rounded px-2 py-1 text-[11px] text-white placeholder-gray-700 outline-none"
            />
          </div>
          <button
            onClick={handleAddTarget}
            disabled={addingTarget || isNaN(parseFloat(tLat)) || isNaN(parseFloat(tLon))}
            className="w-full py-1 text-[10px] font-mono border border-red-900 bg-red-950/40 hover:bg-red-900/50 text-red-300 rounded tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {addingTarget ? "ADDING…" : "⊕  ADD TARGET"}
          </button>
        </div>
      </div>

      {/* ── INTENT ──────────────────────────────────────────────────────── */}
      <div>
        <div className="text-gray-600 text-[9px] tracking-widest mb-1">STRIKE INTENT</div>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) handleSuggest(); }}
          placeholder='e.g. "Strike targets from NATO bases, avoid S-400 coverage"'
          rows={3}
          className="w-full bg-[#0a1628] border border-[#1a2a40] focus:border-cyan-800 rounded p-2 text-gray-200 text-[11px] resize-none outline-none transition-colors"
        />
      </div>

      <button
        onClick={handleSuggest}
        disabled={loading || !query.trim() || allTargetCount === 0}
        className="py-2 bg-cyan-900 hover:bg-cyan-800 disabled:bg-[#0a1628] disabled:text-gray-700 border border-cyan-700 disabled:border-[#1a2a40] rounded text-white text-[10px] tracking-widest transition-colors"
      >
        {loading ? "PLANNING…" : allTargetCount === 0 ? "ADD TARGETS FIRST" : "GET PLAN SUGGESTION"}
      </button>

      {error && (
        <div className="text-red-400 text-[10px] border border-red-900 rounded p-2 whitespace-pre-wrap">{error}</div>
      )}

      {/* ── RESULTS ─────────────────────────────────────────────────────── */}
      {plan && (
        <div className="flex flex-col gap-2">

          <div className="border border-[#1a2a40] rounded p-2.5">
            <div className="text-gray-500 text-[9px] tracking-widest mb-1">RATIONALE</div>
            <div className="text-gray-300 leading-relaxed text-[10px]">{plan.rationale}</div>
          </div>

          {plan.suggested_airbases.length > 0 && (
            <div className="border border-[#1a2a40] rounded p-2.5">
              <div className="text-yellow-500 text-[9px] tracking-widest mb-1">
                AIRBASES ({plan.suggested_airbases.length})
              </div>
              {plan.suggested_airbases.map((ab, i) => (
                <div key={i} className="text-gray-300 text-[10px]">
                  • {ab.name || ab.id}
                  <span className="text-gray-600 ml-1">{ab.lat.toFixed(2)}°, {ab.lon.toFixed(2)}°</span>
                </div>
              ))}
            </div>
          )}

          {plan.carrier_positions.length > 0 && (
            <div className="border border-[#1a2a40] rounded p-2.5">
              <div className="text-cyan-500 text-[9px] tracking-widest mb-1">
                CARRIERS ({plan.carrier_positions.length})
              </div>
              {plan.carrier_positions.map((cp, i) => (
                <div key={i} className="text-gray-300 text-[10px]">
                  • {cp.label}
                  <span className="text-gray-600 ml-1">{cp.lat.toFixed(2)}°, {cp.lon.toFixed(2)}°</span>
                </div>
              ))}
            </div>
          )}

          {plan.assignments.length > 0 && (
            <div className="border border-[#1a2a40] rounded p-2.5">
              <div className="text-green-500 text-[9px] tracking-widest mb-1">
                ASSIGNMENTS ({plan.assignments.length})
              </div>
              {plan.assignments.map((a, i) => (
                <div key={i} className={`flex justify-between text-[10px] ${!a.feasible ? "text-red-500" : "text-gray-300"}`}>
                  <span>• {a.weapon_type.replace(/_/g, " ").toUpperCase()}</span>
                  <span className="text-gray-600">{a.distance_km} km</span>
                </div>
              ))}
            </div>
          )}

          {plan.routes.length > 0 && (
            <div className="border border-[#1a2a40] rounded p-2.5">
              <div className="text-purple-400 text-[9px] tracking-widest mb-1">
                ROUTES ({plan.routes.length})
              </div>
              {plan.routes.map((r, i) => (
                <div
                  key={i}
                  className="text-gray-300 text-[10px] flex justify-between cursor-pointer rounded px-1 py-0.5 hover:bg-[#0f1f35] transition-colors"
                  onMouseEnter={() => onWeaponHover?.(r.weapon_type)}
                  onMouseLeave={() => onWeaponHover?.(null)}
                >
                  <span>• {r.weapon_type.replace(/_/g, " ").toUpperCase()}</span>
                  <span className="text-gray-600">
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
