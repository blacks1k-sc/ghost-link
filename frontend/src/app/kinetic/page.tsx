"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useEntityWebSocket } from "@/hooks/useWebSocket";
import { useEntityGraph } from "@/stores/entityGraph";
import EngagementLog from "@/components/panels/EngagementLog";
import TotConvergencePanel from "@/components/panels/TotConvergencePanel";
import EntityInspector from "@/components/panels/EntityInspector";
import SaturationMeter from "@/components/panels/SaturationMeter";
import PlannerChat from "@/components/panels/PlannerChat";

// Cesium must be loaded client-side only (no SSR)
const CesiumGlobe = dynamic(() => import("@/components/map/CesiumGlobe"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-gray-950 text-gray-400">
      Loading Cesium Globe...
    </div>
  ),
});

type Mode = "planning" | "live";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function KineticPage() {
  useEntityWebSocket();

  const [mode, setMode] = useState<Mode>("planning");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [showPlanner, setShowPlanner] = useState(false);
  const { simRunning, wsConnected } = useEntityGraph();

  const handleLaunch = async () => {
    await fetch(`${API}/simulation/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sim_speed: 1.0, duration_s: 7200 }),
    });
    setMode("live");
  };

  const handleStop = async () => {
    await fetch(`${API}/simulation/stop`, { method: "POST" });
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-black overflow-hidden">
      {/* Top nav */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-950 border-b border-gray-800 z-10 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-cyan-400 font-mono font-bold tracking-widest text-sm">
            GHOST-LINK C2
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded font-mono ${
              wsConnected
                ? "bg-green-900 text-green-300"
                : "bg-red-900 text-red-300"
            }`}
          >
            {wsConnected ? "CONNECTED" : "OFFLINE"}
          </span>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 bg-gray-900 rounded p-0.5">
          {(["planning", "live"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-1 rounded text-xs font-mono uppercase transition-colors ${
                mode === m
                  ? "bg-cyan-700 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {mode === "planning" && (
            <button
              onClick={() => setShowPlanner((v) => !v)}
              className="px-3 py-1 text-xs font-mono bg-indigo-800 hover:bg-indigo-700 rounded text-white"
            >
              AI PLANNER
            </button>
          )}
          {mode === "planning" ? (
            <button
              onClick={handleLaunch}
              className="px-4 py-1 text-xs font-mono bg-red-700 hover:bg-red-600 rounded text-white font-bold"
            >
              LAUNCH
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="px-4 py-1 text-xs font-mono bg-gray-700 hover:bg-gray-600 rounded text-white"
            >
              STOP
            </button>
          )}
        </div>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — only in planning mode */}
        {mode === "planning" && showPlanner && (
          <div className="w-80 shrink-0 bg-gray-950 border-r border-gray-800 overflow-y-auto">
            <PlannerChat />
          </div>
        )}

        {/* Cesium map — takes remaining space */}
        <div className="flex-1 relative">
          <CesiumGlobe
            mode={mode}
            onEntitySelect={setSelectedEntityId}
            selectedEntityId={selectedEntityId}
          />

          {/* Floating top-left panels */}
          <div className="absolute top-3 left-3 flex flex-col gap-2 z-10 pointer-events-none">
            <div className="pointer-events-auto">
              <TotConvergencePanel />
            </div>
            <div className="pointer-events-auto">
              <SaturationMeter />
            </div>
          </div>
        </div>

        {/* Right panel — entity inspector */}
        {selectedEntityId && (
          <div className="w-72 shrink-0 bg-gray-950 border-l border-gray-800 overflow-y-auto">
            <EntityInspector
              entityId={selectedEntityId}
              onClose={() => setSelectedEntityId(null)}
            />
          </div>
        )}
      </div>

      {/* Bottom engagement log */}
      <div className="h-36 shrink-0 border-t border-gray-800">
        <EngagementLog />
      </div>
    </div>
  );
}
