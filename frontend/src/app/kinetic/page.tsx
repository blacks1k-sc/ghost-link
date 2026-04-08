"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, useEffect, type ReactNode, type CSSProperties } from "react";
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
    <div className="w-full h-full flex items-center justify-center font-mono text-[11px] tracking-[0.28em]"
      style={{ background: "var(--app-bg)", color: "var(--t3)" }}>
      INITIALIZING GLOBE
    </div>
  ),
});

// ── Shared glass panel style ──────────────────────────────────────────────────
// Defined once, applied to all floating panels — ensures visual consistency.
const GP: CSSProperties = {
  background:              "rgba(10, 20, 42, 0.78)",
  backdropFilter:          "blur(28px) saturate(180%)",
  WebkitBackdropFilter:    "blur(28px) saturate(180%)",
  border:                  "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius:            "10px",
  boxShadow:
    "0 12px 52px rgba(0,0,0,0.60), 0 3px 14px rgba(0,0,0,0.40), " +
    "inset 0 1px 0 rgba(255,255,255,0.11), inset 0 -1px 0 rgba(0,0,0,0.20)",
};

// Slightly lighter surface for nested card items inside panels
const GPC: CSSProperties = {
  background:   "rgba(18, 32, 58, 0.70)",
  border:       "1px solid rgba(255, 255, 255, 0.06)",
  borderRadius: "6px",
};

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

