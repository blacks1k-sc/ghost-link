"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface Mission {
  id: string;
  status: "RUNNING" | "COMPLETED" | "ABORTED";
  created_at: string;
  duration_s: number | null;
  sim_speed: number;
  weapons_launched: number | null;
  weapons_survived: number | null;
  weapons_destroyed: number | null;
  targets_hit: number | null;
  tot_rms_final: number | null;
}

function statusBadge(status: Mission["status"]) {
  const cls =
    status === "COMPLETED"
      ? "bg-green-900 text-green-300"
      : status === "RUNNING"
      ? "bg-cyan-900 text-cyan-300 animate-pulse"
      : "bg-red-900 text-red-300";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono ${cls}`}>
      {status}
    </span>
  );
}

function hitRate(m: Mission) {
  if (!m.weapons_launched || m.weapons_launched === 0) return "—";
  const hit = m.targets_hit ?? 0;
  const launched = m.weapons_launched;
  return `${hit}/${launched} (${((hit / launched) * 100).toFixed(0)}%)`;
}

export default function MissionsPage() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/missions`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setMissions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-black text-gray-200 font-mono">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 bg-gray-950 border-b border-gray-800">
        <div className="flex items-center gap-4">
          <Link href="/kinetic" className="text-gray-500 hover:text-cyan-400 text-sm">
            ← GHOST-LINK C2
          </Link>
          <span className="text-cyan-400 font-bold tracking-widest text-sm">
            MISSION HISTORY
          </span>
        </div>
        <span className="text-gray-600 text-xs">{missions.length} missions</span>
      </header>

      <main className="p-6">
        {loading && (
          <div className="text-gray-500 text-sm text-center mt-20">Loading missions…</div>
        )}

        {error && (
          <div className="text-red-400 text-sm text-center mt-20">
            Failed to load missions: {error}
            <div className="text-gray-600 text-xs mt-2">
              Make sure backend is running and SUPABASE_SERVICE_KEY is set in backend/.env
            </div>
          </div>
        )}

        {!loading && !error && missions.length === 0 && (
          <div className="text-gray-600 text-sm text-center mt-20">
            No missions yet. Launch a simulation from{" "}
            <Link href="/kinetic" className="text-cyan-500 hover:underline">
              /kinetic
            </Link>
            .
          </div>
        )}

        {!loading && !error && missions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
                  <th className="text-left py-2 px-3">Mission ID</th>
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Date</th>
                  <th className="text-right py-2 px-3">Duration</th>
                  <th className="text-right py-2 px-3">Speed</th>
                  <th className="text-right py-2 px-3">Weapons</th>
                  <th className="text-right py-2 px-3">Hit Rate</th>
                  <th className="text-right py-2 px-3">RMS Final</th>
                  <th className="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {missions.map((m) => (
                  <tr
                    key={m.id}
                    className="border-b border-gray-900 hover:bg-gray-950 transition-colors"
                  >
                    <td className="py-2 px-3 text-gray-400 text-xs">
                      {m.id.slice(0, 8)}…
                    </td>
                    <td className="py-2 px-3">{statusBadge(m.status)}</td>
                    <td className="py-2 px-3 text-gray-400 text-xs">
                      {m.created_at
                        ? new Date(m.created_at).toLocaleString()
                        : "—"}
                    </td>
                    <td className="py-2 px-3 text-right text-gray-300">
                      {m.duration_s != null ? `${m.duration_s.toFixed(0)}s` : "—"}
                    </td>
                    <td className="py-2 px-3 text-right text-gray-400 text-xs">
                      {m.sim_speed}×
                    </td>
                    <td className="py-2 px-3 text-right text-gray-300">
                      {m.weapons_launched ?? "—"}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <span
                        className={
                          (m.targets_hit ?? 0) > 0 ? "text-green-400" : "text-gray-500"
                        }
                      >
                        {hitRate(m)}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right text-gray-400 text-xs">
                      {m.tot_rms_final != null ? `${m.tot_rms_final.toFixed(1)}s` : "—"}
                    </td>
                    <td className="py-2 px-3">
                      <Link
                        href={`/missions/${m.id}`}
                        className="text-cyan-500 hover:text-cyan-300 text-xs hover:underline"
                      >
                        VIEW →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
