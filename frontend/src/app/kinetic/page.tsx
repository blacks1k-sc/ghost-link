"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { useEntityWebSocket } from "@/hooks/useWebSocket";
import { useEntityGraph } from "@/stores/entityGraph";
import EngagementLog from "@/components/panels/EngagementLog";
import TotConvergencePanel from "@/components/panels/TotConvergencePanel";
import EntityInspector from "@/components/panels/EntityInspector";
import SaturationMeter from "@/components/panels/SaturationMeter";
import PlannerChat from "@/components/panels/PlannerChat";

const CesiumGlobe = dynamic(() => import("@/components/map/CesiumGlobe"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-[#050a12] text-gray-600 font-mono text-sm tracking-widest">
      INITIALIZING GLOBE…
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
  const [grayscale, setGrayscale] = useState(false);
  const { simRunning, wsConnected, simTimeS } = useEntityGraph();

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
    setMode("planning");
  };

  const formatSimTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `T+${h > 0 ? `${h}h` : ""}${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#050a12] overflow-hidden select-none">

      {/* ── TOP BAR ─────────────────────────────────────────────────── */}
      <header className="flex items-center h-10 px-3 bg-[#080e1a] border-b border-[#1a2a40] z-20 shrink-0 gap-3">
        {/* Brand */}
        <span className="text-cyan-400 font-mono font-bold tracking-[0.2em] text-sm">
          GHOST-LINK C2
        </span>

        {/* WS status */}
        <span
          className={`text-xs px-1.5 py-0.5 rounded font-mono border ${
            wsConnected
              ? "border-green-700 bg-green-950 text-green-400"
              : "border-red-700 bg-red-950 text-red-400"
          }`}
        >
          {wsConnected ? "● ONLINE" : "● OFFLINE"}
        </span>

        {/* Sim time */}
        {simRunning && (
          <span className="text-cyan-600 font-mono text-xs tracking-wider">
            {formatSimTime(simTimeS)}
          </span>
        )}

        <Link
          href="/missions"
          className="text-xs font-mono text-gray-500 hover:text-cyan-400 px-2 py-0.5 rounded hover:bg-[#0f1f35] transition-colors"
        >
          MISSIONS
        </Link>
        <Link
          href="/map"
          className="text-xs font-mono text-gray-500 hover:text-cyan-400 px-2 py-0.5 rounded hover:bg-[#0f1f35] transition-colors"
        >
          MAP
        </Link>

        {/* Mode toggle — centered */}
        <div className="flex-1 flex justify-center">
          <div className="flex items-center bg-[#0a1628] border border-[#1a2a40] rounded overflow-hidden">
            {(["planning", "live"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-5 py-1 text-xs font-mono uppercase tracking-widest transition-colors ${
                  mode === m
                    ? "bg-cyan-700 text-white"
                    : "text-gray-500 hover:text-gray-200"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          {/* B&W toggle */}
          <button
            onClick={() => setGrayscale((v) => !v)}
            title={grayscale ? "Switch to color" : "Switch to B&W"}
            className={`px-2 py-1 text-xs font-mono rounded border transition-colors ${
              grayscale
                ? "border-gray-400 bg-gray-800 text-white"
                : "border-[#1a2a40] text-gray-600 hover:text-gray-300 hover:border-gray-600"
            }`}
          >
            {grayscale ? "◑ COLOR" : "◑ B&W"}
          </button>

          {mode === "planning" && (
            <button
              onClick={() => setShowPlanner((v) => !v)}
              className={`px-3 py-1 text-xs font-mono rounded border transition-colors ${
                showPlanner
                  ? "border-indigo-500 bg-indigo-900 text-indigo-200"
                  : "border-indigo-800 bg-indigo-950 text-indigo-400 hover:border-indigo-600"
              }`}
            >
              AI PLANNER
            </button>
          )}

          {!simRunning ? (
            <button
              onClick={handleLaunch}
              className="px-4 py-1 text-xs font-mono bg-red-700 hover:bg-red-600 border border-red-500 rounded text-white font-bold tracking-widest transition-colors"
            >
              LAUNCH
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="px-4 py-1 text-xs font-mono bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded text-gray-300 tracking-widest transition-colors"
            >
              STOP SIM
            </button>
          )}
        </div>
      </header>

      {/* ── MAIN AREA ───────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT SIDEBAR — data panels */}
        <aside className="w-44 shrink-0 flex flex-col gap-2 p-2 bg-[#080e1a] border-r border-[#1a2a40] overflow-y-auto z-10">
          <TotConvergencePanel />
          <SaturationMeter />

          {/* Entity count summary */}
          <EntityCountSummary />
        </aside>

        {/* AI PLANNER DRAWER — overlays globe from left */}
        {showPlanner && mode === "planning" && (
          <div className="w-80 shrink-0 flex flex-col bg-[#080e1a] border-r border-[#1a2a40] z-10 overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#1a2a40]">
              <span className="text-indigo-400 font-mono text-xs tracking-widest">AI PLANNER</span>
              <button
                onClick={() => setShowPlanner(false)}
                className="text-gray-600 hover:text-white text-sm leading-none"
              >
                ✕
              </button>
            </div>
            <div className="flex-1">
              <PlannerChat />
            </div>
          </div>
        )}

        {/* GLOBE — fills remaining space */}
        <div className="flex-1 relative min-w-0 h-full">
          <CesiumGlobe
            mode={mode}
            onEntitySelect={setSelectedEntityId}
            selectedEntityId={selectedEntityId}
            grayscale={grayscale}
          />

          {/* Mode label watermark */}
          <div className="absolute top-2 right-2 pointer-events-none z-10">
            <span className="text-xs font-mono text-gray-700 tracking-widest uppercase">
              {mode} MODE
            </span>
          </div>
        </div>

        {/* RIGHT PANEL — entity inspector */}
        {selectedEntityId && (
          <aside className="w-64 shrink-0 flex flex-col bg-[#080e1a] border-l border-[#1a2a40] overflow-y-auto z-10">
            <EntityInspector
              entityId={selectedEntityId}
              onClose={() => setSelectedEntityId(null)}
            />
          </aside>
        )}
      </div>

      {/* ── BOTTOM BAR — engagement log ─────────────────────────────── */}
      <div className="h-28 shrink-0 border-t border-[#1a2a40]">
        <EngagementLog />
      </div>
    </div>
  );
}

/** Compact entity counts shown in left sidebar */
function EntityCountSummary() {
  const { getWeapons, getTargets, getThreats } = useEntityGraph();
  const weapons = getWeapons();
  const alive = weapons.filter(
    (w) => !["DESTROYED", "IMPACTED"].includes((w.properties.suda_state as string) ?? "")
  );
  const targets = getTargets();
  const threats = getThreats();

  return (
    <div className="bg-[#0a1628] border border-[#1a2a40] rounded p-2 text-xs font-mono">
      <div className="text-gray-600 text-xs mb-1.5 tracking-widest">ASSETS</div>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between">
          <span className="text-gray-500">Weapons</span>
          <span className="text-blue-400">{alive.length}/{weapons.length}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Targets</span>
          <span className="text-red-400">{targets.length}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Threats</span>
          <span className="text-orange-400">{threats.length}</span>
        </div>
      </div>
    </div>
  );
}
