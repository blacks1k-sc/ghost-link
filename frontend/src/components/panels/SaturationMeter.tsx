"use client";

import { useEntityGraph } from "@/stores/entityGraph";

export default function SaturationMeter() {
  const { getWeapons, getThreats } = useEntityGraph();
  const weapons = getWeapons().filter(
    (w) => !["DESTROYED", "IMPACTED"].includes((w.properties.suda_state as string) ?? "")
  );
  const threats = getThreats();

  // Simplified SC calculation from live counts
  const nAttacking = weapons.length;
  const nInterceptors = threats.reduce(
    (sum, t) => sum + ((t.properties.missiles_remaining as number) ?? 8),
    0
  );
  const pKillMean = threats.length
    ? threats.reduce((s, t) => s + ((t.properties.p_intercept_base as number) ?? 0.7), 0) / threats.length
    : 0.75;

  const sc =
    nInterceptors === 0 || pKillMean === 0
      ? Infinity
      : nAttacking / (nInterceptors * pKillMean);

  const scDisplay = isFinite(sc) ? sc.toFixed(2) : "∞";
  const scColor =
    !isFinite(sc) || sc > 1.5
      ? "text-green-400"
      : sc >= 0.8
      ? "text-yellow-400"
      : "text-red-400";
  const scLabel =
    !isFinite(sc) || sc > 1.5
      ? "SATURATION"
      : sc >= 0.8
      ? "CONTESTED"
      : "DEFENSIVE ADV";

  return (
    <div className="bg-gray-950 border border-gray-800 rounded p-2 min-w-32">
      <div className="text-gray-500 text-xs font-mono mb-1">SATURATION COEFF</div>
      <div className={`text-2xl font-bold font-mono ${scColor}`}>{scDisplay}</div>
      <div className={`text-xs font-mono ${scColor}`}>{scLabel}</div>
      <div className="mt-1 text-gray-600 text-xs font-mono">
        {nAttacking}W / {nInterceptors}I×{(pKillMean * 100).toFixed(0)}%
      </div>
    </div>
  );
}
