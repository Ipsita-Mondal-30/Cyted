export type TrendPoint = {
  id: string;
  label: string;
  date: Date;
  score: number;
};

function scoreColor(score: number) {
  if (score < 35) return "#dc2626";
  if (score < 65) return "#d97706";
  return "#059669";
}

export function ScoreBar({ score }: { score: number }) {
  const clamped = Math.min(100, Math.max(0, score));
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-stone-200 sm:w-40">
        <div
          className="chart-bar-x h-full rounded-full"
          style={{ width: `${clamped}%`, background: scoreColor(score) }}
        />
      </div>
      <span className="w-10 text-right text-sm font-semibold tabular-nums text-stone-900">
        {score.toFixed(1)}
      </span>
    </div>
  );
}

export function VisibilityTrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null;

  const width = 720;
  const height = 220;
  const pad = { top: 16, right: 16, bottom: 28, left: 36 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (i / (points.length - 1)) * innerW;
  const y = (score: number) =>
    pad.top + innerH - (Math.min(100, Math.max(0, score)) / 100) * innerH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.score)}`).join(" ");
  const area = `${line} L${x(points.length - 1)},${pad.top + innerH} L${x(0)},${pad.top + innerH} Z`;
  const latest = points[points.length - 1];
  const delta = latest.score - points[points.length - 2].score;
  const fmtDate = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <section className="mb-8 rounded-lg border border-stone-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-sans text-lg font-semibold text-stone-900">
            Visibility over time
          </h2>
          <p className="text-sm text-stone-500">
            Visibility score of your completed analyses, oldest to newest.
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums text-stone-900">
            {latest.score.toFixed(1)}
          </p>
          <p
            className={`text-xs font-medium tabular-nums ${
              delta > 0 ? "text-emerald-700" : delta < 0 ? "text-red-600" : "text-stone-500"
            }`}
          >
            {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {Math.abs(delta).toFixed(1)} vs previous
          </p>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="chart-fade h-auto w-full"
        role="img"
        aria-label="Visibility score trend"
      >
        <defs>
          <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#059669" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(g)}
              y2={y(g)}
              stroke="#e7e5e4"
              strokeDasharray={g === 0 ? undefined : "4 4"}
            />
            <text
              x={pad.left - 8}
              y={y(g)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-stone-400 text-[11px]"
            >
              {g}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#trend-fill)" />
        <path
          d={line}
          fill="none"
          stroke="#059669"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => (
          <g key={p.id}>
            <circle
              cx={x(i)}
              cy={y(p.score)}
              r={4.5}
              fill="white"
              stroke={scoreColor(p.score)}
              strokeWidth={2.5}
            >
              <title>{`${p.label} · ${fmtDate(p.date)} · ${p.score.toFixed(1)}`}</title>
            </circle>
            {(i === 0 || i === points.length - 1 || points.length <= 8) && (
              <text
                x={x(i)}
                y={height - 8}
                textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                className="fill-stone-400 text-[11px]"
              >
                {fmtDate(p.date)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </section>
  );
}
