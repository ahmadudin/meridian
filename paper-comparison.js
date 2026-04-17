/**
 * paper-comparison.js — Live vs Paper comparison logger.
 *
 * Logs discrepancies between paper predictions and live results at position close.
 * Used for continuous model calibration and accuracy monitoring.
 */

import fs from "fs";
import { log } from "./logger.js";

const COMPARISON_FILE = "./paper-comparison-log.json";
const MAX_ENTRIES = 500;

/**
 * Log a comparison between a live position's actual results and what
 * the paper model would have predicted.
 *
 * @param {Object} liveResult - Performance data from recordPerformance()
 * @param {Object} paperPrediction - Optional paper model prediction (if available)
 */
export function logLiveVsPaper(liveResult, paperPrediction = null) {
  if (!liveResult?.pool) return;

  const entry = {
    timestamp: new Date().toISOString(),
    pool: liveResult.pool,
    pool_name: liveResult.pool_name,
    // Live (ground truth)
    live_pnl_pct: liveResult.pnl_pct ?? null,
    live_fee_pct:
      liveResult.fees_earned_usd > 0 && liveResult.initial_value_usd > 0
        ? Math.round((liveResult.fees_earned_usd / liveResult.initial_value_usd) * 10000) / 100
        : 0,
    live_range_efficiency: liveResult.range_efficiency ?? null,
    live_minutes_held: liveResult.minutes_held ?? null,
    // Paper prediction (if available)
    paper_directional_pct: paperPrediction?.directional_return_pct ?? null,
    paper_fee_pct: paperPrediction?.fee_return_pct ?? null,
    paper_il_pct: paperPrediction?.il_pct ?? null,
    paper_total_pct: paperPrediction?.total_return_pct ?? null,
    // Delta
    pnl_delta:
      liveResult.pnl_pct != null && paperPrediction?.total_return_pct != null
        ? Math.round((liveResult.pnl_pct - paperPrediction.total_return_pct) * 100) / 100
        : null,
    // Context
    volatility: liveResult.volatility ?? null,
    bin_step: liveResult.bin_step ?? null,
    strategy: liveResult.strategy ?? null,
  };

  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(COMPARISON_FILE, "utf8"));
  } catch {
    /* ignore — file doesn't exist yet */
  }
  if (!Array.isArray(entries)) entries = [];

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);

  try {
    fs.writeFileSync(COMPARISON_FILE, JSON.stringify(entries, null, 2));
    log("paper_comparison", `Logged live vs paper: ${liveResult.pool_name} | delta=${entry.pnl_delta ?? "n/a"}%`);
  } catch (err) {
    log("paper_comparison_error", `Failed to write comparison log: ${err.message}`);
  }
}

/**
 * Get accuracy summary statistics from the comparison log.
 */
export function getComparisonAccuracy() {
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(COMPARISON_FILE, "utf8"));
  } catch {
    return { total: 0, mean_abs_error: null, bias: null, r2: null };
  }

  const withDelta = entries.filter((e) => e.pnl_delta != null);
  if (withDelta.length === 0) {
    return { total: entries.length, matched: 0, mean_abs_error: null, bias: null };
  }

  const deltas = withDelta.map((e) => e.pnl_delta);
  const absDeltas = deltas.map((d) => Math.abs(d));
  const mae = absDeltas.reduce((a, b) => a + b, 0) / absDeltas.length;
  const bias = deltas.reduce((a, b) => a + b, 0) / deltas.length;

  // R² between live and paper
  const liveVals = withDelta.map((e) => e.live_pnl_pct);
  const paperVals = withDelta.map((e) => e.paper_total_pct);
  const liveMean = liveVals.reduce((a, b) => a + b, 0) / liveVals.length;
  const ssRes = liveVals.reduce((a, y, i) => a + (y - paperVals[i]) ** 2, 0);
  const ssTot = liveVals.reduce((a, y) => a + (y - liveMean) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    total: entries.length,
    matched: withDelta.length,
    mean_abs_error: Math.round(mae * 100) / 100,
    bias: Math.round(bias * 100) / 100,
    r2: Math.round(r2 * 1000) / 1000,
  };
}
