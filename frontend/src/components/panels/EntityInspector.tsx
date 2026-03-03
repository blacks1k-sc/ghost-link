"use client";

import { useEntityGraph } from "@/stores/entityGraph";

const SUDA_BADGE: Record<string, { label: string; cls: string }> = {
  CRUISE:     { label: "CRUISE",     cls: "bg-blue-900 text-blue-300" },
  EVADING:    { label: "EVADING",    cls: "bg-yellow-900 text-yellow-300" },
  REALIGNING: { label: "REALIGNING", cls: "bg-orange-900 text-orange-300" },
  TERMINAL:   { label: "TERMINAL",   cls: "bg-red-900 text-red-300" },
  DESTROYED:  { label: "DESTROYED",  cls: "bg-gray-800 text-gray-500" },
  IMPACTED:   { label: "IMPACTED",   cls: "bg-green-900 text-green-300" },
};

interface Props {
  entityId: string;
  onClose: () => void;
}

export default function EntityInspector({ entityId, onClose }: Props) {
  const entity = useEntityGraph((s) => s.getEntity(entityId));

  if (!entity) {
    return (
      <div className="p-4 font-mono text-sm text-gray-500">
        Entity not found.
        <button onClick={onClose} className="block mt-2 text-gray-600 hover:text-white">
          ✕ Close
        </button>
      </div>
    );
  }

  const p = entity.properties as Record<string, unknown>;
  const sudaState = (p.suda_state as string) ?? "CRUISE";
  const sudaBadge = SUDA_BADGE[sudaState] ?? SUDA_BADGE.CRUISE;

  const tauI = typeof p.tau_i === "number" ? p.tau_i : null;
  const fuelPct = typeof p.fuel_pct === "number" ? p.fuel_pct * 100 : null;

  return (
    <div className="p-3 font-mono text-xs text-gray-300 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-gray-500 text-xs">{entity.type} · {entity.domain}</div>
          <div className="text-white font-bold text-sm">
            {(p.weapon_type as string) ?? (p.label as string) ?? entityId.slice(0, 8)}
          </div>
        </div>
        <button onClick={onClose} className="text-gray-600 hover:text-white text-lg leading-none">
          ✕
        </button>
      </div>

      {/* SUDA state badge */}
      {entity.type === "WEAPON" && (
        <div>
          <div className="text-gray-500 mb-1">SUDA STATE</div>
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${sudaBadge.cls}`}>
            {sudaBadge.label}
          </span>
        </div>
      )}

      {/* τ_i gauge */}
      {tauI !== null && (
        <div>
          <div className="text-gray-500 mb-1">TIME-TO-GO (τᵢ)</div>
          <div className="text-cyan-300 text-lg font-bold">{tauI.toFixed(1)}s</div>
        </div>
      )}

      {/* Fuel bar */}
      {fuelPct !== null && (
        <div>
          <div className="text-gray-500 mb-1">FUEL</div>
          <div className="w-full bg-gray-800 rounded-full h-2">
            <div
              className="h-2 rounded-full transition-all"
              style={{
                width: `${fuelPct}%`,
                backgroundColor: fuelPct > 50 ? "#22c55e" : fuelPct > 20 ? "#eab308" : "#ef4444",
              }}
            />
          </div>
          <div className="text-gray-400 mt-0.5">{fuelPct.toFixed(0)}%</div>
        </div>
      )}

      {/* Position */}
      {p.lat != null && (
        <div>
          <div className="text-gray-500 mb-1">POSITION</div>
          <div className="text-gray-300">
            {(p.lat as number).toFixed(3)}°N {(p.lon as number).toFixed(3)}°E
          </div>
          {p.alt_km != null && (
            <div className="text-gray-500">{((p.alt_km as number) * 1000).toFixed(0)}m MSL</div>
          )}
        </div>
      )}

      {/* Speed */}
      {p.speed_mach != null && (
        <div>
          <div className="text-gray-500 mb-1">SPEED</div>
          <div className="text-gray-300">Mach {(p.speed_mach as number).toFixed(2)}</div>
        </div>
      )}

      {/* P_intercept (threats) */}
      {entity.type === "THREAT" && p.p_intercept_base != null && (
        <div>
          <div className="text-gray-500 mb-1">P(INTERCEPT)</div>
          <div className="text-red-400 font-bold">
            {((p.p_intercept_base as number) * 100).toFixed(0)}%
          </div>
          <div className="text-gray-500">Radius: {p.radius_km as number}km</div>
        </div>
      )}

      {/* Raw properties (debug) */}
      <details className="mt-2">
        <summary className="text-gray-600 cursor-pointer hover:text-gray-400">
          Raw properties
        </summary>
        <pre className="text-gray-600 text-xs mt-1 overflow-x-auto">
          {JSON.stringify(p, null, 2)}
        </pre>
      </details>
    </div>
  );
}
