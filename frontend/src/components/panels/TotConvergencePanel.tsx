"use client";

/**
 * ToT Convergence Panel
 * D3 line chart showing RMS(τᵢ - τ*) over simulation time.
 * Goes to zero when all weapons have converged on simultaneous impact.
 */

import { useEffect, useRef } from "react";
import { useEntityGraph } from "@/stores/entityGraph";

export default function TotConvergencePanel() {
  const svgRef = useRef<SVGSVGElement>(null);
  const historyRef = useRef<{ t: number; rms: number }[]>([]);
  const { getWeapons, simTimeS } = useEntityGraph();

  useEffect(() => {
    const weapons = getWeapons().filter(
      (w) => !["DESTROYED", "IMPACTED"].includes((w.properties.suda_state as string) ?? ""),
    );
    if (weapons.length === 0) return;

    const taus = weapons
      .map((w) => w.properties.tau_i as number)
      .filter((t) => typeof t === "number");
    if (taus.length === 0) return;

    const mean = taus.reduce((a, b) => a + b, 0) / taus.length;
    const rms = Math.sqrt(taus.reduce((s, t) => s + (t - mean) ** 2, 0) / taus.length);

    historyRef.current.push({ t: simTimeS, rms });
    // Keep last 120 samples
    if (historyRef.current.length > 120) historyRef.current.shift();

    renderChart();
  }, [simTimeS]);

  const renderChart = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const data = historyRef.current;
    if (data.length < 2) return;

    import("d3").then((d3) => {
      const W = 148, H = 72;
      const margin = { top: 6, right: 6, bottom: 16, left: 30 };
      const iW = W - margin.left - margin.right;
      const iH = H - margin.top - margin.bottom;

      d3.select(svg).selectAll("*").remove();
      const g = d3
        .select(svg)
        .attr("width", W)
        .attr("height", H)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      const xScale = d3
        .scaleLinear()
        .domain([data[0].t, data[data.length - 1].t])
        .range([0, iW]);
      const yScale = d3
        .scaleLinear()
        .domain([0, Math.max(5, d3.max(data, (d) => d.rms) ?? 5)])
        .range([iH, 0]);

      // Grid line at y=2 (ToT tolerance)
      g.append("line")
        .attr("x1", 0)
        .attr("x2", iW)
        .attr("y1", yScale(2))
        .attr("y2", yScale(2))
        .attr("stroke", "#22c55e")
        .attr("stroke-dasharray", "3,3")
        .attr("stroke-width", 0.5);

      // RMS line
      const line = d3
        .line<{ t: number; rms: number }>()
        .x((d) => xScale(d.t))
        .y((d) => yScale(d.rms))
        .curve(d3.curveMonotoneX);

      g.append("path")
        .datum(data)
        .attr("fill", "none")
        .attr("stroke", "#22d3ee")
        .attr("stroke-width", 1.5)
        .attr("d", line);

      // Axes
      g.append("g")
        .attr("transform", `translate(0,${iH})`)
        .call(d3.axisBottom(xScale).ticks(3).tickFormat((d) => `${d}s`))
        .selectAll("text,line,path")
        .attr("stroke", "#4b5563")
        .attr("fill", "#4b5563")
        .style("font-size", "8px");

      g.append("g")
        .call(d3.axisLeft(yScale).ticks(3))
        .selectAll("text,line,path")
        .attr("stroke", "#4b5563")
        .attr("fill", "#4b5563")
        .style("font-size", "8px");
    });
  };

  const weapons = getWeapons();
  const taus = weapons.map((w) => w.properties.tau_i as number).filter((t) => typeof t === "number");
  const mean = taus.length ? taus.reduce((a, b) => a + b, 0) / taus.length : 0;
  const rms = taus.length
    ? Math.sqrt(taus.reduce((s, t) => s + (t - mean) ** 2, 0) / taus.length)
    : 0;

  return (
    <div className="bg-[#0a1628] border border-[#1a2a40] rounded p-2">
      <div className="text-gray-500 text-xs font-mono mb-1 flex justify-between">
        <span>TOT CONVERGENCE</span>
        <span className={rms < 2 ? "text-green-400" : "text-yellow-400"}>
          RMS {rms.toFixed(2)}s
        </span>
      </div>
      <svg ref={svgRef} />
    </div>
  );
}
