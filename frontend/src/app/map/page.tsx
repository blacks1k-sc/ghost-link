"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { useEntityWebSocket } from "@/hooks/useWebSocket";
import { useEntityGraph } from "@/stores/entityGraph";
import EntityInspector from "@/components/panels/EntityInspector";

const CesiumGlobe = dynamic(() => import("@/components/map/CesiumGlobe"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#050a12] text-gray-600 font-mono text-xs tracking-widest">
      INITIALIZING GLOBE…
    </div>
  ),
});

export default function MapPage() {
  useEntityWebSocket();

  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const { wsConnected, simRunning, simTimeS, getWeapons, getTargets, getThreats } = useEntityGraph();

  const weapons = getWeapons();
  const aliveWeapons = weapons.filter(
    (w) => !["DESTROYED", "IMPACTED"].includes((w.properties.suda_state as string) ?? "")
  );
  const targets = getTargets();
  const threats = getThreats();

  const formatSimTime = (s: number) => {
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `T+${Math.floor(s / 3600) > 0 ? `${Math.floor(s / 3600)}h` : ""}${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="fixed inset-0 bg-[#050a12]">

      {/* Full-screen globe — fills the entire viewport */}
      <div className="absolute inset-0">
        <CesiumGlobe
          mode="live"
          onEntitySelect={setSelectedEntityId}
          selectedEntityId={selectedEntityId}
        />
      </div>

      {/* ── TOP BAR (floating) ───────────────────────────────────────── */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center h-10 px-3 gap-3 bg-gradient-to-b from-[#080e1aee] to-transparent pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-3">
          <Link
            href="/kinetic"
            className="text-cyan-400 font-mono font-bold tracking-[0.2em] text-sm hover:text-cyan-300"
          >
            ← GHOST-LINK C2
          </Link>

          <span
            className={`text-xs px-1.5 py-0.5 rounded font-mono border ${
              wsConnected
                ? "border-green-700 bg-green-950/80 text-green-400"
                : "border-red-700 bg-red-950/80 text-red-400"
            }`}
          >
            {wsConnected ? "● ONLINE" : "● OFFLINE"}
          </span>

          {simRunning && (
            <span className="text-cyan-600 font-mono text-xs tracking-wider">
              {formatSimTime(simTimeS)}
            </span>
          )}
        </div>
      </div>

      {/* ── BOTTOM-LEFT: asset counts (floating) ─────────────────────── */}
      <div className="absolute bottom-4 left-4 z-20 pointer-events-none">
        <div className="bg-[#080e1a]/80 border border-[#1a2a40] rounded px-3 py-2 font-mono text-xs backdrop-blur-sm">
          <div className="flex gap-4">
            <span className="text-gray-500">
              WEAPONS <span className="text-blue-400">{aliveWeapons.length}/{weapons.length}</span>
            </span>
            <span className="text-gray-500">
              TARGETS <span className="text-red-400">{targets.length}</span>
            </span>
            <span className="text-gray-500">
              THREATS <span className="text-orange-400">{threats.length}</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── ENTITY INSPECTOR (floating right panel on entity click) ─── */}
      {selectedEntityId && (
        <div className="absolute top-12 right-3 bottom-4 z-20 w-64 bg-[#080e1a]/95 border border-[#1a2a40] rounded overflow-y-auto backdrop-blur-sm">
          <EntityInspector
            entityId={selectedEntityId}
            onClose={() => setSelectedEntityId(null)}
          />
        </div>
      )}
    </div>
  );
}
