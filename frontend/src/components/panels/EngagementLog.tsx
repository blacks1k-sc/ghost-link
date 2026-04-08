"use client";

import { useEntityGraph } from "@/stores/entityGraph";

// Event type → display label + semantic color (light-on-dark for ink-bar zone)
const EV: Record<string, { label: string; color: string; bg: string }> = {
  WEAPON_LAUNCHED:  { label: "LAUNCH",   color: "rgba(100,180,255,0.90)", bg: "rgba(74,154,255,0.12)" },
  EVASION_START:    { label: "EVADE",    color: "rgba(220,160,60,0.90)",  bg: "rgba(208,136,32,0.12)" },
  EVASION_END:      { label: "REALIGN",  color: "rgba(190,148,40,0.85)",  bg: "rgba(176,128,24,0.10)" },
  THREAT_DETECTED:  { label: "THREAT",   color: "rgba(240,90,80,0.90)",   bg: "rgba(216,56,56,0.14)" },
  WEAPON_DESTROYED: { label: "DESTRUCT", color: "rgba(240,90,80,0.90)",   bg: "rgba(216,56,56,0.14)" },
  IMPACT:           { label: "IMPACT",   color: "rgba(60,210,120,0.90)",  bg: "rgba(26,184,88,0.14)" },
  TOT_UPDATED:      { label: "TOT",      color: "rgba(60,200,240,0.85)",  bg: "rgba(20,200,232,0.10)" },
  TOT_CONVERGED:    { label: "CONV",     color: "rgba(60,210,120,0.90)",  bg: "rgba(26,184,88,0.14)" },
};

export default function EngagementLog() {
  const { eventLog } = useEntityGraph();

  return (
    <div className="h-full flex flex-col">

      {/* Console header bar */}
      <div className="flex items-center gap-4 px-5 py-2 shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <span className="gl-label-inv">Engagement Log</span>
        <span className="font-mono text-[9px] tabular-nums" style={{ color: "rgba(191,185,177,0.50)" }}>
          {eventLog.length} events
        </span>
        {/* Column headers */}
        <div className="ml-auto flex items-center gap-0 font-mono text-[8px] tracking-[0.12em] uppercase"
          style={{ color: "rgba(191,185,177,0.35)" }}>
          <span className="w-[72px]">Time</span>
          <span className="w-[76px]">Type</span>
          <span className="w-[72px]">Asset</span>
          <span>Detail</span>
        </div>
      </div>

      {/* Log rows */}
      <div className="flex-1 overflow-y-auto">
        {eventLog.length === 0 ? (
          <div className="px-5 py-3 font-mono text-[10px]" style={{ color: "rgba(191,185,177,0.40)" }}>
            No events — launch simulation to begin
          </div>
        ) : (
          <table className="w-full border-collapse font-mono text-[9px]"
            style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 72 }} />
              <col style={{ width: 76 }} />
              <col style={{ width: 72 }} />
              <col />
            </colgroup>
            <tbody>
              {eventLog.map((ev, i) => {
                const meta = EV[ev.event_type];
                const desc = (ev.payload?.description as string) ?? (ev.payload?.threat_type as string) ?? "";
                return (
                  <tr
                    key={i}
                    className="transition-colors duration-75"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.025)" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = "rgba(255,255,255,0.025)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = "transparent")}
                  >
                    {/* Time */}
                    <td className="pl-5 pr-2 py-1.5 whitespace-nowrap tabular-nums"
                      style={{ color: "rgba(191,185,177,0.55)" }}>
                      T+{(ev.timestamp_ms / 1000).toFixed(1)}s
                    </td>
                    {/* Event badge */}
                    <td className="pr-2 py-1.5 whitespace-nowrap">
                      {meta ? (
                        <span className="inline-block font-mono text-[8px] px-1.5 py-0.5 rounded tracking-[0.08em]"
                          style={{ color: meta.color, background: meta.bg }}>
                          {meta.label}
                        </span>
                      ) : (
                        <span style={{ color: "rgba(191,185,177,0.45)" }}>{ev.event_type.slice(0, 8)}</span>
                      )}
                    </td>
                    {/* Entity */}
                    <td className="pr-2 py-1.5 truncate tabular-nums"
                      style={{ color: "rgba(191,185,177,0.40)" }}>
                      {ev.entity_id.slice(0, 8)}
                    </td>
                    {/* Description */}
                    <td className="pr-5 py-1.5 truncate"
                      style={{ color: "rgba(237,234,227,0.70)" }}>
                      {desc}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