interface PlanHighlights {
  airbases: Array<{ id: string; name: string; lat: number; lon: number }>;
  carriers: Array<{ lat: number; lon: number; label: string }>;
  routes: Array<{
    weapon_type: string;
    target_id: string;
    airbase_id: string;
    waypoints: Array<{ lat: number; lon: number; label: string }>;
    total_dist_km: number;
    total_time_s: number;
  }>;
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
  const [planHighlights, setPlanHighlights] = useState<PlanHighlights | null>(null);
  const [hoveredRouteWeapon, setHoveredRouteWeapon] = useState<string | null>(null);
  const [viewAllPaths, setViewAllPaths] = useState(false);
  const [pinModeActive, setPinModeActive] = useState(false);
  const [pinnedTargetCoords, setPinnedTargetCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const [simSpeed, setSimSpeed] = useState(1);
  const { simRunning, wsConnected, simTimeS, setSimRunning, impactFlashes, clearImpactFlash } = useEntityGraph();

  useEffect(() => {
    fetch(`${API}/simulation/status`)
      .then((r) => r.json())
      .then((d) => { if (d.running) { setSimRunning(true); setMode("live"); } })
      .catch(() => null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPendingWeapon(null); setPinModeActive(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const handleLaunch = async () => {
    const res = await fetch(`${API}/simulation/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sim_speed: 1.0, duration_s: 7200 }),
    });
    if (res.ok || res.status === 400) { setSimRunning(true); setMode("live"); }
  };

  const handleStop = async () => {
    await fetch(`${API}/simulation/stop`, { method: "POST" });
    setSimRunning(false); setSimSpeed(1); setMode("planning");
  };

  const handleSetSpeed = async (speed: number) => {
    setSimSpeed(speed);
    await fetch(`${API}/simulation/speed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sim_speed: speed }),
    });
  };

  const formatSimTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `T+${h > 0 ? `${h}h` : ""}${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  const openAssets  = () => { setShowAssetsPanel((v) => !v); setShowPlanner(false); };
  const openPlanner = () => { setShowPlanner((v) => !v); setShowAssetsPanel(false); };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none"
      style={{ background: "var(--app-bg)" }}>

      {/* ── GLASS TOP BAR ────────────────────────────────────────────────────── */}
      <header className="gbar flex items-center h-12 px-5 z-30 shrink-0 gap-5">

        {/* Wordmark */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex flex-col justify-center">
            <span className="font-mono text-[12px] font-semibold tracking-[0.28em]"
              style={{ color: "var(--t1)", lineHeight: 1 }}>
              GHOST‑LINK
            </span>
            <span className="font-mono text-[8px] tracking-[0.16em] mt-0.5"
              style={{ color: "var(--t3)", lineHeight: 1 }}>
              COMMAND &amp; CONTROL
            </span>
          </div>
          <div className="w-px h-6 mx-1" style={{ background: "rgba(255,255,255,0.08)" }} />
          <div className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full ${!wsConnected ? "offline-blink" : ""}`}
              style={{ background: wsConnected ? "var(--ac-green)" : "var(--ac-red)" }}
            />
            <span className="font-mono text-[9px] tracking-[0.14em]"
              style={{ color: wsConnected ? "var(--ac-green)" : "var(--ac-red)" }}>
              {wsConnected ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
        </div>

        {simRunning && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded"
            style={{ background: "rgba(20,200,232,0.08)", border: "1px solid rgba(20,200,232,0.18)" }}>
            <div className="w-1 h-1 rounded-full" style={{ background: "var(--ac-cyan)", animation: "offlineBlink 1.4s ease-in-out infinite" }} />
            <span className="font-mono text-[10px] tracking-[0.12em] tabular-nums"
              style={{ color: "var(--ac-cyan)" }}>
              {formatSimTime(simTimeS)}
            </span>
          </div>
        )}

        {/* Nav links */}
        <div className="flex items-center gap-1">
          {[
            { href: "/missions", label: "MISSIONS" },
            { href: "/map",      label: "MAP" },
          ].map(({ href, label }) => (
            <Link key={href} href={href}
              className="font-mono text-[9px] tracking-[0.16em] px-2.5 py-1 rounded transition-all duration-150"
              style={{ color: "var(--t3)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--t2)"; (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.04)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = "var(--t3)"; (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; }}>
              {label}
            </Link>
          ))}
        </div>

        {/* Mode toggle — center */}
        <div className="flex-1 flex justify-center">
          <div className="flex items-center rounded-md overflow-hidden"
            style={{
              background: "rgba(4, 10, 22, 0.80)",
              border: "1px solid rgba(255,255,255,0.07)",
              boxShadow: "inset 0 1px 0 rgba(0,0,0,0.3)",
            }}>
            {(["planning", "live"] as Mode[]).map((m, i) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="px-6 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-all duration-200"
                style={
                  mode === m
                    ? {
                        background: "rgba(74,154,255,0.16)",
                        color: "#7ab8ff",
                        borderRight: i === 0 ? "1px solid rgba(255,255,255,0.08)" : undefined,
                        boxShadow: "inset 0 1px 0 rgba(74,154,255,0.20), inset 0 -1px 0 rgba(74,154,255,0.10)",
                        fontWeight: 500,
                      }
                    : {
                        color: "var(--t3)",
                        borderRight: i === 0 ? "1px solid rgba(255,255,255,0.05)" : undefined,
                      }
                }
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
              <GhostButton active={showAssetsPanel} onClick={openAssets}>
                ASSETS
              </GhostButton>
              <GhostButton active={showPlanner} onClick={openPlanner}>
                AI PLANNER
              </GhostButton>
            </>
          )}

          {!simRunning ? (
            <button
              onClick={handleLaunch}
              className="launch-pulse px-5 py-1.5 font-mono text-[10px] rounded tracking-[0.2em] font-semibold transition-all duration-150"
              style={{
                ...GP,
                background: "rgba(216, 56, 56, 0.14)",
                borderRadius: 6,
                color: "#f07070",
                border: "1px solid rgba(216,56,56,0.40)",
                boxShadow: "0 2px 16px rgba(216,56,56,0.12), inset 0 1px 0 rgba(255,255,255,0.08)",
                backdropFilter: "none",
                WebkitBackdropFilter: "none",
              }}
            >
              LAUNCH
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded overflow-hidden"
                style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(4,10,22,0.7)" }}>
                {([1, 2, 5, 8] as const).map((s, i) => (
                  <button
                    key={s}
                    onClick={() => handleSetSpeed(s)}
                    className="px-2.5 py-1.5 font-mono text-[9px] transition-all duration-100"
                    style={
                      simSpeed === s
                        ? {
                            background: "rgba(208,136,32,0.18)",
                            color: "var(--ac-amber)",
                            borderRight: i < 3 ? "1px solid rgba(255,255,255,0.06)" : undefined,
                          }
                        : {
                            color: "var(--t3)",
                            borderRight: i < 3 ? "1px solid rgba(255,255,255,0.04)" : undefined,
                          }
                    }
                  >
                    {s}×
                  </button>
                ))}
              </div>
              <GhostButton onClick={handleStop}>STOP</GhostButton>
            </div>
          )}
        </div>
      </header>

      {/* ── MAP AREA — globe is the full-height background ───────────────────── */}
      <div className="flex-1 relative overflow-hidden">

        {/* Cesium — absolute, fills full area, z-0 */}
        <div className="absolute inset-0" style={{ zIndex: 0 }}>
          <CesiumGlobe
            mode={mode}
            onEntitySelect={setSelectedEntityId}
            selectedEntityId={selectedEntityId}
            pendingWeapon={pendingWeapon}
            onWeaponPlaced={() => setPendingWeapon(null)}
            planHighlights={planHighlights}
            hoveredRouteWeapon={hoveredRouteWeapon}
            viewAllPaths={viewAllPaths}
            pinTargetMode={pinModeActive}
            onTargetPinned={(lat, lon) => {
              setPinnedTargetCoords({ lat, lon });
              setPinModeActive(false);
            }}
            onTargetHover={setHoveredTargetId}
          />
        </div>

        {/* ── LEFT TELEMETRY CLUSTER ── floating glass panel ── */}
        <aside
          className="panel-enter absolute overflow-y-auto"
          style={{
            ...GP,
            top: 12, left: 12,
            width: 230,
            maxHeight: "calc(100% - 24px)",
            zIndex: 10,
          }}
        >
          <TotConvergencePanel />
          <div className="gp-div" />
          <SaturationMeter />
          <div className="gp-div" />
          <EntityCountSummary />
        </aside>

        {/* ── ASSETS DRAWER ── floating glass panel ── */}
        {showAssetsPanel && mode === "planning" && (
          <div
            className="panel-enter absolute flex flex-col"
            style={{
              ...GP,
              top: 12, left: 254,   /* 12 + 230 + 12 */
              width: 316,
              bottom: 12,
              zIndex: 11,
            }}
          >
            <AssetsPanel
              onClose={() => setShowAssetsPanel(false)}
              onSetPendingWeapon={(w) => { setPendingWeapon(w); setShowAssetsPanel(false); }}
            />
          </div>
        )}

        {/* ── AI PLANNER DRAWER ── floating glass panel ── */}
        {showPlanner && mode === "planning" && (
          <div
            className="panel-enter absolute flex flex-col"
            style={{
              ...GP,
              top: 12, left: 254,
              width: 316,
              bottom: 12,
              zIndex: 11,
              overflow: "hidden",
            }}
          >
            <div className="flex items-center justify-between px-4 py-3 shrink-0"
              style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <span className="gl-label">AI Planner</span>
              <button
                onClick={() => setShowPlanner(false)}
                className="font-mono text-[11px] leading-none transition-colors duration-150"
                style={{ color: "var(--t3)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--t1)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <PlannerChat
                onPlanResult={(p) =>
                  setPlanHighlights(
                    p ? {
                      airbases: p.suggested_airbases,
                      carriers: p.carrier_positions,
                      routes: p.routes.map((r) => ({
                        weapon_type: r.weapon_type,
                        target_id: r.target_id,
                        airbase_id: r.airbase_id,
                        waypoints: r.waypoints,
                        total_dist_km: r.total_dist_km,
                        total_time_s: r.total_time_s,
                      })),
                    } : null
                  )
                }
                onWeaponHover={(wt) => { if (!viewAllPaths) setHoveredRouteWeapon(wt); }}
                pinModeActive={pinModeActive}
                onPinModeToggle={setPinModeActive}
                pinnedCoords={pinnedTargetCoords}
              />
            </div>
          </div>
        )}

        {/* ── RIGHT ENTITY INSPECTOR ── floating glass panel ── */}
        {selectedEntityId && (
          <div
            className="panel-enter absolute overflow-y-auto"
            style={{
              ...GP,
              top: 12, right: 12,
              width: 252,
              maxHeight: "calc(100% - 24px)",
              zIndex: 10,
            }}
          >
            <EntityInspector
              entityId={selectedEntityId}
              onClose={() => setSelectedEntityId(null)}
            />
          </div>
        )}

        {/* ── TOP-RIGHT HUD OVERLAYS ── */}
        <div className="absolute top-3 right-3 z-20 flex flex-col items-end gap-2"
          style={{ right: selectedEntityId ? "276px" : 12 }}>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md font-mono text-[9px] tracking-[0.2em]"
            style={{
              ...GP,
              borderRadius: 6,
              padding: "6px 12px",
              color: mode === "live" ? "var(--ac-cyan)" : "var(--t3)",
            }}>
            <div className="w-1.5 h-1.5 rounded-full"
              style={{ background: mode === "live" ? "var(--ac-cyan)" : "rgba(255,255,255,0.12)" }} />
            {mode.toUpperCase()}
          </div>
          {planHighlights && planHighlights.routes.length > 0 && (
            <button
              onClick={() => setViewAllPaths((v) => !v)}
              className="px-3 py-1.5 font-mono text-[9px] tracking-[0.16em] rounded-md transition-all duration-150"
              style={{
                ...GP,
                borderRadius: 6,
                color: viewAllPaths ? "var(--ac-amber)" : "var(--t2)",
                border: viewAllPaths ? "1px solid rgba(208,136,32,0.35)" : "1px solid rgba(255,255,255,0.08)",
              }}>
              ALL PATHS
            </button>
          )}
        </div>

        {/* ── PIN MODE BANNER ── */}
        {pinModeActive && !pendingWeapon && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20">
            <div className="flex items-center gap-3 px-6 py-2.5 rounded-full font-mono text-[10px] tracking-[0.14em]"
              style={{ ...GP, borderRadius: 999, color: "var(--ac-cyan)" }}>
              <span>◎</span>
              <span>CLICK GLOBE TO PIN TARGET</span>
              <button onClick={() => setPinModeActive(false)}
                className="ml-1 leading-none transition-colors duration-150"
                style={{ color: "var(--t3)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--t1)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ── TARGET HOVER TOOLTIP ── */}
        {hoveredTargetId && planHighlights && (() => {
          const routes = planHighlights.routes.filter((r) => r.target_id === hoveredTargetId);
          if (routes.length === 0) return null;
          const bases = planHighlights.airbases;
          const carriers = planHighlights.carriers;
          return (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
              <div className="rounded-lg px-4 py-3 font-mono text-[10px] min-w-[240px]"
                style={{ ...GP }}>
                <div className="gl-label mb-2.5">Assigned Assets</div>
                {routes.map((r, i) => {
                  const ab = bases.find((b) => b.id === r.airbase_id);
                  const carrier = carriers.find((c) => `carrier_${carriers.indexOf(c)}` === r.airbase_id);
                  const baseName = ab?.name ?? carrier?.label ?? r.airbase_id;
                  return (
                    <div key={i} className="flex items-center gap-2 py-1.5"
                      style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.05)" : undefined }}>
                      <span className="font-medium shrink-0 text-[9px] uppercase tracking-wider"
                        style={{ color: "var(--ac-blue)" }}>
                        {r.weapon_type.replace(/_/g, " ")}
                      </span>
                      <span style={{ color: "var(--t3)" }}>←</span>
                      <span className="truncate text-[9px]" style={{ color: "var(--t2)" }}>{baseName}</span>
                      <span className="ml-auto shrink-0 text-[9px] tabular-nums" style={{ color: "var(--t3)" }}>
                        {Math.round(r.total_dist_km)} km
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── WEAPON DEPLOY BANNER ── */}
        {pendingWeapon && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20">
            <div className="flex items-center gap-3 px-6 py-2.5 rounded-full font-mono text-[10px] tracking-[0.12em]"
              style={{ ...GP, borderRadius: 999, color: "var(--t1)" }}>
              <span style={{ color: "var(--ac-cyan)" }}>⊕</span>
              <span>
                DEPLOY{" "}
                <span className="font-semibold">{pendingWeapon.name}</span>
                <span className="ml-2 text-[9px]" style={{ color: "var(--t3)" }}>
                  · {pendingWeapon.domain}
                </span>
              </span>
              <button onClick={() => setPendingWeapon(null)}
                className="ml-1 leading-none transition-colors duration-150"
                style={{ color: "var(--t3)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--t1)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Globe framing vignette — draws the eye inward, makes globe feel intentional */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            zIndex: 1,
            background:
              "radial-gradient(ellipse 85% 85% at 50% 48%, transparent 55%, rgba(1,10,20,0.55) 100%)",
          }}
        />

        {/* ── IMPACT FLASHES ── */}
        {impactFlashes.map((flash) => (
          <ImpactFlash key={flash.id} flash={flash} onDone={() => clearImpactFlash(flash.id)} />
        ))}
      </div>

      {/* ── BOTTOM — glass engagement log bar ────────────────────────────────── */}
      <div className="gbar-top shrink-0" style={{ height: 148 }}>
        <EngagementLog />
      </div>
    </div>
  );
}

// ── GhostButton — reusable header control ────────────────────────────────────

function GhostButton({
  onClick,
  active = false,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 font-mono text-[9px] rounded tracking-[0.16em] transition-all duration-150"
      style={
        active
          ? {
              background: "rgba(74,154,255,0.14)",
              color: "var(--ac-blue)",
              border: "1px solid rgba(74,154,255,0.30)",
              boxShadow: "inset 0 1px 0 rgba(74,154,255,0.10)",
            }
          : {
              background: "rgba(255,255,255,0.04)",
              color: "var(--t2)",
              border: "1px solid rgba(255,255,255,0.08)",
            }
      }
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.color = "var(--t1)";
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.07)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.color = "var(--t2)";
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
        }
      }}
    >
      {children}
    </button>
  );
}

// ── ImpactFlash ───────────────────────────────────────────────────────────────

function ImpactFlash({ flash, onDone }: { flash: { id: string; weaponLabel: string }; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
      <div className="absolute inset-0 animate-pulse" style={{ background: "rgba(216,56,56,0.06)" }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/impact.gif"
        alt="impact"
        className="w-64 h-auto"
        style={{ filter: "drop-shadow(0 0 36px rgba(216,56,56,0.70))" }}
      />
      <div className="absolute bottom-16 font-mono text-[10px] tracking-[0.3em] animate-pulse"
        style={{ color: "var(--ac-red)" }}>
        TARGET DESTROYED · {flash.weaponLabel.replace(/_/g, " ").toUpperCase()}
      </div>
    </div>
  );
}

// ── EntityCountSummary ────────────────────────────────────────────────────────

function EntityCountSummary() {
  const { getWeapons, getTargets, getThreats, removeEntity } = useEntityGraph();
  const weapons = getWeapons();
  const targets = getTargets();
  const threats = getThreats();

  const handleDelete = (id: string) => {
    removeEntity(id);
    fetch(`${API}/entities/${id}`, { method: "DELETE" }).catch(() => null);
  };

  const byType = weapons.reduce<Record<string, { alive: number; total: number }>>((acc, w) => {
    const raw = (w.properties.weapon_type as string) ?? "UNKNOWN";
    const key = raw.replace(/_/g, " ").toUpperCase();
    if (!acc[key]) acc[key] = { alive: 0, total: 0 };
    acc[key].total++;
    const state = (w.properties.suda_state as string) ?? "CRUISE";
    if (state !== "DESTROYED" && state !== "IMPACTED") acc[key].alive++;
    return acc;
  }, {});

  const typeEntries = Object.entries(byType);

  return (
    <div className="px-4 py-3">
      {/* Weapons type summary */}
      <div className="gl-label mb-2">Assets</div>
      {typeEntries.length === 0 ? (
        <div className="font-mono text-[9px]" style={{ color: "var(--t4)" }}>No weapons placed</div>
      ) : (
        <div className="space-y-1 mb-3">
          {typeEntries.map(([type, { alive, total }]) => (
            <div key={type} className="flex items-center justify-between">
              <span className="font-mono text-[10px] truncate max-w-[120px]" style={{ color: "var(--t2)" }} title={type}>
                {type}
              </span>
              <span className="font-mono text-[10px] tabular-nums shrink-0 ml-2"
                style={{ color: alive < total ? "var(--ac-amber)" : "var(--ac-blue)" }}>
                {alive}/{total}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Individual weapon rows */}
      {weapons.length > 0 && (
        <div className="space-y-px mb-3 pt-2.5" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {weapons.map((w) => {
            const label = (w.properties.label as string) || (w.properties.weapon_type as string) || "Weapon";
            const state = (w.properties.suda_state as string) ?? "CRUISE";
            const dead = state === "DESTROYED" || state === "IMPACTED";
            return (
              <div key={w.id} className="flex items-center justify-between group py-0.5">
                <span
                  className="font-mono text-[9px] truncate max-w-[140px]"
                  style={{ color: dead ? "var(--t4)" : "var(--t2)", textDecoration: dead ? "line-through" : undefined }}
                  title={label}>
                  {label}
                </span>
                <button
                  onClick={() => handleDelete(w.id)}
                  className="font-mono text-[9px] leading-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 ml-1 shrink-0"
                  style={{ color: "var(--t3)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ac-red)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}
                  title="Remove">
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Targets */}
      <div className="gl-label mb-2 pt-2.5" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        Targets
      </div>
      {targets.length === 0 ? (
        <div className="font-mono text-[9px] mb-3" style={{ color: "var(--t4)" }}>None placed</div>
      ) : (
        <div className="space-y-px mb-3">
          {targets.map((t) => (
            <div key={t.id} className="flex items-center justify-between group py-0.5">
              <span className="font-mono text-[9px] truncate max-w-[140px]"
                style={{ color: "rgba(216,80,80,0.85)" }}
                title={(t.properties.label as string) || "Target"}>
                {(t.properties.label as string) || "Target"}
              </span>
              <button
                onClick={() => handleDelete(t.id)}
                className="font-mono text-[9px] leading-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 ml-1 shrink-0"
                style={{ color: "var(--t3)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ac-red)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}
                title="Remove">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Threats */}
      <div className="flex items-center justify-between pt-2.5"
        style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <span className="gl-label">Threats</span>
        <span className="font-mono text-[10px] tabular-nums"
          style={{ color: threats.length > 0 ? "var(--ac-amber)" : "var(--t4)" }}>
          {threats.length}
        </span>
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
      .then((data) => { setCatalog(data.weapons ?? []); setPlatforms(data.platforms ?? []); setLoading(false); })
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
        type: "TARGET", domain: "LAND",
        properties: { lat, lon, alt_km: 0, label: targetForm.label || `Target ${Date.now()}` },
      }),
    });
    setTargetForm({ lat: "", lon: "", label: "" });
    setPlacing(false);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <span className="gl-label">Add Assets</span>
        <button onClick={onClose}
          className="font-mono text-[11px] leading-none transition-colors duration-150"
          style={{ color: "var(--t3)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--t1)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
          ✕
        </button>
      </div>

      {/* WEAPONS / TARGETS tabs */}
      <div className="flex shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {(["WEAPONS", "TARGETS"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 py-2.5 font-mono text-[9px] tracking-[0.18em] transition-all duration-150"
            style={
              tab === t
                ? { color: "var(--t1)", borderBottom: "2px solid rgba(74,154,255,0.70)" }
                : { color: "var(--t3)", borderBottom: "2px solid transparent" }
            }
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── WEAPONS TAB ── */}
      {tab === "WEAPONS" && (
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Domain sub-tabs */}
          <div className="flex shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            {([
              { key: "AIR",  label: "AIR",  color: "var(--ac-blue)" },
              { key: "SEA",  label: "SEA",  color: "var(--ac-cyan)" },
              { key: "LAND", label: "LAND", color: "var(--ac-green)" },
            ] as const).map(({ key, label, color }) => (
              <button
                key={key}
                onClick={() => { setDomain(key); setSelectedWeapon(null); }}
                className="flex-1 py-1.5 font-mono text-[9px] tracking-[0.16em] transition-all duration-150"
                style={
                  domain === key
                    ? { color, borderBottom: `2px solid ${color}` }
                    : { color: "var(--t4)", borderBottom: "2px solid transparent" }
                }
              >
                {label}
              </button>
            ))}
          </div>

          {/* Platform picker (step 2) */}
          {selectedWeapon ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="flex items-start justify-between px-4 py-3 shrink-0"
                style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(6,14,28,0.30)" }}>
                <div>
                  <div className="gl-label mb-1">Select Platform</div>
                  <div className="font-mono text-[12px] font-semibold" style={{ color: "var(--t1)" }}>
                    {selectedWeapon.name}
                  </div>
                  <div className="font-mono text-[9px] mt-0.5" style={{ color: "var(--t3)" }}>
                    Mach {selectedWeapon.speed_mach} · {selectedWeapon.range_km} km
                  </div>
                </div>
                <button onClick={() => setSelectedWeapon(null)}
                  className="font-mono text-[11px] leading-none transition-colors duration-150 mt-0.5"
                  style={{ color: "var(--t3)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--t1)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--t3)")}>
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
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
            /* Weapon catalog list */
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {loading ? (
                <div className="font-mono text-[9px] p-4 text-center tracking-[0.2em] animate-pulse"
                  style={{ color: "var(--t3)" }}>LOADING…</div>
              ) : (
                <>
                  {groupBy(filtered, (w) => w.type).size === 0 && filteredPlatforms.length === 0 && (
                    <div className="font-mono text-[9px] p-3" style={{ color: "var(--t3)" }}>
                      Nothing in {domain} catalog.
                    </div>
                  )}
                  {Array.from(groupBy(filtered, (w) => w.type).entries()).map(([type, group], i) => (
                    <CategoryAccordion
                      key={type}
                      label={TYPE_LABEL[type] ?? type.replace(/_/g, " ")}
                      count={group.length}
                      defaultOpen={i === 0}
                    >
                      {group.map((w) => {
                        const hasCompatiblePlatforms = platforms.some((p) => p.compatible_weapons?.includes(w.id));
                        return (
                          <WeaponCard
                            key={w.id}
                            weapon={w}
                            requiresPlatform={hasCompatiblePlatforms}
                            onDeploy={() => hasCompatiblePlatforms ? setSelectedWeapon(w) : onSetPendingWeapon(w)}
                          />
                        );
                      })}
                    </CategoryAccordion>
                  ))}
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
                                name: p.name, domain: p.domain, speed_mach: p.speed_mach,
                                cruise_altitude_m: [8000, 12000], stealth: p.stealth, evasion_capable: true,
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
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="rounded-lg p-3.5" style={{ ...GPC }}>
            <div className="gl-label mb-2">Click-to-Place</div>
            <p className="font-mono text-[10px] leading-relaxed" style={{ color: "var(--t2)" }}>
              In <span style={{ color: "var(--ac-cyan)" }}>PLANNING</span> mode, click anywhere on the
              globe to drop a target at that location.
            </p>
          </div>
          <div className="pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
            <div className="gl-label mb-2.5">Manual Coordinates</div>
            <div className="space-y-2">
              {[
                { key: "lat", placeholder: "Latitude (−90 to 90)" },
                { key: "lon", placeholder: "Longitude (−180 to 180)" },
                { key: "label", placeholder: "Label (optional)" },
              ].map(({ key, placeholder }) => (
                <input
                  key={key}
                  type="text"
                  inputMode={key !== "label" ? "decimal" : undefined}
                  placeholder={placeholder}
                  value={targetForm[key as keyof typeof targetForm]}
                  onChange={(e) => setTargetForm((f) => ({ ...f, [key]: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 font-mono text-[10px] outline-none transition-all duration-150"
                  style={{
                    background: "rgba(6,14,28,0.60)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    color: "var(--t1)",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "rgba(74,154,255,0.35)")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)")}
                />
              ))}
              <button
                onClick={handlePlaceTarget}
                disabled={placing || !targetForm.lat || !targetForm.lon}
                className="w-full py-2 font-mono text-[10px] rounded-md tracking-[0.16em] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: "rgba(216,56,56,0.10)",
                  color: "rgba(220,100,100,0.90)",
                  border: "1px solid rgba(216,56,56,0.30)",
                }}>
                {placing ? "PLACING…" : "⊕  PLACE TARGET"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
  CRUISE_MISSILE:     "Cruise Missiles",
  ANTI_SHIP_MISSILE:  "Anti-Ship Missiles",
  HYPERSONIC_MISSILE: "Hypersonic Missiles",
  BALLISTIC_MISSILE:  "Ballistic Missiles",
  QUASI_BALLISTIC:    "Quasi-Ballistic",
  PLATFORM_FIGHTER:   "Fighters",
  PLATFORM_BOMBER:    "Bombers",
  PLATFORM_TANKER:    "Tankers",
  PLATFORM_EW:        "EW Aircraft",
  PLATFORM_DESTROYER: "Destroyers",
  PLATFORM_CRUISER:   "Cruisers",
  PLATFORM_SUBMARINE: "Submarines",
};

function CategoryAccordion({
  label, count, defaultOpen = false, children,
}: {
  label: string; count: number; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 font-mono text-[9px] tracking-[0.16em] transition-all duration-150"
        style={{ background: open ? "rgba(18,32,58,0.50)" : "rgba(10,18,36,0.40)" }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(18,32,58,0.60)")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = open ? "rgba(18,32,58,0.50)" : "rgba(10,18,36,0.40)")}
      >
        <span className="flex items-center gap-2">
          <span
            className="text-[7px] transition-transform duration-150 inline-block"
            style={{ color: "var(--t3)", transform: open ? "rotate(90deg)" : "none" }}>
            ▶
          </span>
          <span style={{ color: open ? "var(--t1)" : "var(--t2)" }}>{label.toUpperCase()}</span>
        </span>
        <span className="font-mono text-[9px] px-1.5 py-0.5 rounded"
          style={{ color: "var(--t4)", background: "rgba(4,10,22,0.6)", border: "1px solid rgba(255,255,255,0.05)" }}>
          {count}
        </span>
      </button>
      {open && (
        <div className="p-2.5 space-y-2" style={{ borderTop: "1px solid rgba(255,255,255,0.05)", background: "rgba(4,10,22,0.35)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Domain colors — precomputed RGBA (can't append opacity hex to CSS vars) ──

const DC = {
  AIR:  { text: "#4a9aff", dimBorder: "rgba(74,154,255,0.22)",  dimBg: "rgba(74,154,255,0.08)" },
  SEA:  { text: "#14c8e8", dimBorder: "rgba(20,200,232,0.22)",  dimBg: "rgba(20,200,232,0.08)" },
  LAND: { text: "#1ab858", dimBorder: "rgba(26,184,88,0.22)",   dimBg: "rgba(26,184,88,0.08)" },
} as const;

// ── PlatformCard ──────────────────────────────────────────────────────────────

function PlatformCard({
  platform, onDeploy, deployLabel,
}: {
  platform: PlatformCatalogItem; onDeploy: () => void; deployLabel?: string;
}) {
  const dc = DC[platform.domain] ?? DC.AIR;
  const typeLabel = (TYPE_LABEL[platform.type] ?? platform.type.replace(/^PLATFORM_/, "").replace(/_/g, " ")).toUpperCase();

  return (
    <div className="rounded-lg p-3 transition-all duration-150"
      style={{ background: "rgba(10,20,40,0.55)", border: "1px solid rgba(255,255,255,0.06)" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.10)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.06)")}>

      <div className="flex items-start justify-between gap-1 mb-0.5">
        <span className="font-mono text-[11px] font-semibold leading-tight" style={{ color: "var(--t1)" }}>
          {platform.name}
        </span>
        <span className="shrink-0 font-mono text-[8px] px-1.5 py-0.5 rounded"
          style={{ color: dc.text, background: dc.dimBg, border: `1px solid ${dc.dimBorder}` }}>
          {typeLabel}
        </span>
      </div>
      <div className="font-mono text-[9px] mb-2.5 truncate" style={{ color: "var(--t3)" }} title={platform.full_name}>
        {platform.full_name}
      </div>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <DataPill label="M" value={String(platform.speed_mach)} />
        <span style={{ color: "var(--t4)" }}>·</span>
        <DataPill label="RNG" value={`${platform.range_km} km`} />
        {platform.payload_kg != null && (
          <><span style={{ color: "var(--t4)" }}>·</span>
          <DataPill label="PLD" value={`${(platform.payload_kg / 1000).toFixed(0)}t`} /></>
        )}
        {platform.stealth && <CapabilityTag label="STEALTH" color="rgba(120,72,232,0.85)" bg="rgba(120,72,232,0.10)" border="rgba(120,72,232,0.25)" />}
        {platform.refuelable && <CapabilityTag label="TANKER" color="rgba(20,200,232,0.85)" bg="rgba(20,200,232,0.08)" border="rgba(20,200,232,0.22)" />}
      </div>
      <div className="font-mono text-[9px] mb-3" style={{ color: "var(--t3)" }}>
        {platform.country}{platform.crew != null ? ` · ${platform.crew}-crew` : ""}
      </div>
      <button
        onClick={onDeploy}
        className="w-full py-1.5 font-mono text-[9px] rounded-md tracking-[0.14em] transition-all duration-150"
        style={{ color: dc.text, background: dc.dimBg, border: `1px solid ${dc.dimBorder}` }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = dc.dimBg; }}>
        {deployLabel ?? "⊕  PLACE ON MAP"}
      </button>
    </div>
  );
}

// ── WeaponCard ────────────────────────────────────────────────────────────────

function WeaponCard({
  weapon, onDeploy, requiresPlatform = false,
}: {
  weapon: WeaponCatalogItem; onDeploy: () => void; requiresPlatform?: boolean;
}) {
  const dc = DC[weapon.domain] ?? DC.AIR;

  return (
    <div className="rounded-lg p-3 transition-all duration-150"
      style={{ background: "rgba(10,20,40,0.55)", border: "1px solid rgba(255,255,255,0.06)" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.10)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.06)")}>

      <div className="flex items-start justify-between gap-1 mb-0.5">
        <span className="font-mono text-[11px] font-semibold leading-tight" style={{ color: "var(--t1)" }}>
          {weapon.name}
        </span>
        <span className="shrink-0 font-mono text-[8px] px-1.5 py-0.5 rounded"
          style={{ color: dc.text, background: dc.dimBg, border: `1px solid ${dc.dimBorder}` }}>
          {weapon.domain}
        </span>
      </div>
      <div className="font-mono text-[9px] mb-2.5 truncate" style={{ color: "var(--t3)" }} title={weapon.full_name}>
        {weapon.full_name}
      </div>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <DataPill label="M" value={String(weapon.speed_mach)} />
        <span style={{ color: "var(--t4)" }}>·</span>
        <DataPill label="RNG" value={`${weapon.range_km} km`} />
        {weapon.stealth && <CapabilityTag label="STEALTH" color="rgba(120,72,232,0.85)" bg="rgba(120,72,232,0.10)" border="rgba(120,72,232,0.25)" />}
        {weapon.evasion_capable && <CapabilityTag label="EVADE" color="rgba(208,136,32,0.85)" bg="rgba(208,136,32,0.10)" border="rgba(208,136,32,0.25)" />}
      </div>
      <div className="font-mono text-[9px] mb-0.5 truncate" style={{ color: "var(--t3)" }}>
        {weapon.type.replace(/_/g, " ")} · {weapon.country}
      </div>
      {weapon.guidance?.length > 0 && (
        <div className="font-mono text-[8px] mb-3 truncate" style={{ color: "var(--t4)" }}>
          {weapon.guidance.slice(0, 3).join(" / ")}
        </div>
      )}
      <button
        onClick={onDeploy}
        className="w-full py-1.5 font-mono text-[9px] rounded-md tracking-[0.14em] transition-all duration-150"
        style={{ color: dc.text, background: dc.dimBg, border: `1px solid ${dc.dimBorder}` }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = dc.dimBg; }}>
        {requiresPlatform ? "▶  SELECT PLATFORM" : "⊕  PLACE ON MAP"}
      </button>
    </div>
  );
}

// ── DataPill & CapabilityTag — micro-components ───────────────────────────────

function DataPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="font-mono text-[10px]">
      <span style={{ color: "var(--t3)" }}>{label} </span>
      <span style={{ color: "var(--t1)" }}>{value}</span>
    </span>
  );
}

function CapabilityTag({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <span className="font-mono text-[8px] px-1.5 py-0.5 rounded"
      style={{ color, background: bg, border: `1px solid ${border}` }}>
      {label}
    </span>
  );
}
