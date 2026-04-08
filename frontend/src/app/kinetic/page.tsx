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
    <div className="w-full h-full flex items-center justify-center text-[11px] tracking-[0.28em]"
      style={{ background: "var(--app-bg)", color: "rgba(237,234,227,0.30)", fontFamily: "'Syne', sans-serif" }}>
      INITIALIZING GLOBE
    </div>
  ),
});

// ── Linen panel style — highly translucent frosted glass over the dark globe ──
const LP: CSSProperties = {
  background:          "rgba(237,234,227,0.36)",
  backdropFilter:      "blur(28px) saturate(200%)",
  WebkitBackdropFilter:"blur(28px) saturate(200%)",
  border:       "1px solid rgba(237,234,227,0.28)",
  borderTop:    "2px solid rgba(25,21,15,0.80)",
  borderRadius: "6px",
  boxShadow:    "0 12px 48px rgba(0,0,0,0.40), 0 2px 12px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.18)",
};

// Inner card within a linen panel
const LPC: CSSProperties = {
  background:   "rgba(213,209,201,0.30)",
  border:       "1px solid rgba(213,209,201,0.35)",
  borderRadius: "4px",
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
      style={{ background: "var(--app-bg)", fontFamily: "'Syne', ui-sans-serif, sans-serif" }}>

      {/* ══ LINEN TOP BAR ══════════════════════════════════════════════════════ */}
      <header className="linen-bar flex items-center h-12 px-5 z-30 shrink-0 gap-5">

        {/* Wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <div>
            <div style={{
              fontFamily: "'Syne', sans-serif",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.28em",
              color: "var(--ink)",
              lineHeight: 1,
            }}>
              GHOST‑LINK
            </div>
            <div style={{
              fontFamily: "'Syne', sans-serif",
              fontSize: 7,
              fontWeight: 400,
              letterSpacing: "0.22em",
              color: "var(--ink-3)",
              marginTop: 2,
              textTransform: "uppercase",
              lineHeight: 1,
            }}>
              Command &amp; Control
            </div>
          </div>
          <div className="w-px h-6" style={{ background: "var(--linen-3)" }} />
          {/* Status */}
          <div className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full ${!wsConnected ? "dot-pulse" : ""}`}
              style={{ background: wsConnected ? "var(--ac-green)" : "var(--ac-red)" }}
            />
            <span style={{
              fontFamily: "'Syne', sans-serif",
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.16em",
              color: wsConnected ? "var(--ac-green)" : "var(--ac-red)",
            }}>
              {wsConnected ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
        </div>

        {/* Sim timer */}
        {simRunning && (
          <div className="flex items-center gap-1.5 px-2.5 py-1"
            style={{ background: "var(--linen-2)", border: "1px solid var(--linen-3)", borderRadius: 2 }}>
            <div className="w-1 h-1 rounded-full dot-pulse"
              style={{ background: "var(--ac-green)" }} />
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              letterSpacing: "0.12em",
              color: "var(--ink)",
            }}>
              {formatSimTime(simTimeS)}
            </span>
          </div>
        )}

        {/* Nav links */}
        <div className="flex items-center gap-0.5">
          {[
            { href: "/missions", label: "MISSIONS" },
            { href: "/map",      label: "MAP"      },
          ].map(({ href, label }) => (
            <Link key={href} href={href}
              style={{
                fontFamily: "'Syne', sans-serif",
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.18em",
                color: "var(--ink-3)",
                padding: "6px 10px",
                borderRadius: 2,
                textDecoration: "none",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-3)")}>
              {label}
            </Link>
          ))}
        </div>

        {/* Mode toggle — centered */}
        <div className="flex-1 flex justify-center">
          <div className="flex items-center overflow-hidden"
            style={{
              background: "var(--linen-2)",
              border: "1px solid var(--linen-3)",
              borderRadius: 2,
            }}>
            {(["planning", "live"] as Mode[]).map((m, i) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  fontFamily: "'Syne', sans-serif",
                  fontSize: 9,
                  fontWeight: mode === m ? 700 : 500,
                  letterSpacing: "0.20em",
                  textTransform: "uppercase" as const,
                  padding: "7px 20px",
                  background: mode === m ? "var(--ink)" : "transparent",
                  color: mode === m ? "var(--linen)" : "var(--ink-3)",
                  border: "none",
                  borderRight: i === 0 ? "1px solid var(--linen-3)" : undefined,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { if (mode !== m) (e.currentTarget as HTMLButtonElement).style.color = "var(--ink)"; }}
                onMouseLeave={(e) => { if (mode !== m) (e.currentTarget as HTMLButtonElement).style.color = "var(--ink-3)"; }}
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
              <LinenButton active={showAssetsPanel} onClick={openAssets}>ASSETS</LinenButton>
              <LinenButton active={showPlanner} onClick={openPlanner}>AI PLANNER</LinenButton>
            </>
          )}

          {!simRunning ? (
            <button
              onClick={handleLaunch}
              style={{
                fontFamily: "'Syne', sans-serif",
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.22em",
                padding: "7px 18px",
                background: "var(--ink)",
                color: "var(--linen)",
                border: "1px solid var(--ink)",
                borderRadius: 2,
                cursor: "pointer",
                transition: "opacity 0.12s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "0.80")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
            >
              LAUNCH
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex items-center overflow-hidden"
                style={{ border: "1px solid var(--linen-3)", borderRadius: 2, background: "var(--linen-2)" }}>
                {([1, 2, 5, 8] as const).map((s, i) => (
                  <button
                    key={s}
                    onClick={() => handleSetSpeed(s)}
                    style={{
                      fontFamily: "'Syne', sans-serif",
                      fontSize: 9,
                      fontWeight: simSpeed === s ? 700 : 400,
                      padding: "6px 10px",
                      background: simSpeed === s ? "var(--ink)" : "transparent",
                      color: simSpeed === s ? "var(--linen)" : "var(--ink-3)",
                      border: "none",
                      borderRight: i < 3 ? "1px solid var(--linen-3)" : undefined,
                      cursor: "pointer",
                      letterSpacing: "0.06em",
                      transition: "all 0.1s",
                    }}>
                    {s}×
                  </button>
                ))}
              </div>
              <LinenButton onClick={handleStop}>STOP</LinenButton>
            </div>
          )}
        </div>
      </header>

      {/* ══ MAP AREA — globe fills full height, panels float over it ═══════════ */}
      <div className="flex-1 relative overflow-hidden">

        {/* Cesium — full background, z-0 */}
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

        {/* Tactical corner brackets — Anduril-style framing */}
        <div className="bracket-tl" style={{ zIndex: 2 }} />
        <div className="bracket-tr" style={{ zIndex: 2 }} />
        <div className="bracket-bl" style={{ zIndex: 2 }} />
        <div className="bracket-br" style={{ zIndex: 2 }} />

        {/* ── LEFT TELEMETRY PANEL — linen floating ── */}
        <aside
          className="panel-enter absolute overflow-y-auto"
          style={{
            ...LP,
            top: 14, left: 14,
            width: 236,
            maxHeight: "calc(100% - 28px)",
            zIndex: 10,
          }}
        >
          <TotConvergencePanel />
          <div className="lp-div" />
          <SaturationMeter />
          <div className="lp-div" />
          <EntityCountSummary />
        </aside>

        {/* ── ASSETS DRAWER — linen floating panel ── */}
        {showAssetsPanel && mode === "planning" && (
          <div
            className="panel-enter absolute flex flex-col overflow-hidden"
            style={{
              ...LP,
              top: 14, left: 262,   /* 14 + 236 + 12 */
              width: 316,
              bottom: 14,
              zIndex: 11,
            }}
          >
            <AssetsPanel
              onClose={() => setShowAssetsPanel(false)}
              onSetPendingWeapon={(w) => { setPendingWeapon(w); setShowAssetsPanel(false); }}
            />
          </div>
        )}

        {/* ── AI PLANNER DRAWER — linen floating panel ── */}
        {showPlanner && mode === "planning" && (
          <div
            className="panel-enter absolute flex flex-col overflow-hidden"
            style={{
              ...LP,
              top: 14, left: 262,
              width: 316,
              bottom: 14,
              zIndex: 11,
            }}
          >
            <div className="flex items-center justify-between px-4 py-3 shrink-0"
              style={{ borderBottom: "1px solid var(--linen-3)" }}>
              <span className="gl-label">AI Planner</span>
              <CloseX onClick={() => setShowPlanner(false)} />
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

        {/* ── RIGHT ENTITY INSPECTOR ── */}
        {selectedEntityId && (
          <div
            className="panel-enter absolute overflow-y-auto"
            style={{
              ...LP,
              top: 14, right: 14,
              width: 256,
              maxHeight: "calc(100% - 28px)",
              zIndex: 10,
            }}
          >
            <EntityInspector
              entityId={selectedEntityId}
              onClose={() => setSelectedEntityId(null)}
            />
          </div>
        )}

        {/* ── TOP-RIGHT HUD — mode badge + ALL PATHS ── */}
        <div className="absolute z-20 flex flex-col items-end gap-2"
          style={{ top: 14, right: selectedEntityId ? 284 : 14 }}>
          <div className="flex items-center gap-2 px-3 py-1.5"
            style={{
              ...LP,
              borderTop: mode === "live" ? "2px solid var(--ac-green)" : "2px solid var(--ink-4)",
              padding: "5px 12px",
            }}>
            <div className="w-1.5 h-1.5 rounded-full"
              style={{ background: mode === "live" ? "var(--ac-green)" : "var(--ink-4)" }} />
            <span style={{
              fontFamily: "'Syne', sans-serif",
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: "0.24em",
              color: mode === "live" ? "var(--ac-green)" : "var(--ink-3)",
              textTransform: "uppercase",
            }}>
              {mode}
            </span>
          </div>
          {planHighlights && planHighlights.routes.length > 0 && (
            <button
              onClick={() => setViewAllPaths((v) => !v)}
              style={{
                ...LP,
                borderTop: viewAllPaths ? "2px solid var(--ac-amber)" : "2px solid var(--ink)",
                padding: "5px 12px",
                fontFamily: "'Syne', sans-serif",
                fontSize: 8,
                fontWeight: 700,
                letterSpacing: "0.20em",
                textTransform: "uppercase" as const,
                color: viewAllPaths ? "var(--ac-amber)" : "var(--ink)",
                cursor: "pointer",
                transition: "opacity 0.12s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "0.75")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
            >
              ALL PATHS
            </button>
          )}
        </div>

        {/* ── PIN MODE BANNER ── */}
        {pinModeActive && !pendingWeapon && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20">
            <div className="flex items-center gap-3 px-6 py-3"
              style={{
                ...LP,
                borderRadius: 2,
                fontFamily: "'Syne', sans-serif",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.14em",
                color: "var(--ink)",
              }}>
              <span style={{ color: "var(--ac-blue)" }}>◎</span>
              <span>CLICK GLOBE TO PIN TARGET</span>
              <CloseX onClick={() => setPinModeActive(false)} />
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
              <div style={{ ...LP, padding: "14px 16px", minWidth: 248 }}>
                <div className="gl-label" style={{ marginBottom: 10 }}>Assigned Assets</div>
                {routes.map((r, i) => {
                  const ab = bases.find((b) => b.id === r.airbase_id);
                  const carrier = carriers.find((c) => `carrier_${carriers.indexOf(c)}` === r.airbase_id);
                  const baseName = ab?.name ?? carrier?.label ?? r.airbase_id;
                  return (
                    <div key={i} className="flex items-center gap-2 py-1.5"
                      style={{ borderTop: i > 0 ? "1px solid var(--linen-3)" : undefined }}>
                      <span style={{
                        fontFamily: "'Syne', sans-serif",
                        fontSize: 9,
                        fontWeight: 600,
                        letterSpacing: "0.08em",
                        color: "var(--ac-blue)",
                        flexShrink: 0,
                      }}>
                        {r.weapon_type.replace(/_/g, " ")}
                      </span>
                      <span style={{ color: "var(--ink-4)", fontSize: 9 }}>←</span>
                      <span style={{ fontFamily: "monospace", fontSize: 9, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {baseName}
                      </span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--ink-3)", marginLeft: "auto", flexShrink: 0 }}>
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
            <div className="flex items-center gap-3 px-6 py-3"
              style={{
                ...LP,
                fontFamily: "'Syne', sans-serif",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.12em",
                color: "var(--ink)",
              }}>
              <span style={{ color: "var(--ac-blue)", fontWeight: 700 }}>⊕</span>
              <span>
                DEPLOY{" "}
                <span style={{ fontWeight: 700 }}>{pendingWeapon.name}</span>
                <span style={{ color: "var(--ink-3)", marginLeft: 8, fontWeight: 400, fontSize: 9 }}>
                  {pendingWeapon.domain}
                </span>
              </span>
              <CloseX onClick={() => setPendingWeapon(null)} />
            </div>
          </div>
        )}

        {/* ── IMPACT FLASHES ── */}
        {impactFlashes.map((flash) => (
          <ImpactFlash key={flash.id} flash={flash} onDone={() => clearImpactFlash(flash.id)} />
        ))}
      </div>

      {/* ══ INK BOTTOM BAR — engagement log (dark zone, bicolor contrast) ══════ */}
      <div className="ink-bar shrink-0 flex flex-col" style={{ height: 148 }}>
        <EngagementLog />
      </div>
    </div>
  );
}

// ── Shared micro-components ───────────────────────────────────────────────────

function LinenButton({
  onClick, active = false, children,
}: {
  onClick: () => void; active?: boolean; children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily:    "'Syne', sans-serif",
        fontSize:       9,
        fontWeight:     active ? 700 : 500,
        letterSpacing: "0.16em",
        textTransform: "uppercase" as const,
        padding:       "6px 12px",
        background:    active ? "var(--ink)" : "var(--linen-2)",
        color:         active ? "var(--linen)" : "var(--ink-2)",
        border:        active ? "1px solid var(--ink)" : "1px solid var(--linen-3)",
        borderRadius:  2,
        cursor:        "pointer",
        transition:    "all 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.color = "var(--ink)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.color = "var(--ink-2)";
      }}
    >
      {children}
    </button>
  );
}

function CloseX({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", fontSize: 11, lineHeight: 1, padding: 0, transition: "color 0.12s" }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-3)")}>
      ✕
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
      <div className="absolute inset-0 animate-pulse" style={{ background: "rgba(138,26,24,0.06)" }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/impact.gif" alt="impact" className="w-64 h-auto"
        style={{ filter: "drop-shadow(0 0 40px rgba(138,26,24,0.70))" }} />
      <div className="absolute bottom-16 animate-pulse"
        style={{
          fontFamily: "'Syne', sans-serif",
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.30em",
          color: "var(--ac-red)",
          textTransform: "uppercase",
        }}>
        TARGET DESTROYED · {flash.weaponLabel.replace(/_/g, " ").toUpperCase()}
      </div>
    </div>
  );
}

// ── EntityCountSummary ────────────────────────────────────────────────────────

function EntityCountSummary() {
  const { getWeapons, getTargets, getThreats, removeEntity } = useEntityGraph();
  const weapons  = getWeapons();
  const targets  = getTargets();
  const threats  = getThreats();

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
    <div className="px-4 py-3.5">
      <div className="gl-label" style={{ marginBottom: 10 }}>Assets</div>

      {typeEntries.length === 0 ? (
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--ink-4)" }}>No weapons placed</div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          {typeEntries.map(([type, { alive, total }]) => (
            <div key={type} className="flex items-center justify-between py-1"
              style={{ borderBottom: "1px solid var(--linen-3)" }}>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 9, fontWeight: 500, color: "var(--ink-2)" }} title={type}>
                {type}
              </span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: alive < total ? "var(--ac-amber)" : "var(--ac-blue)",
                fontWeight: 500,
              }}>
                {alive}/{total}
              </span>
            </div>
          ))}
        </div>
      )}

      {weapons.length > 0 && (
        <div style={{ marginBottom: 12, paddingTop: 8, borderTop: "1px solid var(--linen-3)" }}>
          {weapons.map((w) => {
            const label = (w.properties.label as string) || (w.properties.weapon_type as string) || "Weapon";
            const state = (w.properties.suda_state as string) ?? "CRUISE";
            const dead  = state === "DESTROYED" || state === "IMPACTED";
            return (
              <div key={w.id} className="flex items-center justify-between group py-0.5">
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 9,
                  color: dead ? "var(--ink-4)" : "var(--ink-2)",
                  textDecoration: dead ? "line-through" : undefined,
                  maxWidth: 148,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }} title={label}>
                  {label}
                </span>
                <button
                  onClick={() => handleDelete(w.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-4)", fontSize: 9, lineHeight: 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ac-red)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-4)")}
                  title="Remove">
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="gl-label" style={{ marginBottom: 8, paddingTop: 10, borderTop: "1px solid var(--linen-3)" }}>
        Targets
      </div>
      {targets.length === 0 ? (
        <div style={{ fontFamily: "monospace", fontSize: 9, color: "var(--ink-4)", marginBottom: 12 }}>None placed</div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          {targets.map((t) => (
            <div key={t.id} className="flex items-center justify-between group py-0.5">
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: "var(--ac-red)",
                maxWidth: 148,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }} title={(t.properties.label as string) || "Target"}>
                {(t.properties.label as string) || "Target"}
              </span>
              <button
                onClick={() => handleDelete(t.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-4)", fontSize: 9, lineHeight: 1 }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ac-red)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-4)")}
                title="Remove">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-2.5"
        style={{ borderTop: "1px solid var(--linen-3)" }}>
        <span className="gl-label">Threats</span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: threats.length > 0 ? "var(--ac-amber)" : "var(--ink-4)",
        }}>
          {threats.length}
        </span>
      </div>
    </div>
  );
}

// ── AssetsPanel ───────────────────────────────────────────────────────────────

function AssetsPanel({
  onClose, onSetPendingWeapon,
}: {
  onClose: () => void;
  onSetPendingWeapon: (w: PendingWeapon) => void;
}) {
  const [tab, setTab]                 = useState<"WEAPONS" | "TARGETS">("WEAPONS");
  const [domain, setDomain]           = useState<"AIR" | "SEA" | "LAND">("AIR");
  const [catalog, setCatalog]         = useState<WeaponCatalogItem[]>([]);
  const [platforms, setPlatforms]     = useState<PlatformCatalogItem[]>([]);
  const [loading, setLoading]         = useState(true);
  const [targetForm, setTargetForm]   = useState({ lat: "", lon: "", label: "" });
  const [placing, setPlacing]         = useState(false);
  const [selectedWeapon, setSelectedWeapon] = useState<WeaponCatalogItem | null>(null);

  useEffect(() => {
    fetch(`${API}/weapons/catalog`)
      .then((r) => r.json())
      .then((data) => { setCatalog(data.weapons ?? []); setPlatforms(data.platforms ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered         = catalog.filter((w) => w.domain === domain);
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

  const TAB_STYLE = (active: boolean): CSSProperties => ({
    flex: 1,
    padding: "10px 0",
    fontFamily: "'Syne', sans-serif",
    fontSize: 9,
    fontWeight: active ? 700 : 500,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    background: "transparent",
    color: active ? "var(--ink)" : "var(--ink-3)",
    border: "none",
    borderBottom: active ? "2px solid var(--ink)" : "2px solid transparent",
    cursor: "pointer",
    transition: "all 0.12s",
  });

  const DOM_STYLE = (key: string, active: boolean): { text: string; border: string } => {
    if (!active) return { text: "var(--ink-4)", border: "transparent" };
    if (key === "AIR")  return { text: "var(--ac-blue)",  border: "var(--ac-blue)" };
    if (key === "SEA")  return { text: "#1a7080",         border: "#1a7080" };
    return                     { text: "var(--ac-green)", border: "var(--ac-green)" };
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--linen-3)" }}>
        <span className="gl-label">Add Assets</span>
        <CloseX onClick={onClose} />
      </div>

      {/* Main tabs */}
      <div className="flex shrink-0" style={{ borderBottom: "1px solid var(--linen-3)" }}>
        {(["WEAPONS", "TARGETS"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={TAB_STYLE(tab === t)}>{t}</button>
        ))}
      </div>

      {/* ── WEAPONS TAB ── */}
      {tab === "WEAPONS" && (
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Domain sub-tabs */}
          <div className="flex shrink-0" style={{ borderBottom: "1px solid var(--linen-3)" }}>
            {(["AIR", "SEA", "LAND"] as const).map((key) => {
              const ds = DOM_STYLE(key, domain === key);
              return (
                <button
                  key={key}
                  onClick={() => { setDomain(key); setSelectedWeapon(null); }}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    fontFamily: "'Syne', sans-serif",
                    fontSize: 9,
                    fontWeight: domain === key ? 700 : 400,
                    letterSpacing: "0.16em",
                    background: "transparent",
                    color: ds.text,
                    border: "none",
                    borderBottom: `2px solid ${ds.border}`,
                    cursor: "pointer",
                    transition: "all 0.12s",
                  }}>
                  {key}
                </button>
              );
            })}
          </div>

          {/* Platform picker (step 2) */}
          {selectedWeapon ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="flex items-start justify-between px-4 py-3 shrink-0"
                style={{ borderBottom: "1px solid var(--linen-3)", background: "var(--linen-2)" }}>
                <div>
                  <div className="gl-label" style={{ marginBottom: 6 }}>Select Platform</div>
                  <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
                    {selectedWeapon.name}
                  </div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--ink-3)", marginTop: 2 }}>
                    Mach {selectedWeapon.speed_mach} · {selectedWeapon.range_km} km
                  </div>
                </div>
                <CloseX onClick={() => setSelectedWeapon(null)} />
              </div>
              <div className="flex-1 overflow-y-auto p-3" style={{ gap: 8, display: "flex", flexDirection: "column" }}>
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
            <div className="flex-1 overflow-y-auto p-3" style={{ gap: 6, display: "flex", flexDirection: "column" }}>
              {loading ? (
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 9, color: "var(--ink-3)", padding: "16px 0", textAlign: "center", letterSpacing: "0.2em" }}>
                  LOADING…
                </div>
              ) : (
                <>
                  {groupBy(filtered, (w) => w.type).size === 0 && filteredPlatforms.length === 0 && (
                    <div style={{ fontSize: 10, color: "var(--ink-3)", padding: 12 }}>Nothing in {domain} catalog.</div>
                  )}
                  {Array.from(groupBy(filtered, (w) => w.type).entries()).map(([type, group], i) => (
                    <CategoryAccordion key={type} label={TYPE_LABEL[type] ?? type.replace(/_/g, " ")} count={group.length} defaultOpen={i === 0}>
                      {group.map((w) => {
                        const hasPlatforms = platforms.some((p) => p.compatible_weapons?.includes(w.id));
                        return (
                          <WeaponCard
                            key={w.id} weapon={w} requiresPlatform={hasPlatforms}
                            onDeploy={() => hasPlatforms ? setSelectedWeapon(w) : onSetPendingWeapon(w)}
                          />
                        );
                      })}
                    </CategoryAccordion>
                  ))}
                  {filteredPlatforms.length > 0 &&
                    Array.from(groupBy(filteredPlatforms, (p) => p.type).entries()).map(([type, group]) => (
                      <CategoryAccordion key={type} label={TYPE_LABEL[type] ?? type.replace(/^PLATFORM_/, "").replace(/_/g, " ")} count={group.length}>
                        {group.map((p) => (
                          <PlatformCard
                            key={p.id} platform={p}
                            onDeploy={() => onSetPendingWeapon({ name: p.name, domain: p.domain, speed_mach: p.speed_mach, cruise_altitude_m: [8000, 12000], stealth: p.stealth, evasion_capable: true })}
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
        <div className="flex-1 overflow-y-auto p-4" style={{ gap: 16, display: "flex", flexDirection: "column" }}>
          <div style={{ ...LPC, padding: "12px 14px" }}>
            <div className="gl-label" style={{ marginBottom: 8 }}>Click-to-Place</div>
            <p style={{ fontFamily: "'Syne', sans-serif", fontSize: 10, color: "var(--ink-2)", lineHeight: 1.6, margin: 0 }}>
              In <span style={{ color: "var(--ac-blue)", fontWeight: 600 }}>PLANNING</span> mode, click anywhere on the globe to place a target.
            </p>
          </div>
          <div style={{ borderTop: "1px solid var(--linen-3)", paddingTop: 16 }}>
            <div className="gl-label" style={{ marginBottom: 10 }}>Manual Coordinates</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { key: "lat", placeholder: "Latitude  (−90 to 90)" },
                { key: "lon", placeholder: "Longitude  (−180 to 180)" },
                { key: "label", placeholder: "Label  (optional)" },
              ].map(({ key, placeholder }) => (
                <input
                  key={key}
                  type="text"
                  inputMode={key !== "label" ? "decimal" : undefined}
                  placeholder={placeholder}
                  value={targetForm[key as keyof typeof targetForm]}
                  onChange={(e) => setTargetForm((f) => ({ ...f, [key]: e.target.value }))}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    padding: "8px 10px",
                    background: "var(--linen-2)",
                    border: "1px solid var(--linen-3)",
                    borderRadius: 2,
                    color: "var(--ink)",
                    width: "100%",
                    transition: "border-color 0.12s",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "var(--ink)")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "var(--linen-3)")}
                />
              ))}
              <button
                onClick={handlePlaceTarget}
                disabled={placing || !targetForm.lat || !targetForm.lon}
                style={{
                  fontFamily: "'Syne', sans-serif",
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.18em",
                  padding: "9px 0",
                  background: "var(--ac-red)",
                  color: "var(--linen)",
                  border: "none",
                  borderRadius: 2,
                  cursor: "pointer",
                  opacity: placing || !targetForm.lat || !targetForm.lon ? 0.4 : 1,
                  transition: "opacity 0.12s",
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    <div style={{ border: "1px solid var(--linen-3)", borderRadius: 2, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between"
        style={{
          padding: "9px 12px",
          fontFamily: "'Syne', sans-serif",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.16em",
          textTransform: "uppercase" as const,
          background: open ? "var(--linen-2)" : "var(--linen)",
          color: "var(--ink)",
          border: "none",
          cursor: "pointer",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "var(--linen-2)")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = open ? "var(--linen-2)" : "var(--linen)")}
      >
        <span className="flex items-center gap-2">
          <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", color: "var(--ink-3)", fontSize: 7 }}>▶</span>
          {label}
        </span>
        <span style={{ fontSize: 9, color: "var(--ink-3)", background: "var(--linen-3)", padding: "1px 6px", borderRadius: 2 }}>{count}</span>
      </button>
      {open && (
        <div style={{ padding: "8px", gap: 6, display: "flex", flexDirection: "column", borderTop: "1px solid var(--linen-3)", background: "var(--linen-2)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Domain colors (precomputed — can't do CSS var + hex suffix) ───────────────
const DC = {
  AIR:  { text: "#1a5fa8", dimBorder: "rgba(26,95,168,0.25)",  dimBg: "rgba(26,95,168,0.08)" },
  SEA:  { text: "#1a7080", dimBorder: "rgba(26,112,128,0.25)", dimBg: "rgba(26,112,128,0.08)" },
  LAND: { text: "#1a6030", dimBorder: "rgba(26,96,48,0.25)",   dimBg: "rgba(26,96,48,0.08)" },
} as const;

function PlatformCard({
  platform, onDeploy, deployLabel,
}: {
  platform: PlatformCatalogItem; onDeploy: () => void; deployLabel?: string;
}) {
  const dc = DC[platform.domain] ?? DC.AIR;
  const typeLabel = (TYPE_LABEL[platform.type] ?? platform.type.replace(/^PLATFORM_/, "").replace(/_/g, " ")).toUpperCase();
  return (
    <div style={{ ...LPC, padding: "10px 12px", transition: "border-color 0.12s" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "var(--linen-4)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "var(--linen-3)")}>
      <div className="flex items-start justify-between gap-1" style={{ marginBottom: 2 }}>
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 11, fontWeight: 700, color: "var(--ink)", lineHeight: 1.2 }}>{platform.name}</span>
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 7, fontWeight: 600, letterSpacing: "0.1em", color: dc.text, background: dc.dimBg, border: `1px solid ${dc.dimBorder}`, padding: "2px 5px", borderRadius: 2, flexShrink: 0 }}>{typeLabel}</span>
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "var(--ink-3)", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={platform.full_name}>{platform.full_name}</div>
      <div className="flex items-center flex-wrap" style={{ gap: 6, marginBottom: 8 }}>
        <Stat label="M" value={String(platform.speed_mach)} />
        <span style={{ color: "var(--ink-4)", fontSize: 10 }}>·</span>
        <Stat label="RNG" value={`${platform.range_km} km`} />
        {platform.payload_kg != null && <><span style={{ color: "var(--ink-4)", fontSize: 10 }}>·</span><Stat label="PLD" value={`${(platform.payload_kg/1000).toFixed(0)}t`} /></>}
        {platform.stealth    && <Cap label="STEALTH" color="#6840c8" bg="rgba(104,64,200,0.08)" bd="rgba(104,64,200,0.20)" />}
        {platform.refuelable && <Cap label="TANKER" color={dc.text}  bg={dc.dimBg}              bd={dc.dimBorder} />}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "var(--ink-3)", marginBottom: 10 }}>
        {platform.country}{platform.crew != null ? ` · ${platform.crew}-crew` : ""}
      </div>
      <DeployBtn label={deployLabel ?? "⊕  PLACE ON MAP"} dc={dc} onClick={onDeploy} />
    </div>
  );
}

function WeaponCard({
  weapon, onDeploy, requiresPlatform = false,
}: {
  weapon: WeaponCatalogItem; onDeploy: () => void; requiresPlatform?: boolean;
}) {
  const dc = DC[weapon.domain] ?? DC.AIR;
  return (
    <div style={{ ...LPC, padding: "10px 12px", transition: "border-color 0.12s" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "var(--linen-4)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "var(--linen-3)")}>
      <div className="flex items-start justify-between gap-1" style={{ marginBottom: 2 }}>
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 11, fontWeight: 700, color: "var(--ink)", lineHeight: 1.2 }}>{weapon.name}</span>
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 7, fontWeight: 600, letterSpacing: "0.1em", color: dc.text, background: dc.dimBg, border: `1px solid ${dc.dimBorder}`, padding: "2px 5px", borderRadius: 2, flexShrink: 0 }}>{weapon.domain}</span>
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "var(--ink-3)", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={weapon.full_name}>{weapon.full_name}</div>
      <div className="flex items-center flex-wrap" style={{ gap: 6, marginBottom: 6 }}>
        <Stat label="M" value={String(weapon.speed_mach)} />
        <span style={{ color: "var(--ink-4)", fontSize: 10 }}>·</span>
        <Stat label="RNG" value={`${weapon.range_km} km`} />
        {weapon.stealth          && <Cap label="STEALTH" color="#6840c8" bg="rgba(104,64,200,0.08)" bd="rgba(104,64,200,0.20)" />}
        {weapon.evasion_capable  && <Cap label="EVADE"   color="var(--ac-amber)" bg="var(--ac-amber-dim)" bd="rgba(138,74,8,0.22)" />}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "var(--ink-3)", marginBottom: 10 }}>
        {weapon.type.replace(/_/g, " ")} · {weapon.country}
      </div>
      <DeployBtn label={requiresPlatform ? "▶  SELECT PLATFORM" : "⊕  PLACE ON MAP"} dc={dc} onClick={onDeploy} />
    </div>
  );
}

// Tiny atomic components
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9 }}>
      <span style={{ color: "var(--ink-3)" }}>{label} </span>
      <span style={{ color: "var(--ink)" }}>{value}</span>
    </span>
  );
}
function Cap({ label, color, bg, bd }: { label: string; color: string; bg: string; bd: string }) {
  return (
    <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 7, fontWeight: 600, letterSpacing: "0.1em", color, background: bg, border: `1px solid ${bd}`, padding: "2px 5px", borderRadius: 2 }}>
      {label}
    </span>
  );
}
function DeployBtn({ label, dc, onClick }: { label: string; dc: { text: string; dimBg: string; dimBorder: string }; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "6px 0",
        fontFamily: "'Syne', sans-serif",
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: "0.14em",
        color: dc.text,
        background: dc.dimBg,
        border: `1px solid ${dc.dimBorder}`,
        borderRadius: 2,
        cursor: "pointer",
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "var(--linen-3)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = dc.dimBg)}>
      {label}
    </button>
  );
}
