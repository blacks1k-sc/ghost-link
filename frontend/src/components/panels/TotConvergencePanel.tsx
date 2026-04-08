"use client";

/**
 * ToT Convergence Panel
 * D3 line chart: RMS(τᵢ − τ*) over simulation time → approaches 0 at simultaneous impact.
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
    const taus = weapons.map((w) => w.properties.tau_i as number).filter((t) => typeof t === "number");
    if (taus.length === 0) return;
    const mean = taus.reduce((a, b) => a + b, 0) / taus.length;
    const rms = Math.sqrt(taus.reduce((s, t) => s + (t - mean) ** 2, 0) / taus.length);
    historyRef.current.push({ t: simTimeS, rms });
    if (historyRef.current.length > 120) historyRef.current.shift();
    renderChart();
  }, [simTimeS]);

  const renderChart = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const data = historyRef.current;
    if (data.length < 2) return;

    import("d3").then((d3) => {
      const W = 190, H = 72;
      const margin = { top: 5, right: 5, bottom: 14, left: 28 };
      const iW = W - margin.left - margin.right;
      const iH = H - margin.top - margin.bottom;

      d3.select(svg).selectAll("*").remove();
      const g = d3
        .select(svg)
        .attr("width", W)
        .attr("height", H)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      const xScale = d3.scaleLinear().domain([data[0].t, data[data.length - 1].t]).range([0, iW]);
      const yScale = d3.scaleLinear().domain([0, Math.max(5, d3.max(data, (d) => d.rms) ?? 5)]).range([iH, 0]);

      // Convergence threshold line (2s)
      g.append("line")
        .attr("x1", 0).attr("x2", iW)
        .attr("y1", yScale(2)).attr("y2", yScale(2))
        .attr("stroke", "rgba(26,184,88,0.40)")
        .attr("stroke-dasharray", "3,3")
        .attr("stroke-width", 0.8);

      // Area fill
      const area = d3.area<{ t: number; rms: number }>()
        .x((d) => xScale(d.t)).y0(iH).y1((d) => yScale(d.rms)).curve(d3.curveMonotoneX);
      g.append("path").datum(data)
        .attr("fill", "rgba(20,200,232,0.07)").attr("d", area);

      // RMS line
      const line = d3.line<{ t: number; rms: number }>()
        .x((d) => xScale(d.t)).y((d) => yScale(d.rms)).curve(d3.curveMonotoneX);
      g.append("path").datum(data)
        .attr("fill", "none")
        .attr("stroke", "rgba(20,200,232,0.80)")
        .attr("stroke-width", 1.5)
        .attr("d", line);

      // Axes
      g.append("g")
        .attr("transform", `translate(0,${iH})`)
        .call(d3.axisBottom(xScale).ticks(3).tickFormat((d) => `${d}s`))
        .selectAll("text, line, path")
        .attr("stroke", "rgba(54,78,104,0.9)")
        .attr("fill",   "rgba(54,78,104,0.9)")
        .style("font-size", "7px");

      g.append("g")
        .call(d3.axisLeft(yScale).ticks(3))
        .selectAll("text, line, path")
        .attr("stroke", "rgba(54,78,104,0.9)")
        .attr("fill",   "rgba(54,78,104,0.9)")
        .style("font-size", "7px");
    });
  };

  const weapons = getWeapons();
  const taus = weapons.map((w) => w.properties.tau_i as number).filter((t) => typeof t === "number");
  const mean = taus.length ? taus.reduce((a, b) => a + b, 0) / taus.length : 0;
  const rms = taus.length ? Math.sqrt(taus.reduce((s, t) => s + (t - mean) ** 2, 0) / taus.length) : 0;
  const converged = rms < 2 && rms > 0;

  return (
    <div className="px-4 pt-3.5 pb-3">
      <div className="flex items-center justify-between mb-2">
        <span className="gl-label">ToT Convergence</span>
        <span className="font-mono text-[9px] tabular-nums"
          style={{ color: converged ? "var(--ac-green)" : rms > 0 ? "var(--ac-amber)" : "var(--t4)" }}>
          {rms > 0 ? `${rms.toFixed(2)}s RMS` : "—"}
        </span>
      </div>
      <svg ref={svgRef} style={{ display: "block", overflow: "visible" }} />
      {rms === 0 && (
        <div className="font-mono text-[9px] mt-1.5 text-center" style={{ color: "var(--t4)" }}>
          Awaiting simulation data
        </div>
      )}
    </div>
  );
}
