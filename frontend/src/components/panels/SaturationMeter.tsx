"use client";

import { useEffect, useState } from "react";
import { useEntityGraph } from "@/stores/entityGraph";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface McResult {
  sc_mean: number;
  penetration_rate_mean: number;
  penetration_rate_p10: number;
  penetration_rate_p50: number;
  penetration_rate_p90: number;
  trials_run: number;
  error?: string;
}

export default function SaturationMeter() {
  const { getWeapons, getThreats, simRunning } = useEntityGraph();
  const [mc, setMc] = useState<McResult | null>(null);

  // Poll /saturation every 5s while sim is running
  useEffect(() => {
    if (!simRunning) {
      setMc(null);
      return;
    }
    const poll = async () => {
      try {
        const res = await fetch(`${API}/saturation`);
        if (res.ok) setMc(await res.json());
      } catch {
        // backend unavailable — keep showing local formula
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [simRunning]);

  // Local formula fallback
  const weapons = getWeapons().filter(
    (w) => !["DESTROYED", "IMPACTED"].includes((w.properties.suda_state as string) ?? "")
  );
  const threats = getThreats();
  const nAttacking = weapons.length;
  const nInterceptors = threats.reduce(
    (sum, t) => sum + ((t.properties.missiles_remaining as number) ?? 8),
    0
  );
  const pKillMean = threats.length
    ? threats.reduce((s, t) => s + ((t.properties.p_intercept_base as number) ?? 0.7), 0) / threats.length
    : 0.75;

  // Prefer Monte Carlo result when available
  const useMc = mc && !mc.error && mc.trials_run > 0;
  const sc = useMc
    ? mc!.sc_mean
    : nInterceptors === 0 || pKillMean === 0
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
    <div className="bg-[#0a1628] border border-[#1a2a40] rounded p-2">
      <div className="text-gray-500 text-xs font-mono mb-1">
        SATURATION COEFF {useMc && <span className="text-gray-600">[MC]</span>}
      </div>
      <div className={`text-2xl font-bold font-mono ${scColor}`}>{scDisplay}</div>
      <div className={`text-xs font-mono ${scColor}`}>{scLabel}</div>
      {useMc ? (
        <div className="mt-1 text-gray-500 text-xs font-mono">
          P(pen) {(mc!.penetration_rate_p50 * 100).toFixed(0)}%&nbsp;
          [{(mc!.penetration_rate_p10 * 100).toFixed(0)}–{(mc!.penetration_rate_p90 * 100).toFixed(0)}%]
        </div>
      ) : (
        <div className="mt-1 text-gray-600 text-xs font-mono">
          {nAttacking}W / {nInterceptors}I×{(pKillMean * 100).toFixed(0)}%
        </div>
      )}
    </div>
  );
}
