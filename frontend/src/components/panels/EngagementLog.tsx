"use client";

import { useEntityGraph } from "@/stores/entityGraph";

const EVENT_COLORS: Record<string, string> = {
  WEAPON_LAUNCHED: "text-blue-400",
  EVASION_START: "text-yellow-400",
  EVASION_END: "text-orange-400",
  THREAT_DETECTED: "text-red-400",
  WEAPON_DESTROYED: "text-red-600",
  IMPACT: "text-green-400",
  TOT_UPDATED: "text-cyan-400",
  TOT_CONVERGED: "text-emerald-400",
};

export default function EngagementLog() {
  const { eventLog } = useEntityGraph();

  return (
    <div className="h-full flex flex-col bg-gray-950">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-gray-800 shrink-0">
        <span className="text-xs font-mono text-gray-400 uppercase tracking-widest">
          Engagement Log
        </span>
        <span className="text-xs text-gray-600 font-mono">{eventLog.length} events</span>
      </div>
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {eventLog.length === 0 ? (
          <div className="px-3 py-2 text-gray-600">No events yet. Launch to begin.</div>
        ) : (
          eventLog.map((ev, i) => (
            <div
              key={i}
              className="flex items-start gap-3 px-3 py-0.5 hover:bg-gray-900 border-b border-gray-900"
            >
              <span className="text-gray-600 shrink-0 w-14">
                T+{(ev.timestamp_ms / 1000).toFixed(1)}s
              </span>
              <span className={`shrink-0 w-36 ${EVENT_COLORS[ev.event_type] ?? "text-gray-300"}`}>
                {ev.event_type}
              </span>
              <span className="text-gray-500 truncate">
                {ev.entity_id.slice(0, 8)}…{" "}
                {ev.payload?.description as string ?? ev.payload?.threat_type as string ?? ""}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
