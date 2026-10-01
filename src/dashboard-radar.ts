/**
 * Radar SVG visualization for Wallet Radar anomalies.
 * ViewBox 640x640:
 * - Center at (320, 320)
 * - Three rings for anomaly scores: 5, 15, 30
 * - 12 tick marks along the outer rim
 * - Points mapped by timestamp (angle 0..330 deg) and weight (radius)
 * - Offsets of ±3 degrees for anomalies sharing the exact same timestamp
 */

export interface RadarAnomaly {
  id: string;
  type: string;
  severity?: string;
  score?: number;
  timestamp?: number;
  description?: string;
}

export interface RenderRadarOptions {
  anomalies?: RadarAnomaly[];
  window?: { sinceSec?: number; untilSec?: number };
  hasData?: boolean;
}

export interface RadarRenderResult {
  svg: string;
  sweepHtml: string;
  caption: string;
  anomalyAngles: Map<string, number>;
}

export function renderRadar(opts: RenderRadarOptions): RadarRenderResult {
  const cx = 320;
  const cy = 320;
  const r5 = 85;
  const r15 = 175;
  const r30 = 265;
  const rOuter = 300;

  const caption = "angle: time of the anomaly within the analysed window; small offsets within one timestamp are for legibility only";
  const anomalyAngles = new Map<string, number>();

  const ticks: string[] = [];
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    const x1 = cx + 292 * Math.sin(rad);
    const y1 = cy - 292 * Math.cos(rad);
    const x2 = cx + rOuter * Math.sin(rad);
    const y2 = cy - rOuter * Math.cos(rad);
    ticks.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--hair)" stroke-width="1" />`);
  }

  const bgElements = [
    `<!-- Crosshairs -->`,
    `<line x1="320" y1="20" x2="320" y2="620" stroke="var(--hair)" stroke-width="1" />`,
    `<line x1="20" y1="320" x2="620" y2="320" stroke="var(--hair)" stroke-width="1" />`,
    `<!-- Concentric rings -->`,
    `<circle cx="${cx}" cy="${cy}" r="${r5}" fill="none" stroke="var(--hair)" stroke-width="1" />`,
    `<circle cx="${cx}" cy="${cy}" r="${r15}" fill="none" stroke="var(--hair)" stroke-width="1" />`,
    `<circle cx="${cx}" cy="${cy}" r="${r30}" fill="none" stroke="var(--hair)" stroke-width="1" />`,
    `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--hair)" stroke-width="1" />`,
    `<!-- 12 edge ticks -->`,
    ...ticks,
    `<!-- Ring labels -->`,
    `<text x="325" y="${(cy - r5 + 12).toFixed(1)}" fill="var(--ink3)" font-size="11" font-family="var(--display)">5</text>`,
    `<text x="325" y="${(cy - r15 + 12).toFixed(1)}" fill="var(--ink3)" font-size="11" font-family="var(--display)">15</text>`,
    `<text x="325" y="${(cy - r30 + 12).toFixed(1)}" fill="var(--ink3)" font-size="11" font-family="var(--display)">30</text>`,
    `<text x="320" y="44" text-anchor="middle" fill="var(--ink3)" font-size="11" font-family="var(--display)">score per anomaly</text>`,
    `<!-- Center wallet dot -->`,
    `<circle cx="${cx}" cy="${cy}" r="3" fill="var(--ink)" />`,
  ];

  const dotElements: string[] = [];
  const anomalies = opts.anomalies || [];
  const hasData = Boolean(opts.hasData && anomalies.length > 0);

  if (hasData) {
    let windowStart = opts.window?.sinceSec;
    let windowEnd = opts.window?.untilSec;

    if (windowStart == null || windowEnd == null || windowEnd <= windowStart) {
      const timestamps = anomalies.map((a) => a.timestamp).filter((t): t is number => t != null && t > 0);
      if (timestamps.length > 0) {
        windowStart = Math.min(...timestamps);
        windowEnd = Math.max(...timestamps);
      } else {
        windowStart = 0;
        windowEnd = 1;
      }
    }
    const span = Math.max(1, windowEnd - windowStart);

    // Group anomalies by timestamp to calculate ±3 deg offsets for identical timestamps
    const tsGroups = new Map<number, number[]>();
    anomalies.forEach((a, idx) => {
      const t = a.timestamp || 0;
      if (!tsGroups.has(t)) tsGroups.set(t, []);
      tsGroups.get(t)!.push(idx);
    });

    const computedAngles = new Array<number>(anomalies.length);
    for (const [, indices] of tsGroups) {
      const k = indices.length;
      indices.forEach((idx, pos) => {
        const a = anomalies[idx];
        const t = a.timestamp || windowStart!;
        const frac = Math.max(0, Math.min(1, (t - windowStart!) / span));
        const baseAngle = frac * 330;
        const offset = (pos - (k - 1) / 2) * 3;
        const finalAngle = Math.max(0, Math.min(359, (baseAngle + offset + 360) % 360));
        computedAngles[idx] = finalAngle;
      });
    }

    anomalies.forEach((a, idx) => {
      const angle = computedAngles[idx];
      anomalyAngles.set(a.id, angle);

      let r = r15;
      if (a.score != null && Number.isFinite(a.score)) {
        if (a.score <= 5) r = r5;
        else if (a.score <= 15) r = r15;
        else r = r30;
      } else {
        const sev = (a.severity || "").toLowerCase();
        if (sev === "low") r = r5;
        else if (sev === "high") r = r30;
        else r = r15;
      }

      const rad = (angle * Math.PI) / 180;
      const x = cx + r * Math.sin(rad);
      const y = cy - r * Math.cos(rad);
      const delay = (angle / 360) * 2.4;
      const sev = (a.severity || "medium").toLowerCase();

      if (sev === "low") {
        dotElements.push(
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="none" stroke="var(--ink2)" stroke-width="1" class="radar-dot radar-dot-low" data-anomaly-id="${a.id}" style="animation-delay: ${delay.toFixed(3)}s;" />`
        );
      } else if (sev === "high") {
        dotElements.push(
          `<g class="radar-dot radar-dot-high" data-anomaly-id="${a.id}" style="animation-delay: ${delay.toFixed(3)}s;">` +
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="var(--accent)" />` +
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="none" stroke="var(--accent)" stroke-width="1" />` +
          `</g>`
        );
      } else {
        dotElements.push(
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--accent)" class="radar-dot radar-dot-med" data-anomaly-id="${a.id}" style="animation-delay: ${delay.toFixed(3)}s;" />`
        );
      }
    });
  }

  const svg = [
    `<svg class="radar-svg" viewBox="0 0 640 640" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">`,
    `  <g class="radar-bg">`,
    `    ${bgElements.join("\n    ")}`,
    `  </g>`,
    hasData && dotElements.length > 0
      ? `  <g class="radar-group">\n    ${dotElements.join("\n    ")}\n  </g>`
      : ``,
    `</svg>`,
  ].filter(Boolean).join("\n");

  const sweepHtml = hasData ? `<div class="radar-sweep"></div>` : "";

  return {
    svg,
    sweepHtml,
    caption,
    anomalyAngles,
  };
}
