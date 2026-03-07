"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, useEffect, type ReactNode } from "react";
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface WeaponCatalogItem {
  id: string;
  name: string;
  full_name: string;
  domain: "AIR" | "SEA" | "LAND";
  type: string;
  country: string;
  range_km: number;
  speed_mach: number;
  cruise_altitude_m: [number, number];
  stealth: boolean;
  evasion_capable: boolean;
  guidance: string[];
}

interface PlatformCatalogItem {
  id: string;
  name: string;
  full_name: string;
  domain: "AIR" | "SEA" | "LAND";
  type: string;
  country: string;
  range_km: number;
  speed_mach: number;
  payload_kg?: number;
  stealth: boolean;
  compatible_weapons?: string[];
  crew?: number;
  refuelable?: boolean;
  icon?: string;
}

type PendingWeapon = Pick<
  WeaponCatalogItem,
  "name" | "domain" | "speed_mach" | "cruise_altitude_m" | "stealth" | "evasion_capable"
>;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function KineticPage() {
  useEntityWebSocket();

  const [mode, setMode] = useState<Mode>("planning");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [showPlanner, setShowPlanner] = useState(false);
  const [showAssetsPanel, setShowAssetsPanel] = useState(false);
  const [pendingWeapon, setPendingWeapon] = useState<PendingWeapon | null>(null);
  const { simRunning, wsConnected, simTimeS } = useEntityGraph();

  // ESC cancels pending weapon placement
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPendingWeapon(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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

  // Mutually exclusive drawers
  const openAssets  = () => { setShowAssetsPanel((v) => !v); setShowPlanner(false); };
  const openPlanner = () => { setShowPlanner((v) => !v); setShowAssetsPanel(false); };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#050a12] overflow-hidden select-none">

      {/* ── TOP BAR ───────────────────────────────────────────────── */}
      <header className="flex items-center h-10 px-3 bg-[#080e1a] border-b border-[#1a2a40] z-20 shrink-0 gap-3">
        <span className="text-cyan-400 font-mono font-bold tracking-[0.2em] text-sm">
          GHOST-LINK C2
        </span>

        <span className={`text-xs px-1.5 py-0.5 rounded font-mono border ${
          wsConnected
            ? "border-green-700 bg-green-950 text-green-400"
            : "border-red-700 bg-red-950 text-red-400"
        }`}>
          {wsConnected ? "● ONLINE" : "● OFFLINE"}
        </span>

        {simRunning && (
          <span className="text-cyan-600 font-mono text-xs tracking-wider">
            {formatSimTime(simTimeS)}
          </span>
        )}

        <Link href="/missions" className="text-xs font-mono text-gray-500 hover:text-cyan-400 px-2 py-0.5 rounded hover:bg-[#0f1f35] transition-colors">
          MISSIONS
        </Link>
        <Link href="/map" className="text-xs font-mono text-gray-500 hover:text-cyan-400 px-2 py-0.5 rounded hover:bg-[#0f1f35] transition-colors">
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
                  mode === m ? "bg-cyan-700 text-white" : "text-gray-500 hover:text-gray-200"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          {mode === "planning" && (
            <>
              <button
                onClick={openAssets}
                className={`px-3 py-1 text-xs font-mono rounded border transition-colors ${
                  showAssetsPanel
                    ? "border-green-500 bg-green-900 text-green-200"
                    : "border-green-800 bg-green-950 text-green-400 hover:border-green-600"
                }`}
              >
                ADD ASSETS
              </button>
              <button
                onClick={openPlanner}
                className={`px-3 py-1 text-xs font-mono rounded border transition-colors ${
                  showPlanner
                    ? "border-indigo-500 bg-indigo-900 text-indigo-200"
                    : "border-indigo-800 bg-indigo-950 text-indigo-400 hover:border-indigo-600"
                }`}
              >
                AI PLANNER
              </button>
            </>
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

      {/* ── MAIN AREA ─────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT SIDEBAR — data panels */}
        <aside className="w-44 shrink-0 flex flex-col gap-2 p-2 bg-[#080e1a] border-r border-[#1a2a40] overflow-y-auto z-10">
          <TotConvergencePanel />
          <SaturationMeter />
          <EntityCountSummary />
        </aside>

        {/* ADD ASSETS DRAWER */}
        {showAssetsPanel && mode === "planning" && (
          <div className="w-80 shrink-0 flex flex-col bg-[#080e1a] border-r border-[#1a2a40] z-10 overflow-hidden">
            <AssetsPanel
              onClose={() => setShowAssetsPanel(false)}
              onSetPendingWeapon={(w) => {
                setPendingWeapon(w);
                setShowAssetsPanel(false);
              }}
            />
          </div>
        )}

        {/* AI PLANNER DRAWER */}
        {showPlanner && mode === "planning" && (
          <div className="w-80 shrink-0 flex flex-col bg-[#080e1a] border-r border-[#1a2a40] z-10 overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#1a2a40]">
              <span className="text-indigo-400 font-mono text-xs tracking-widest">AI PLANNER</span>
              <button onClick={() => setShowPlanner(false)} className="text-gray-600 hover:text-white text-sm leading-none">✕</button>
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
            pendingWeapon={pendingWeapon}
            onWeaponPlaced={() => setPendingWeapon(null)}
          />

          {/* Mode label watermark */}
          <div className="absolute top-2 right-2 pointer-events-none z-10">
            <span className="text-xs font-mono text-gray-700 tracking-widest uppercase">
              {mode} MODE
            </span>
          </div>

          {/* Pending weapon placement banner */}
          {pendingWeapon && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
              <div className="bg-cyan-950/95 border border-cyan-600 rounded-full px-5 py-2 font-mono text-xs text-cyan-300 flex items-center gap-3 shadow-lg">
                <span className="text-cyan-500 text-base leading-none">⊕</span>
                <span>
                  CLICK GLOBE TO DEPLOY{" "}
                  <span className="text-white font-bold">{pendingWeapon.name}</span>
                  <span className="text-gray-500 ml-2">· {pendingWeapon.domain}</span>
                </span>
                <button
                  onClick={() => setPendingWeapon(null)}
                  className="text-gray-500 hover:text-red-400 ml-1 leading-none"
                  title="Cancel (ESC)"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
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

      {/* ── BOTTOM BAR — engagement log ───────────────────────────── */}
      <div className="h-28 shrink-0 border-t border-[#1a2a40]">
        <EngagementLog />
      </div>
    </div>
  );
}

// ── EntityCountSummary ────────────────────────────────────────────────────────

function EntityCountSummary() {
  const { getWeapons, getTargets, getThreats } = useEntityGraph();
  const weapons = getWeapons();
  const alive = weapons.filter(
    (w) => !["DESTROYED", "IMPACTED"].includes((w.properties.suda_state as string) ?? ""),
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

// ── AssetsPanel ───────────────────────────────────────────────────────────────

function AssetsPanel({
  onClose,
  onSetPendingWeapon,
}: {
  onClose: () => void;
  onSetPendingWeapon: (w: PendingWeapon) => void;
}) {
  const [tab, setTab] = useState<"WEAPONS" | "TARGETS">("WEAPONS");
  const [domain, setDomain] = useState<"AIR" | "SEA" | "LAND">("AIR");
  const [catalog, setCatalog] = useState<WeaponCatalogItem[]>([]);
  const [platforms, setPlatforms] = useState<PlatformCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetForm, setTargetForm] = useState({ lat: "", lon: "", label: "" });
  const [placing, setPlacing] = useState(false);
  const [selectedWeapon, setSelectedWeapon] = useState<WeaponCatalogItem | null>(null);

  useEffect(() => {
    fetch(`${API}/weapons/catalog`)
      .then((r) => r.json())
      .then((data) => {
        setCatalog(data.weapons ?? []);
        setPlatforms(data.platforms ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = catalog.filter((w) => w.domain === domain);
  const filteredPlatforms = platforms.filter((p) => p.domain === domain);

  const handlePlaceTarget = async () => {
    const lat = parseFloat(targetForm.lat);
    const lon = parseFloat(targetForm.lon);
    if (isNaN(lat) || isNaN(lon)) return;
    setPlacing(true);
    await fetch(`${API}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "TARGET",
        domain: "LAND",
        properties: { lat, lon, alt_km: 0, label: targetForm.label || `Target ${Date.now()}` },
      }),
    });
    setTargetForm({ lat: "", lon: "", label: "" });
    setPlacing(false);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1a2a40] shrink-0">
        <span className="text-green-400 font-mono text-xs tracking-widest">ADD ASSETS</span>
        <button onClick={onClose} className="text-gray-600 hover:text-white text-sm leading-none">✕</button>
      </div>

      {/* WEAPONS / TARGETS tabs */}
      <div className="flex border-b border-[#1a2a40] shrink-0">
        {(["WEAPONS", "TARGETS"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-xs font-mono tracking-widest transition-colors ${
              tab === t
                ? "bg-[#0f1f35] text-cyan-400 border-b-2 border-cyan-600"
                : "text-gray-600 hover:text-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── WEAPONS TAB ── */}
      {tab === "WEAPONS" && (
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Domain sub-tabs: AIR / SEA / LAND */}
          <div className="flex shrink-0 border-b border-[#1a2a40]">
            {([
              { key: "AIR",  icon: "✈",  active: "text-blue-400 border-blue-500 bg-blue-950/20" },
              { key: "SEA",  icon: "⚓",  active: "text-cyan-400 border-cyan-500 bg-cyan-950/20" },
              { key: "LAND", icon: "⬡",  active: "text-green-400 border-green-500 bg-green-950/20" },
            ] as const).map(({ key, icon, active }) => (
              <button
                key={key}
                onClick={() => { setDomain(key); setSelectedWeapon(null); }}
                className={`flex-1 py-1.5 text-xs font-mono tracking-wider transition-colors border-b-2 ${
                  domain === key ? `${active} border-b-2` : "text-gray-600 hover:text-gray-400 border-transparent"
                }`}
              >
                {icon} {key}
              </button>
            ))}
          </div>

          {/* Domain description */}
          <div className="px-3 py-1.5 shrink-0 border-b border-[#0f1828]">
            <span className="text-gray-700 font-mono text-[10px] tracking-wide">
              {domain === "AIR"  && "Air-launched: cruise missiles, hypersonic, stealth strike"}
              {domain === "SEA"  && "Sea-launched: anti-ship, land-attack, submarine cruise"}
              {domain === "LAND" && "Ground-launched: ballistic, quasi-ballistic, long-range strike"}
            </span>
          </div>

          {/* ── STEP 2: Platform picker (replaces list when a weapon is selected) ── */}
          {selectedWeapon ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#1a2a40] bg-[#060c18] shrink-0">
                <div>
                  <div className="text-[9px] font-mono text-gray-600 tracking-widest mb-0.5 uppercase">
                    Select Launch Platform
                  </div>
                  <div className="text-blue-300 font-mono text-xs font-bold">{selectedWeapon.name}</div>
                  <div className="text-gray-600 font-mono text-[9px] mt-0.5">
                    M{selectedWeapon.speed_mach} · {selectedWeapon.range_km} km range
                  </div>
                </div>
                <button
                  onClick={() => setSelectedWeapon(null)}
                  className="text-gray-600 hover:text-white text-sm leading-none self-start mt-0.5"
                  title="Back to weapons"
                >
                  ✕
                </button>
              </div>

              {/* Compatible platform list */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {platforms
                  .filter((p) => p.compatible_weapons?.includes(selectedWeapon.id))
                  .map((platform) => (
                    <PlatformCard
                      key={platform.id}
                      platform={platform}
                      deployLabel={`DEPLOY WITH ${platform.name.split(" ")[0].toUpperCase()}`}
                      onDeploy={() => {
                        onSetPendingWeapon({
                          name: `${platform.name} / ${selectedWeapon.name}`,
                          domain: selectedWeapon.domain,
                          speed_mach: selectedWeapon.speed_mach,
                          cruise_altitude_m: selectedWeapon.cruise_altitude_m,
                          stealth: selectedWeapon.stealth,
                          evasion_capable: selectedWeapon.evasion_capable,
                        });
                        setSelectedWeapon(null);
                      }}
                    />
                  ))}
              </div>
            </div>

          ) : (
            /* ── STEP 1: Grouped accordion list ── */
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {loading ? (
                <div className="text-gray-600 font-mono text-xs p-4 text-center tracking-widest animate-pulse">
                  LOADING CATALOG…
                </div>
              ) : (
                <>
                  {/* Munitions grouped by type */}
                  {groupBy(filtered, (w) => w.type).size === 0 && filteredPlatforms.length === 0 && (
                    <div className="text-gray-600 font-mono text-xs p-3">Nothing in {domain} catalog.</div>
                  )}
                  {Array.from(groupBy(filtered, (w) => w.type).entries()).map(([type, group], i) => (
                    <CategoryAccordion
                      key={type}
                      label={TYPE_LABEL[type] ?? type.replace(/_/g, " ")}
                      count={group.length}
                      defaultOpen={i === 0}
                    >
                      {group.map((w) => {
                        const hasCompatiblePlatforms = platforms.some(
                          (p) => p.compatible_weapons?.includes(w.id),
                        );
                        return (
                          <WeaponCard
                            key={w.id}
                            weapon={w}
                            requiresPlatform={hasCompatiblePlatforms}
                            onDeploy={() =>
                              hasCompatiblePlatforms ? setSelectedWeapon(w) : onSetPendingWeapon(w)
                            }
                          />
                        );
                      })}
                    </CategoryAccordion>
                  ))}

                  {/* Standalone platforms (deploy aircraft without a specific weapon) */}
                  {filteredPlatforms.length > 0 &&
                    Array.from(groupBy(filteredPlatforms, (p) => p.type).entries()).map(([type, group]) => (
                      <CategoryAccordion
                        key={type}
                        label={TYPE_LABEL[type] ?? type.replace(/^PLATFORM_/, "").replace(/_/g, " ")}
                        count={group.length}
                      >
                        {group.map((p) => (
                          <PlatformCard
                            key={p.id}
                            platform={p}
                            onDeploy={() =>
                              onSetPendingWeapon({
                                name: p.name,
                                domain: p.domain,
                                speed_mach: p.speed_mach,
                                cruise_altitude_m: [8000, 12000],
                                stealth: p.stealth,
                                evasion_capable: true,
                              })
                            }
                          />
                        ))}
                      </CategoryAccordion>
                    ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── TARGETS TAB ── */}
      {tab === "TARGETS" && (
        <div className="flex-1 overflow-y-auto p-3 space-y-4">

          {/* Click-to-place instruction */}
          <div className="bg-[#0a1628] border border-red-900/50 rounded p-3">
            <div className="text-red-400 font-mono text-[10px] mb-1.5 tracking-widest">CLICK-TO-PLACE</div>
            <p className="text-gray-500 font-mono text-xs leading-relaxed">
              In <span className="text-cyan-400">PLANNING</span> mode, click anywhere
              on the globe to drop a target at that location.
            </p>
          </div>

          {/* Manual coordinate entry */}
          <div className="border-t border-[#1a2a40] pt-3">
            <div className="text-gray-500 font-mono text-[10px] tracking-widest mb-2">
              MANUAL COORDINATES
            </div>
            <div className="space-y-1.5">
              <input
                type="number"
                placeholder="Latitude (−90 to 90)"
                value={targetForm.lat}
                onChange={(e) => setTargetForm((f) => ({ ...f, lat: e.target.value }))}
                className="w-full bg-[#0a1628] border border-[#1a2a40] focus:border-red-800 rounded px-2 py-1.5 text-xs font-mono text-white placeholder-gray-700 outline-none transition-colors"
              />
              <input
                type="number"
                placeholder="Longitude (−180 to 180)"
                value={targetForm.lon}
                onChange={(e) => setTargetForm((f) => ({ ...f, lon: e.target.value }))}
                className="w-full bg-[#0a1628] border border-[#1a2a40] focus:border-red-800 rounded px-2 py-1.5 text-xs font-mono text-white placeholder-gray-700 outline-none transition-colors"
              />
              <input
                type="text"
                placeholder="Label (optional)"
                value={targetForm.label}
                onChange={(e) => setTargetForm((f) => ({ ...f, label: e.target.value }))}
                className="w-full bg-[#0a1628] border border-[#1a2a40] focus:border-red-800 rounded px-2 py-1.5 text-xs font-mono text-white placeholder-gray-700 outline-none transition-colors"
              />
              <button
                onClick={handlePlaceTarget}
                disabled={placing || !targetForm.lat || !targetForm.lon}
                className="w-full py-1.5 text-xs font-mono bg-red-900 hover:bg-red-800 border border-red-700 rounded text-red-200 tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {placing ? "PLACING…" : "⊕  PLACE TARGET"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── WeaponCard ────────────────────────────────────────────────────────────────

const DOMAIN_STYLE = {
  AIR:  {
    badge: "text-blue-400 border-blue-800 bg-blue-950/30",
    btn:   "border-blue-800 bg-blue-950/50 hover:bg-blue-900/60 text-blue-300",
    dot:   "bg-blue-500",
  },
  SEA:  {
    badge: "text-cyan-400 border-cyan-800 bg-cyan-950/30",
    btn:   "border-cyan-800 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-300",
    dot:   "bg-cyan-500",
  },
  LAND: {
    badge: "text-green-400 border-green-800 bg-green-950/30",
    btn:   "border-green-800 bg-green-950/50 hover:bg-green-900/60 text-green-300",
    dot:   "bg-green-500",
  },
} as const;

// ── Accordion helpers ─────────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }
  return map;
}

const TYPE_LABEL: Record<string, string> = {
  CRUISE_MISSILE:       "Cruise Missiles",
  ANTI_SHIP_MISSILE:    "Anti-Ship Missiles",
  HYPERSONIC_MISSILE:   "Hypersonic Missiles",
  BALLISTIC_MISSILE:    "Ballistic Missiles",
  QUASI_BALLISTIC:      "Quasi-Ballistic Missiles",
  PLATFORM_FIGHTER:     "Fighters",
  PLATFORM_BOMBER:      "Bombers",
  PLATFORM_TANKER:      "Tankers",
  PLATFORM_EW:          "EW Aircraft",
  PLATFORM_DESTROYER:   "Destroyers",
  PLATFORM_CRUISER:     "Cruisers",
  PLATFORM_SUBMARINE:   "Submarines",
};

function CategoryAccordion({
  label,
  count,
  defaultOpen = false,
  children,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-[#1a2a40] rounded overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-mono tracking-widest hover:bg-[#0f1828] transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className={`text-gray-600 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>▶</span>
          <span className="text-gray-300 uppercase">{label}</span>
        </span>
        <span className="text-gray-600 text-[9px] bg-[#0a1628] border border-[#1a2a40] px-1.5 py-0.5 rounded">
          {count}
        </span>
      </button>
      {open && (
        <div className="p-2 space-y-2 border-t border-[#1a2a40] bg-[#060c18]">
          {children}
        </div>
      )}
    </div>
  );
}

// ── PlatformCard ──────────────────────────────────────────────────────────────

function PlatformCard({
  platform,
  onDeploy,
  deployLabel,
}: {
  platform: PlatformCatalogItem;
  onDeploy: () => void;
  deployLabel?: string;
}) {
  const typeLabel = (TYPE_LABEL[platform.type] ?? platform.type.replace(/^PLATFORM_/, "").replace(/_/g, " ")).toUpperCase();

  return (
    <div className="bg-[#090f1e] border border-[#1e2e48] hover:border-[#2a4060] rounded p-2.5 transition-colors">

      {/* Name + type badge */}
      <div className="flex items-start justify-between gap-1 mb-0.5">
        <span className="text-white font-mono text-xs font-bold leading-tight">{platform.name}</span>
        <span className="shrink-0 text-[9px] font-mono px-1 py-0.5 border rounded text-blue-300 border-blue-900 bg-blue-950/30">
          {typeLabel}
        </span>
      </div>

      {/* Full name */}
      <div className="text-gray-600 font-mono text-[10px] leading-tight mb-2 truncate" title={platform.full_name}>
        {platform.full_name}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-[10px] font-mono">
          <span className="text-gray-600">M </span>
          <span className="text-gray-300">{platform.speed_mach}</span>
        </span>
        <span className="text-gray-700">·</span>
        <span className="text-[10px] font-mono">
          <span className="text-gray-600">RNG </span>
          <span className="text-gray-300">{platform.range_km} km</span>
        </span>
        {platform.payload_kg != null && (
          <>
            <span className="text-gray-700">·</span>
            <span className="text-[10px] font-mono">
              <span className="text-gray-600">PLD </span>
              <span className="text-gray-300">{(platform.payload_kg / 1000).toFixed(0)}t</span>
            </span>
          </>
        )}
        {platform.stealth && (
          <span className="text-[9px] font-mono px-1 py-0.5 border rounded text-purple-400 border-purple-900 bg-purple-950/40">
            STEALTH
          </span>
        )}
        {platform.refuelable && (
          <span className="text-[9px] font-mono px-1 py-0.5 border rounded text-sky-400 border-sky-900 bg-sky-950/30">
            TANKER
          </span>
        )}
      </div>

      {/* Country */}
      <div className="text-gray-600 font-mono text-[10px] mb-2">
        {platform.country}{platform.crew != null ? ` · ${platform.crew}-crew` : ""}
      </div>

      {/* Compatible weapons */}
      {platform.compatible_weapons && platform.compatible_weapons.length > 0 && (
        <div className="text-gray-700 font-mono text-[10px] mb-2 truncate">
          Arms: {platform.compatible_weapons.slice(0, 3).join(", ")}
        </div>
      )}

      {/* Deploy button */}
      <button
        onClick={onDeploy}
        className="w-full py-1 text-[10px] font-mono border rounded tracking-widest transition-colors border-blue-900 bg-blue-950/30 hover:bg-blue-900/50 text-blue-300"
      >
        {deployLabel ?? "⊕  PLACE ON MAP"}
      </button>
    </div>
  );
}

// ── WeaponCard ────────────────────────────────────────────────────────────────

function WeaponCard({
  weapon,
  onDeploy,
  requiresPlatform = false,
}: {
  weapon: WeaponCatalogItem;
  onDeploy: () => void;
  requiresPlatform?: boolean;
}) {
  const style = DOMAIN_STYLE[weapon.domain] ?? DOMAIN_STYLE.AIR;

  return (
    <div className="bg-[#0a1628] border border-[#1a2a40] hover:border-[#2a4060] rounded p-2.5 transition-colors group">

      {/* Name + domain badge */}
      <div className="flex items-start justify-between gap-1 mb-0.5">
        <span className="text-white font-mono text-xs font-bold leading-tight">{weapon.name}</span>
        <span className={`shrink-0 text-[9px] font-mono px-1 py-0.5 border rounded ${style.badge}`}>
          {weapon.domain}
        </span>
      </div>

      {/* Full name */}
      <div className="text-gray-600 font-mono text-[10px] leading-tight mb-2 truncate" title={weapon.full_name}>
        {weapon.full_name}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-[10px] font-mono">
          <span className="text-gray-600">M </span>
          <span className="text-gray-300">{weapon.speed_mach}</span>
        </span>
        <span className="text-gray-700">·</span>
        <span className="text-[10px] font-mono">
          <span className="text-gray-600">RNG </span>
          <span className="text-gray-300">{weapon.range_km} km</span>
        </span>
        {weapon.stealth && (
          <span className="text-[9px] font-mono px-1 py-0.5 border rounded text-purple-400 border-purple-900 bg-purple-950/40">
            STEALTH
          </span>
        )}
        {weapon.evasion_capable && (
          <span className="text-[9px] font-mono px-1 py-0.5 border rounded text-yellow-500 border-yellow-900 bg-yellow-950/30">
            EVADE
          </span>
        )}
      </div>

      {/* Type · country */}
      <div className="text-gray-600 font-mono text-[10px] mb-1 truncate">
        {weapon.type.replace(/_/g, " ")} · {weapon.country}
      </div>

      {/* Guidance */}
      {weapon.guidance?.length > 0 && (
        <div className="text-gray-700 font-mono text-[10px] mb-2 truncate">
          {weapon.guidance.slice(0, 3).join(" / ")}
        </div>
      )}

      {/* Deploy button */}
      <button
        onClick={onDeploy}
        className={`w-full py-1 text-[10px] font-mono border rounded tracking-widest transition-colors ${style.btn}`}
      >
        {requiresPlatform ? "▶  SELECT PLATFORM" : "⊕  PLACE ON MAP"}
      </button>
    </div>
  );
}
