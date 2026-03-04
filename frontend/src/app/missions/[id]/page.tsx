"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface WeaponLog {
  id: string;
  weapon_type: string | null;
  domain: string;
  launch_lat: number | null;
  launch_lon: number | null;
  target_label: string | null;
  final_state: string;
  fuel_remaining_pct: number | null;
  speed_mach_final: number | null;
  evasion_count: number;
  stealth: boolean;
  evasion_capable: boolean;
}

interface TargetLog {
  id: string;
  lat: number;
  lon: number;
  label: string;
  was_hit: boolean;
}

interface MissionDetail {
  id: string;
  status: string;
  created_at: string;
  duration_s: number | null;
  sim_speed: number;
  weapons_launched: number | null;
  weapons_survived: number | null;
  weapons_destroyed: number | null;
  targets_hit: number | null;
  tot_rms_final: number | null;
  weapons: WeaponLog[];
  targets: TargetLog[];
}

interface MissionEvent {
  id: number;
  sim_time_ms: number;
  event_type: string;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
}

function finalStateBadge(state: string) {
  const cls =
    state === "IMPACTED"
      ? "bg-green-900 text-green-300"
      : state === "DESTROYED"
      ? "bg-red-900 text-red-300"
      : "bg-gray-800 text-gray-400";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono ${cls}`}>{state}</span>
  );
}

export default function MissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [mission, setMission] = useState<MissionDetail | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"weapons" | "targets" | "events">("weapons");

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetch(`${API}/missions/${id}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`${API}/missions/${id}/events?limit=200`).then((r) =>
        r.ok ? r.json() : []
      ),
    ])
      .then(([m, e]) => {
        setMission(m);
        setEvents(e);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-gray-500 font-mono flex items-center justify-center">
        Loading mission…
      </div>
    );
  }

  if (error || !mission) {
    return (
      <div className="min-h-screen bg-black text-red-400 font-mono flex items-center justify-center">
        {error ?? "Mission not found"}
      </div>
    );
  }

  const survivedPct =
    mission.weapons_launched
      ? (((mission.weapons_survived ?? 0) / mission.weapons_launched) * 100).toFixed(0)
      : "—";
  const hitPct =
    mission.weapons_launched
      ? (((mission.targets_hit ?? 0) / mission.weapons_launched) * 100).toFixed(0)
      : "—";

  return (
    <div className="min-h-screen bg-black text-gray-200 font-mono">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 bg-gray-950 border-b border-gray-800">
        <div className="flex items-center gap-4">
          <Link href="/missions" className="text-gray-500 hover:text-cyan-400 text-sm">
            ← MISSIONS
          </Link>
          <span className="text-cyan-400 font-bold tracking-widest text-sm">
            {mission.id.slice(0, 8).toUpperCase()}
          </span>
          <span
            className={`px-2 py-0.5 rounded text-xs ${
              mission.status === "COMPLETED"
                ? "bg-green-900 text-green-300"
                : mission.status === "RUNNING"
                ? "bg-cyan-900 text-cyan-300"
                : "bg-red-900 text-red-300"
            }`}
          >
            {mission.status}
          </span>
        </div>
        <span className="text-gray-600 text-xs">
          {mission.created_at ? new Date(mission.created_at).toLocaleString() : ""}
        </span>
      </header>

      {/* Stats bar */}
      <div className="flex gap-6 px-6 py-4 bg-gray-950 border-b border-gray-800">
        {[
          { label: "DURATION", value: mission.duration_s != null ? `${mission.duration_s.toFixed(0)}s` : "—" },
          { label: "SIM SPEED", value: `${mission.sim_speed}×` },
          { label: "LAUNCHED", value: mission.weapons_launched ?? "—" },
          { label: "SURVIVED", value: `${mission.weapons_survived ?? "—"} (${survivedPct}%)` },
          { label: "DESTROYED", value: mission.weapons_destroyed ?? "—" },
          { label: "TARGETS HIT", value: `${mission.targets_hit ?? "—"} (${hitPct}%)` },
          { label: "TOT RMS", value: mission.tot_rms_final != null ? `${mission.tot_rms_final.toFixed(2)}s` : "—" },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col">
            <span className="text-gray-600 text-xs">{label}</span>
            <span className="text-gray-200 text-sm">{String(value)}</span>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 px-6 py-2 border-b border-gray-800 bg-gray-950">
        {(["weapons", "targets", "events"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1 rounded text-xs uppercase transition-colors ${
              activeTab === tab
                ? "bg-cyan-800 text-white"
                : "text-gray-500 hover:text-white"
            }`}
          >
            {tab}
            {tab === "weapons" && ` (${mission.weapons.length})`}
            {tab === "targets" && ` (${mission.targets.length})`}
            {tab === "events" && ` (${events.length})`}
          </button>
        ))}
      </div>

      <main className="p-6">
        {/* Weapons tab */}
        {activeTab === "weapons" && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
                  <th className="text-left py-2 px-3">ID</th>
                  <th className="text-left py-2 px-3">Type</th>
                  <th className="text-left py-2 px-3">Domain</th>
                  <th className="text-left py-2 px-3">Target</th>
                  <th className="text-left py-2 px-3">Final State</th>
                  <th className="text-right py-2 px-3">Fuel %</th>
                  <th className="text-right py-2 px-3">Mach</th>
                  <th className="text-right py-2 px-3">Evasions</th>
                  <th className="text-center py-2 px-3">Stealth</th>
                </tr>
              </thead>
              <tbody>
                {mission.weapons.map((w) => (
                  <tr key={w.id} className="border-b border-gray-900 hover:bg-gray-950">
                    <td className="py-2 px-3 text-gray-500 text-xs">{w.id.slice(0, 8)}</td>
                    <td className="py-2 px-3 text-gray-300 text-xs">{w.weapon_type ?? "—"}</td>
                    <td className="py-2 px-3 text-gray-400 text-xs">{w.domain}</td>
                    <td className="py-2 px-3 text-gray-300 text-xs">{w.target_label ?? "—"}</td>
                    <td className="py-2 px-3">{finalStateBadge(w.final_state)}</td>
                    <td className="py-2 px-3 text-right text-gray-400 text-xs">
                      {w.fuel_remaining_pct != null
                        ? `${(w.fuel_remaining_pct * 100).toFixed(1)}%`
                        : "—"}
                    </td>
                    <td className="py-2 px-3 text-right text-gray-400 text-xs">
                      {w.speed_mach_final != null ? w.speed_mach_final.toFixed(2) : "—"}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <span className={w.evasion_count > 0 ? "text-yellow-400" : "text-gray-600"}>
                        {w.evasion_count}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={w.stealth ? "text-cyan-400" : "text-gray-700"}>
                        {w.stealth ? "●" : "○"}
                      </span>
                    </td>
                  </tr>
                ))}
                {mission.weapons.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-gray-600 text-xs">
                      No weapons logged
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Targets tab */}
        {activeTab === "targets" && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
                  <th className="text-left py-2 px-3">ID</th>
                  <th className="text-left py-2 px-3">Label</th>
                  <th className="text-right py-2 px-3">Lat</th>
                  <th className="text-right py-2 px-3">Lon</th>
                  <th className="text-right py-2 px-3">Alt km</th>
                  <th className="text-center py-2 px-3">Hit</th>
                </tr>
              </thead>
              <tbody>
                {mission.targets.map((t) => (
                  <tr key={t.id} className="border-b border-gray-900 hover:bg-gray-950">
                    <td className="py-2 px-3 text-gray-500 text-xs">{t.id.slice(0, 8)}</td>
                    <td className="py-2 px-3 text-gray-300">{t.label}</td>
                    <td className="py-2 px-3 text-right text-gray-400 text-xs">{t.lat.toFixed(4)}</td>
                    <td className="py-2 px-3 text-right text-gray-400 text-xs">{t.lon.toFixed(4)}</td>
                    <td className="py-2 px-3 text-right text-gray-400 text-xs">—</td>
                    <td className="py-2 px-3 text-center">
                      {t.was_hit ? (
                        <span className="text-green-400 font-bold">HIT</span>
                      ) : (
                        <span className="text-gray-600">MISS</span>
                      )}
                    </td>
                  </tr>
                ))}
                {mission.targets.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-gray-600 text-xs">
                      No targets logged
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Events tab */}
        {activeTab === "events" && (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto">
            {events.map((e) => (
              <div
                key={e.id}
                className="flex gap-4 text-xs py-1 px-2 rounded hover:bg-gray-900"
              >
                <span className="text-gray-600 w-24 shrink-0">
                  T+{(e.sim_time_ms / 1000).toFixed(1)}s
                </span>
                <span
                  className={`w-40 shrink-0 font-bold ${
                    e.event_type.includes("EVASION")
                      ? "text-yellow-400"
                      : e.event_type.includes("DESTROYED")
                      ? "text-red-400"
                      : e.event_type.includes("IMPACTED")
                      ? "text-green-400"
                      : e.event_type.includes("TOT")
                      ? "text-cyan-400"
                      : "text-gray-400"
                  }`}
                >
                  {e.event_type}
                </span>
                <span className="text-gray-500">{e.entity_id?.slice(0, 8) ?? ""}</span>
                {e.payload && (
                  <span className="text-gray-700 truncate">
                    {JSON.stringify(e.payload)}
                  </span>
                )}
              </div>
            ))}
            {events.length === 0 && (
              <div className="py-8 text-center text-gray-600 text-xs">
                No events logged
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
