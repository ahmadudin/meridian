/**
 * Calibration script for paper trading return model.
 *
 * Usage: node scripts/calibrate-paper.js
 *
 * Reads closed position data from lessons.json, compares actual returns
 * against the paper model's predicted returns, and outputs calibration
 * coefficients to paper-calibration.json.
 *
 * Requires at least 10 closed positions with valid data.
 * If insufficient data, ships with reasonable defaults.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_PATH = path.join(__dirname, "../lessons.json");
const CALIBRATION_PATH = path.join(__dirname, "../paper-calibration.json");
const MIN_RECORDS = 10;

// ─── OLS Regression: y = α*x + β ────────────────────────────────
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return { alpha: 0, beta: 0, r2: 0 };
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { alpha: 1, beta: 0, r2: 0 };
  const alpha = (n * sumXY - sumX * sumY) / denom;
  const beta = (sumY - alpha * sumX) / n;
  // R²
  const yMean = sumY / n;
  const ssRes = ys.reduce((a, y, i) => a + (y - (alpha * xs[i] + beta)) ** 2, 0);
  const ssTot = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return {
    alpha: Math.round(alpha * 1000) / 1000,
    beta: Math.round(beta * 1000) / 1000,
    r2: Math.round(r2 * 1000) / 1000,
  };
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Reasonable defaults (pre-calibration) ───────────────────────
const REASONABLE_DEFAULTS = {
  version: 1,
  calibrated_at: null,
  source: "defaults",
  sample_size: 0,
  directional: {
    low_vol:  { alpha: 0.25, beta: -0.3, r2: 0, n: 0 },
    mid_vol:  { alpha: 0.35, beta: -0.5, r2: 0, n: 0 },
    high_vol: { alpha: 0.50, beta: -1.0, r2: 0, n: 0 },
  },
  fee_multiplier: 0.18,
  range_efficiency_factor: 0.72,
  global_directional_alpha: { alpha: 0.35, beta: -0.5, r2: 0 },
};

// ─── Main ────────────────────────────────────────────────────────
function run() {
  let data = { performance: [] };
  if (fs.existsSync(LESSONS_PATH)) {
    try {
      data = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
    } catch (err) {
      console.error(`Failed to parse lessons.json: ${err.message}`);
    }
  }

  const records = (data.performance || []).filter(
    (p) =>
      p.pnl_pct != null &&
      p.initial_value_usd > 0 &&
      p.minutes_held > 0 &&
      p.volatility != null
  );

  if (records.length < MIN_RECORDS) {
    console.log(
      `Only ${records.length} valid records (need ${MIN_RECORDS}). Writing reasonable defaults.`
    );
    const defaults = {
      ...REASONABLE_DEFAULTS,
      calibrated_at: new Date().toISOString(),
      source: "defaults",
      sample_size: records.length,
    };
    fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(defaults, null, 2));
    console.log("Wrote paper-calibration.json with reasonable defaults.");
    console.log(JSON.stringify(defaults, null, 2));
    return defaults;
  }

  // ── 1. Directional multiplier calibration (by volatility bucket) ──
  const sorted = [...records].sort((a, b) => (a.volatility || 0) - (b.volatility || 0));
  const q1 = Math.floor(sorted.length * 0.25);
  const q3 = Math.floor(sorted.length * 0.75);
  const buckets = {
    low_vol: sorted.slice(0, q1),
    mid_vol: sorted.slice(q1, q3),
    high_vol: sorted.slice(q3),
  };

  const directionalCoeffs = {};
  for (const [bucket, recs] of Object.entries(buckets)) {
    if (recs.length < 3) {
      directionalCoeffs[bucket] = {
        alpha: REASONABLE_DEFAULTS.directional[bucket].alpha,
        beta: REASONABLE_DEFAULTS.directional[bucket].beta,
        r2: 0,
        n: recs.length,
      };
      continue;
    }
    const xs = recs.map((r) => r.volatility || 0);
    const ys = recs.map((r) => r.pnl_pct || 0);
    const reg = linearRegression(xs, ys);
    directionalCoeffs[bucket] = { ...reg, n: recs.length };
  }

  // ── 2. Fee model calibration ──────────────────────────────────────
  const feeRecords = records.filter(
    (r) => r.fee_tvl_ratio != null && r.fees_earned_usd != null
  );
  let feeMultiplier = REASONABLE_DEFAULTS.fee_multiplier;
  if (feeRecords.length >= 5) {
    const xs = feeRecords.map((r) => (r.fee_tvl_ratio || 0) * (r.minutes_held / 60));
    const ys = feeRecords.map((r) =>
      r.initial_value_usd > 0
        ? (r.fees_earned_usd / r.initial_value_usd) * 100
        : 0
    );
    const reg = linearRegression(xs, ys);
    feeMultiplier = reg.alpha > 0 ? Math.round(reg.alpha * 1000) / 1000 : REASONABLE_DEFAULTS.fee_multiplier;
  }

  // ── 3. Range efficiency factor ────────────────────────────────────
  const rangeRecords = records.filter((r) => r.range_efficiency != null);
  let rangeEfficiencyFactor = REASONABLE_DEFAULTS.range_efficiency_factor;
  if (rangeRecords.length >= 5) {
    const avgEfficiency =
      rangeRecords.reduce((s, r) => s + r.range_efficiency, 0) / rangeRecords.length;
    rangeEfficiencyFactor = Math.round((avgEfficiency / 100) * 1000) / 1000;
  }

  // ── 4. Global directional regression ──────────────────────────────
  const globalXs = records.map((r) => r.volatility || 0);
  const globalYs = records.map((r) => r.pnl_pct || 0);
  const globalReg = linearRegression(globalXs, globalYs);

  const calibration = {
    version: 1,
    calibrated_at: new Date().toISOString(),
    source: "calibrated",
    sample_size: records.length,
    directional: directionalCoeffs,
    fee_multiplier: feeMultiplier,
    range_efficiency_factor: rangeEfficiencyFactor,
    global_directional_alpha: globalReg,
  };

  fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(calibration, null, 2));
  console.log(`Calibration complete (${records.length} records):`);
  console.log(JSON.stringify(calibration, null, 2));
  return calibration;
}

// Export for programmatic use
export { run as calibratePaper, REASONABLE_DEFAULTS };

// Run if called directly
if (process.argv[1] && process.argv[1].includes("calibrate-paper")) {
  run();
}
