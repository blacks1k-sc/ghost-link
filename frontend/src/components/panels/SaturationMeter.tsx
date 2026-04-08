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

  useEffect(() => {
    if (!simRunning) { setMc(null); return; }
    const poll = async () => {
      try {
        const res = await fetch(`${API}/saturation`);
        if (res.ok) setMc(await res.json());
      } catch { /* keep local formula */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [simRunning]);

  const weapons = getWeapons().filter(
    (w) => !["DESTROYED", "IMPACTED"].includes((w.properties.suda_state as string) ?? "")
  );
  const threats = getThreats();
  const nAttacking = weapons.length;
  const nInterceptors = threats.reduce((sum, t) => sum + ((t.properties.missiles_remaining as number) ?? 8), 0);
  const pKillMean = threats.length
    ? threats.reduce((s, t) => s + ((t.properties.p_intercept_base as number) ?? 0.7), 0) / threats.length
    : 0.75;

  const useMc = mc && !mc.error && mc.trials_run > 0;
  const sc = useMc
    ? mc!.sc_mean
    : nInterceptors === 0 || pKillMean === 0 ? Infinity
    : nAttacking / (nInterceptors * pKillMean);

  const scDisplay = isFinite(sc) ? sc.toFixed(2) : "∞";
  const [scColor, scLabel] =
    !isFinite(sc) || sc > 1.5 ? ["var(--ac-green)", "SATURATION"]
    : sc >= 0.8              ? ["var(--ac-amber)", "CONTESTED"]
    :                          ["var(--ac-red)",   "DEF ADV"];

  const barFill = isFinite(sc) ? Math.min(100, (sc / 2.0) * 100) : 100;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-0.5">
        <span className="gl-label">Sat Coefficient</span>
        {useMc && (
          <span className="font-mono text-[8px] px-1 py-0.5 rounded"
            style={{ color: "var(--ink-3)", background: "rgba(25,21,15,0.08)", border: "1px solid rgba(25,21,15,0.12)" }}>
            MC
          </span>
        )}
      </div>

      {/* Hero number */}
      <div className="flex items-baseline gap-2 mt-1 mb-1.5">
        <span className="font-mono font-bold tabular-nums leading-none" style={{ fontSize: 24, color: scColor }}>
          {scDisplay}
        </span>
        <span className="font-mono text-[9px] tracking-[0.14em]" style={{ color: scColor, opacity: 0.75 }}>
          {scLabel}
        </span>
      </div>

      {/* Bar indicator */}
      <div className="h-0.5 rounded-full mb-2 overflow-hidden" style={{ background: "rgba(25,21,15,0.12)" }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${barFill}%`, background: scColor }}
        />
      </div>

      {/* Detail */}
      <div className="font-mono text-[9px]" style={{ color: "var(--ink-3)" }}>
        {useMc ? (
          <>
            P(pen){" "}
            <span style={{ color: "var(--ink-2)" }}>{(mc!.penetration_rate_p50 * 100).toFixed(0)}%</span>
            <span style={{ color: "var(--ink-4)" }}>
              {" "}[{(mc!.penetration_rate_p10 * 100).toFixed(0)}–{(mc!.penetration_rate_p90 * 100).toFixed(0)}%]
            </span>
          </>
        ) : (
          <>{nAttacking}W / {nInterceptors}I × {(pKillMean * 100).toFixed(0)}%</>
        )}
      </div>
    </div>
  );
}
