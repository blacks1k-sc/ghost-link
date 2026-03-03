"use client";

import { useState } from "react";
import { useEntityGraph } from "@/stores/entityGraph";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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

export default function PlannerChat() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<PlanSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getTargets = useEntityGraph((s) => s.getTargets);
  const getThreats = useEntityGraph((s) => s.getThreats);

  const handleSuggest = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setPlan(null);

    // Collect placed targets + active threats from entity graph
    const targets = getTargets().map((t) => ({
      id: t.id,
      lat: t.properties.lat as number,
      lon: t.properties.lon as number,
      label: (t.properties.label as string) ?? "",
    }));

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
      const data: PlanSuggestion = await res.json();
      setPlan(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const fmtTime = (s: number) => {
    if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
    if (s >= 60) return `${Math.round(s / 60)}m`;
    return `${Math.round(s)}s`;
  };

  return (
    <div className="flex flex-col h-full p-3 gap-3 font-mono text-xs">
      <div className="flex items-center justify-between">
        <div className="text-cyan-400 font-bold text-sm">AI MISSION PLANNER</div>
        {plan?.used_ollama !== undefined && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${plan.used_ollama ? "bg-cyan-950 text-cyan-400" : "bg-gray-800 text-gray-500"}`}>
            {plan.used_ollama ? "Ollama" : "Algorithmic"}
          </span>
        )}
      </div>

      <div className="text-gray-500 text-xs">
        Describe your strike intent. Place targets on the map first, then ask the planner for asset placement and weapon assignments.
      </div>

      <textarea
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) handleSuggest(); }}
        placeholder='e.g. "Strike targets in Eastern Europe from NATO bases, avoid S-400 coverage"'
        rows={4}
        className="bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 text-xs resize-none focus:outline-none focus:border-cyan-700"
      />

      <button
        onClick={handleSuggest}
        disabled={loading || !query.trim()}
        className="px-3 py-1.5 bg-cyan-800 hover:bg-cyan-700 disabled:bg-gray-800 rounded text-white text-xs transition-colors"
      >
        {loading ? "Planning…" : "GET PLAN SUGGESTION"}
      </button>

      {error && (
        <div className="text-red-400 text-xs border border-red-900 rounded p-2 whitespace-pre-wrap">{error}</div>
      )}

      {plan && (
        <div className="flex flex-col gap-2 overflow-y-auto">
          {/* Rationale */}
          <div className="text-gray-400 border border-gray-800 rounded p-2">
            <div className="text-gray-500 mb-1">RATIONALE</div>
            <div className="text-gray-300 leading-relaxed">{plan.rationale}</div>
          </div>

          {/* Suggested airbases */}
          {plan.suggested_airbases.length > 0 && (
            <div className="border border-gray-800 rounded p-2">
              <div className="text-yellow-500 mb-1">SUGGESTED AIRBASES ({plan.suggested_airbases.length})</div>
              {plan.suggested_airbases.map((ab, i) => (
                <div key={i} className="text-gray-300">
                  • {ab.name || ab.id} ({ab.lat.toFixed(2)}°, {ab.lon.toFixed(2)}°)
                </div>
              ))}
            </div>
          )}

          {/* Carrier positions */}
          {plan.carrier_positions.length > 0 && (
            <div className="border border-gray-800 rounded p-2">
              <div className="text-cyan-500 mb-1">CARRIER POSITIONS ({plan.carrier_positions.length})</div>
              {plan.carrier_positions.map((cp, i) => (
                <div key={i} className="text-gray-300">
                  • {cp.label}: ({cp.lat.toFixed(2)}°, {cp.lon.toFixed(2)}°)
                </div>
              ))}
            </div>
          )}

          {/* Tanker waypoints */}
          {plan.tanker_waypoints.length > 0 && (
            <div className="border border-gray-800 rounded p-2">
              <div className="text-orange-400 mb-1">TANKER WAYPOINTS ({plan.tanker_waypoints.length})</div>
              {plan.tanker_waypoints.map((tw, i) => (
                <div key={i} className="text-gray-300">
                  • {tw.label}: ({tw.lat.toFixed(2)}°, {tw.lon.toFixed(2)}°)
                </div>
              ))}
            </div>
          )}

          {/* Hungarian assignments */}
          {plan.assignments.length > 0 && (
            <div className="border border-gray-800 rounded p-2">
              <div className="text-green-500 mb-1">WEAPON ASSIGNMENTS ({plan.assignments.length})</div>
              {plan.assignments.map((a, i) => (
                <div key={i} className={`flex justify-between ${a.feasible === false ? "text-red-500" : "text-gray-300"}`}>
                  <span>• {a.weapon_type.replace(/_/g, " ").toUpperCase()}</span>
                  <span className="text-gray-500">→ {a.target_id.slice(0, 8)} · {a.distance_km}km</span>
                </div>
              ))}
            </div>
          )}

          {/* Dijkstra routes */}
          {plan.routes.length > 0 && (
            <div className="border border-gray-800 rounded p-2">
              <div className="text-purple-400 mb-1">OPTIMISED ROUTES ({plan.routes.length})</div>
              {plan.routes.map((r, i) => (
                <div key={i} className="text-gray-300 flex justify-between">
                  <span>• {r.weapon_type.replace(/_/g, " ").toUpperCase()}</span>
                  <span className="text-gray-500">
                    {r.total_dist_km}km · {fmtTime(r.total_time_s)}
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
