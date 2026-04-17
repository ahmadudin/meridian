import fs from "fs";
import { closePaperTrade, markPaperTrade } from "./paper-engine.js";
import { loadPaperState } from "./paper-state.js";
import { log } from "./logger.js";

function roundPct(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundSol(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

// ─── Calibration Loader ──────────────────────────────────────────

const CALIBRATION_PATH = "./paper-calibration.json";
const DEFAULTS_PATH = "./paper-calibration.defaults.json";

let _calibrationCache = null;
let _calibrationCacheAt = 0;
const CALIBRATION_TTL = 5 * 60_000; // reload every 5 min

function loadCalibration() {
  if (_calibrationCache && Date.now() - _calibrationCacheAt < CALIBRATION_TTL) {
    return _calibrationCache;
  }
  try {
    _calibrationCache = JSON.parse(fs.readFileSync(CALIBRATION_PATH, "utf8"));
    _calibrationCacheAt = Date.now();
    return _calibrationCache;
  } catch {
    try {
      _calibrationCache = JSON.parse(fs.readFileSync(DEFAULTS_PATH, "utf8"));
      _calibrationCacheAt = Date.now();
      return _calibrationCache;
    } catch {
      // Hard-coded reasonable defaults if both files missing
      return {
        directional: {
          low_vol: { alpha: 0.25, beta: -0.3 },
          mid_vol: { alpha: 0.35, beta: -0.5 },
          high_vol: { alpha: 0.50, beta: -1.0 },
        },
        fee_multiplier: 0.18,
        range_efficiency_factor: 0.72,
      };
    }
  }
}

// ─── Directional Alpha (calibrated by volatility bucket) ─────────

function getDirectionalAlpha(volatility, cal) {
  if (!cal?.directional) return 0.35;
  if (volatility < 1.5) return cal.directional.low_vol?.alpha ?? 0.25;
  if (volatility < 3.5) return cal.directional.mid_vol?.alpha ?? 0.35;
  return cal.directional.high_vol?.alpha ?? 0.50;
}

// ─── In-Range Probability (GBM approximation) ───────────────────

/**
 * Estimate probability of staying in-range over a time horizon.
 *
 * Uses a simplified geometric Brownian motion approximation:
 *   P(in_range) ≈ sigmoid(range_width / (σ × √t))
 *
 * Where σ is approximated from the Meteora volatility metric.
 */
function estimateInRangeProbability(volatility, rangeWidthPct, holdHours) {
  if (rangeWidthPct <= 0) return 0;
  const sigma = (volatility / 100) * Math.sqrt(holdHours / 24);
  if (sigma <= 0) return 0.95; // low vol = likely in range
  const zScore = (rangeWidthPct / 100) / (sigma * 2); // two-sided
  // Approximate erf using logistic function
  const probability = 1 / (1 + Math.exp(-1.7 * zScore));
  return Math.min(0.99, Math.max(0.05, probability));
}

// ─── Impermanent Loss Model (concentrated liquidity) ─────────────

/**
 * Concentrated liquidity IL model.
 *
 * Standard Uniswap v2 IL: IL = 2√r / (1+r) - 1  where r = P_new/P_old
 * Concentrated liquidity amplifies IL by the concentration factor.
 */
function estimateImpermanentLoss(priceChangePct, concentrationFactor) {
  const r = 1 + priceChangePct / 100;
  if (r <= 0) return -100; // price went to zero
  const standardIL = (2 * Math.sqrt(r) / (1 + r) - 1) * 100;
  // Concentration amplifies IL: more concentrated = higher IL
  const concentrationBoost = concentrationFactor * 1.5; // empirical
  return roundPct(standardIL * (1 + concentrationBoost));
}

// ─── Main Return Estimator ───────────────────────────────────────

export function estimatePaperReturn({ trade, currentPrice, snapshot = {}, horizonMin = null } = {}) {
  const entryPrice = Number(trade?.entry?.price);
  const nextPrice = Number(currentPrice);
  const allocatedSol = Number(trade?.allocated_sol) || 0;
  const cal = loadCalibration();

  // ── 1. Price Return ──────────────────────────────────────────
  const priceReturnPct = entryPrice > 0 && Number.isFinite(nextPrice)
    ? ((nextPrice - entryPrice) / entryPrice) * 100
    : 0;

  // ── 2. Directional Return (calibrated) ───────────────────────
  const volatility = Number(snapshot?.volatility) || Number(trade?.entry?.snapshot?.volatility) || 0;
  const dirAlpha = getDirectionalAlpha(volatility, cal);
  const directionalReturnPct = priceReturnPct * dirAlpha;

  // ── 3. Fee Return (DLMM-aware) ──────────────────────────────
  const feeActiveTvlRatio = Number(snapshot?.fee_active_tvl_ratio || 0);
  const holdHours = Math.max(1, Number(horizonMin || 0) / 60);
  const binStep = Number(trade?.entry?.snapshot?.bin_step || trade?.meta?.bin_step || 100);
  const binsBelow = Number(trade?.meta?.bins_below || 69);
  const binsAbove = Number(trade?.meta?.bins_above || 0);

  // Concentration factor: fewer bins = more concentrated = higher fee share
  const totalBins = binsBelow + binsAbove + 1;
  const concentrationFactor = Math.min(1.0, 10 / totalBins);

  // In-range probability: based on volatility and bin width
  const binWidthPct = (binStep / 10000) * totalBins * 100;
  const inRangeProbability = estimateInRangeProbability(volatility, binWidthPct, holdHours);

  // Fee calculation
  const feeMultiplier = cal?.fee_multiplier ?? 0.18;
  const feeReturnPct = feeActiveTvlRatio * holdHours * feeMultiplier
    * concentrationFactor
    * inRangeProbability;

  // ── 4. Impermanent Loss ──────────────────────────────────────
  const ilPct = estimateImpermanentLoss(priceReturnPct, concentrationFactor);

  // ── 5. OOR check ─────────────────────────────────────────────
  const activeBin = Number(snapshot?.active_bin) || null;
  const lowerBin = trade?.bin_range?.lower_bin ?? null;
  const upperBin = trade?.bin_range?.upper_bin ?? null;
  const isInRange = activeBin != null && lowerBin != null && upperBin != null
    ? activeBin >= lowerBin && activeBin <= upperBin
    : true; // assume in-range if no bin data

  // ── 6. Total ─────────────────────────────────────────────────
  const totalReturnPct = directionalReturnPct + feeReturnPct + ilPct;
  const unrealizedPnlSol = allocatedSol * (totalReturnPct / 100);

  return {
    price_return_pct: roundPct(priceReturnPct),
    directional_return_pct: roundPct(directionalReturnPct),
    directional_alpha: roundPct(dirAlpha),
    fee_return_pct: roundPct(feeReturnPct),
    fee_components: {
      fee_tvl_ratio: feeActiveTvlRatio,
      hold_hours: roundPct(holdHours),
      concentration_factor: roundPct(concentrationFactor),
      in_range_probability: roundPct(inRangeProbability),
      fee_multiplier: feeMultiplier,
    },
    il_pct: roundPct(ilPct),
    in_range: isInRange,
    active_bin: activeBin,
    total_return_pct: roundPct(totalReturnPct),
    unrealized_pnl_sol: roundSol(unrealizedPnlSol),
  };
}

// ─── Evaluate All Open Paper Trades ──────────────────────────────

export async function evaluatePaperTrades({
  filePath,
  now = Date.now(),
  horizonsMin = [5, 15, 60],
  primaryHorizonMin = 15,
  takeProfitPct = 3,
  stopLossPct = -3,
  autoCloseAtMaxHorizon = true,
  outOfRangeWaitMinutes = 30,
  priceFetcher,
} = {}) {
  const state = loadPaperState({ filePath });
  const openTrades = Object.values(state.open_trades || {});
  if (!openTrades.length) {
    return { evaluated: 0, closed: 0, open: 0, errors: 0, closedTradeIds: [] };
  }

  const uniqueHorizons = [...new Set(horizonsMin.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))].sort((a, b) => a - b);
  const maxHorizon = uniqueHorizons[uniqueHorizons.length - 1] || primaryHorizonMin;
  let evaluated = 0;
  let closed = 0;
  let errors = 0;
  const closedTradeIds = [];

  for (const trade of openTrades) {
    const openedMs = Date.parse(trade.opened_at || new Date(now).toISOString()) || now;
    const dueHorizons = uniqueHorizons.filter((h) => now - openedMs >= h * 60_000 && !trade.evaluations?.[String(h)]);
    if (!dueHorizons.length) continue;

    let snapshot;
    try {
      snapshot = await priceFetcher(trade.pool_address, trade);
    } catch (error) {
      errors += 1;
      log("paper_eval_warn", `Price fetch failed for pool ${trade.pool_address}: ${error.message}`);
      continue;
    }

    for (const horizonMin of dueHorizons) {
      let evaluation;
      let estimate;
      try {
        estimate = estimatePaperReturn({
          trade,
          currentPrice: snapshot?.price,
          snapshot,
          horizonMin,
        });
        evaluation = {
          evaluated_at: new Date(now).toISOString(),
          horizon_min: horizonMin,
          price: snapshot?.price ?? null,
          active_bin: snapshot?.active_bin ?? null,
          volatility: snapshot?.volatility ?? null,
          fee_active_tvl_ratio: snapshot?.fee_active_tvl_ratio ?? null,
          price_return_pct: estimate.price_return_pct,
          directional_return_pct: estimate.directional_return_pct,
          directional_alpha: estimate.directional_alpha,
          fee_return_pct: estimate.fee_return_pct,
          fee_components: estimate.fee_components,
          il_pct: estimate.il_pct,
          in_range: estimate.in_range,
          total_return_pct: estimate.total_return_pct,
        };
      } catch (error) {
        errors += 1;
        log("paper_eval_warn", `estimatePaperReturn failed for trade ${trade.id} horizon ${horizonMin}: ${error.message}`);
        continue;
      }
      try {
        await markPaperTrade({
          filePath,
          tradeId: trade.id,
          price: snapshot?.price ?? null,
          activeBin: snapshot?.active_bin ?? null,
          returnPct: estimate.total_return_pct,
          unrealizedPnlSol: estimate.unrealized_pnl_sol,
          evaluation,
          inRange: estimate.in_range,
          now,
        });
      } catch (error) {
        errors += 1;
        log("paper_eval_warn", `markPaperTrade failed for trade ${trade.id}: ${error.message}`);
        continue;
      }
      evaluated += 1;
    }

    const refreshed = loadPaperState({ filePath }).open_trades?.[trade.id];
    if (!refreshed) continue;
    const primaryEval = refreshed.evaluations?.[String(primaryHorizonMin)] || null;
    const maxEval = refreshed.evaluations?.[String(maxHorizon)] || null;

    // ── OOR auto-close ─────────────────────────────────────────
    const cumulativeOorMin = refreshed.oor_minutes || 0;
    if (cumulativeOorMin >= outOfRangeWaitMinutes) {
      const latestEval = primaryEval || maxEval || Object.values(refreshed.evaluations || {})[0];
      await closePaperTrade({
        filePath,
        tradeId: trade.id,
        closeReasonCode: "out_of_range",
        closeReasonDetail: `OOR for ${cumulativeOorMin} minutes`,
        finalReturnPct: latestEval?.total_return_pct ?? 0,
        closePrice: snapshot?.price ?? null,
        closeActiveBin: snapshot?.active_bin ?? null,
        now,
      });
      closed += 1;
      closedTradeIds.push(trade.id);
      continue;
    }

    // ── TP/SL on primary horizon ───────────────────────────────
    if (primaryEval) {
      if ((Number(primaryEval.total_return_pct) || 0) >= takeProfitPct) {
        await closePaperTrade({
          filePath,
          tradeId: trade.id,
          closeReasonCode: "primary_take_profit",
          finalReturnPct: primaryEval.total_return_pct,
          closePrice: snapshot?.price ?? null,
          closeActiveBin: snapshot?.active_bin ?? null,
          now,
        });
        closed += 1;
        closedTradeIds.push(trade.id);
        continue;
      }
      if ((Number(primaryEval.total_return_pct) || 0) <= stopLossPct) {
        await closePaperTrade({
          filePath,
          tradeId: trade.id,
          closeReasonCode: "primary_stop_loss",
          finalReturnPct: primaryEval.total_return_pct,
          closePrice: snapshot?.price ?? null,
          closeActiveBin: snapshot?.active_bin ?? null,
          now,
        });
        closed += 1;
        closedTradeIds.push(trade.id);
        continue;
      }
    }

    // ── Auto-close at max horizon ──────────────────────────────
    if (autoCloseAtMaxHorizon && maxEval) {
      await closePaperTrade({
        filePath,
        tradeId: trade.id,
        closeReasonCode: "max_horizon_reached",
        finalReturnPct: maxEval.total_return_pct,
        closePrice: snapshot?.price ?? null,
        closeActiveBin: snapshot?.active_bin ?? null,
        now,
      });
      closed += 1;
      closedTradeIds.push(trade.id);
    }
  }

  const finalState = loadPaperState({ filePath });
  return {
    evaluated,
    closed,
    open: Object.keys(finalState.open_trades || {}).length,
    errors,
    closedTradeIds,
  };
}
