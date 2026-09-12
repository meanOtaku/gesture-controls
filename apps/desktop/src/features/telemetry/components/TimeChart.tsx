import type { SeriesPoint } from "../store/telemetryStore";

/** All channels in a chart share units and a scale, so their amplitudes are comparable. */
export function chartGeometry(points: SeriesPoint[], channels: number) {
  const values = points.filter((p) => Number.isFinite(p.at))
    .flatMap((p) => p.values.slice(0, channels)).filter(Number.isFinite);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const padding = high === low ? Math.max(Math.abs(low) * 0.05, 1) : (high - low) * 0.08;
  const min = low - padding;
  const max = high + padding;
  const times = points.map((p) => p.at).filter(Number.isFinite);
  const start = times[0] ?? 0;
  const end = times[times.length - 1] ?? start;
  const duration = Math.max(end - start, 1);
  const paths = Array.from({ length: channels }, (_, channel) => {
    let drawing = false;
    return points.map((point) => {
      const value = point.values[channel];
      if (!Number.isFinite(value) || !Number.isFinite(point.at)) {
        drawing = false;
        return "";
      }
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${(((point.at - start) / duration) * 720).toFixed(1)},${(180 - ((value - min) / (max - min)) * 180).toFixed(1)}`;
    }).join(" ");
  });
  return { min, max, duration: end - start, paths, hasData: values.length > 0 };
}

const tick = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function TimeChart({ title, points, labels, colors, unit = "", emptyHint = "Connect your device to see incoming samples." }: {
  title: string;
  points: SeriesPoint[];
  labels: string[];
  colors: string[];
  unit?: string;
  emptyHint?: string;
}) {
  const chart = chartGeometry(points, labels.length);
  return <section className="telemetry-chart" aria-label={title}>
    <div className="telemetry-chart-heading">
      <h2>{title}</h2><span className="telemetry-count">{points.length} samples</span>
    </div>
    <div className="telemetry-legend">
      {labels.map((label, index) => <span key={label}><i style={{ background: colors[index] }} />{label}</span>)}
      {unit && <span className="chart-unit">{unit}</span>}
    </div>
    <div className={`chart-plot ${chart.hasData ? "" : "is-empty"}`}>
      {chart.hasData && <div className="chart-scale" aria-label={`${title} scale`}><span>{tick(chart.max)}</span><span>{tick((chart.min + chart.max) / 2)}</span><span>{tick(chart.min)}</span></div>}
      <svg viewBox="0 0 720 180" role="img" aria-label={`${title} live graph`} preserveAspectRatio="none">
        <path className="telemetry-grid-line" d="M0,90H720" />
        {chart.hasData && chart.paths.map((path, index) => <path key={index} d={path} stroke={colors[index]} />)}
      </svg>
      {!chart.hasData && <div className="chart-empty"><span aria-hidden="true">∿</span><strong>Waiting for samples</strong><p>{emptyHint}</p></div>}
    </div>
    <div className="chart-time"><span>{chart.hasData ? `${(chart.duration / 1000).toFixed(1)}s ago` : "No samples received"}</span><span>{chart.hasData ? "Latest sample" : ""}</span></div>
  </section>;
}
