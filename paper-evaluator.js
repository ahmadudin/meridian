import { closePaperTrade, markPaperTrade } from "./paper-engine.js";
import { loadPaperState } from "./paper-state.js";
import { appendComparisonLog } from "./paper-comparison-log.js";
import { loadCalibration } from "./paper-calibration.js";
import { log } from "./logger.js";

function roundPct(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundSol(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

export function estimatePaperReturn({ trade, currentPrice, snapshot = {}, horizonMin = null, now = Date.now() } = {}) {
  const entryPrice = Number(trade?.entry?.price);
  const nextPrice = Number(currentPrice);
  const allocatedSol = Number(trade?.allocated_sol) || 0;
  
  const { coefficients: cal } = loadCalibration();
  
  const priceReturnPct = entryPrice > 0 && Number.isFinite(nextPrice)
    ? ((nextPrice - entryPrice) / entryPrice) * 100
    : 0;

  let directionalReturnPct = priceReturnPct * cal.alpha_directional;
  
  const openedMs = Date.parse(trade?.opened_at) || now;
  const ageMinutes = horizonMin || Math.max(0, Math.floor((now - openedMs) / 60_000));
  const oorMinutes = trade?.oor_state?.minutes_out_of_range || 0;
  const inRangeRatio = ageMinutes > 0 ? Math.max(0, ageMinutes - oorMinutes) / ageMinutes : 1.0;
  
  const feeReturnPct = snapshot?.fee_return_pct !== undefined
    ? Number(snapshot.fee_return_pct)
    : Math.max(0, Number(snapshot?.fee_active_tvl_ratio || 0)) * Math.max(1, ageMinutes / 60) * cal.beta_fee * inRangeRatio;
    
  // Estimate IL proxy from config / DLMM concentration if not provided by fetcher
  // IL typically grows with square of price change and concentration factor
  const concentrationProxy = trade?.meta?.bin_step ? 1.0 / trade.meta.bin_step : cal.concentration_factor_base;
  const computedIlProxy = priceReturnPct * priceReturnPct * cal.gamma_il * concentrationProxy;
  
  const ilProxyPct = snapshot?.il_proxy_pct !== undefined
    ? Number(snapshot.il_proxy_pct)
    : computedIlProxy;
  
  const totalReturnPct = directionalReturnPct + feeReturnPct + ilProxyPct;
  const unrealizedPnlSol = allocatedSol * (totalReturnPct / 100);
  return {
    price_return_pct: roundPct(priceReturnPct),
    directional_return_pct: roundPct(directionalReturnPct),
    fee_return_pct: roundPct(feeReturnPct),
    il_proxy_pct: roundPct(ilProxyPct),
    total_return_pct: roundPct(totalReturnPct),
    unrealized_pnl_sol: roundSol(unrealizedPnlSol),
  };
}

export async function evaluatePaperTrades({
  filePath,
  now = Date.now(),
  horizonsMin = [5, 15, 60],
  primaryHorizonMin = 15,
  takeProfitPct = 3,
  stopLossPct = -3,
  autoCloseAtMaxHorizon = true,
  outOfRangeWaitMinutes = 30,
  outOfRangeBinsToClose = 10,
  minFeePerTvl24h = 7,
  minAgeBeforeYieldCheck = 60,
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
    const ageMinutes = Math.max(0, Math.floor((now - openedMs) / 60_000));

    // PASS 1: Operational close check (OOR, Yield, TP/SL on current estimate)
    let snapshot;
    try {
      snapshot = await priceFetcher(trade.pool_address, trade);
    } catch (error) {
      errors += 1;
      log("paper_eval_warn", `Price fetch failed for pool ${trade.pool_address}: ${error.message}`);
      continue;
    }

    // Update OOR state locally before estimate (needs to be saved during mark)
    if (trade.bin_range?.upper != null && snapshot?.active_bin != null) {
      if (snapshot.active_bin > trade.bin_range.upper) {
        if (!trade.oor_state?.out_of_range_since) {
          trade.oor_state = {
            out_of_range_since: new Date(now).toISOString(),
            minutes_out_of_range: 0,
          };
        } else {
          trade.oor_state.minutes_out_of_range = Math.max(0, Math.floor((now - Date.parse(trade.oor_state.out_of_range_since)) / 60_000));
        }
      } else {
        trade.oor_state = { out_of_range_since: null, minutes_out_of_range: 0 };
      }
    }

    // Evaluate instantaneous return
    let currentEstimate;
    try {
      currentEstimate = estimatePaperReturn({
        trade,
        currentPrice: snapshot?.price,
        snapshot,
        horizonMin: null,
        now,
      });
    } catch (error) {
      errors += 1;
      log("paper_eval_warn", `estimatePaperReturn failed for trade ${trade.id}: ${error.message}`);
      continue;
    }

    // Force an update to save local changes (OOR) + instantaneous mark return
    try {
      await markPaperTrade({
        filePath,
        tradeId: trade.id,
        price: snapshot?.price ?? null,
        activeBin: snapshot?.active_bin ?? null,
        returnPct: currentEstimate.total_return_pct,
        unrealizedPnlSol: currentEstimate.unrealized_pnl_sol,
        evaluation: null,
        oorState: trade.oor_state,
        now,
      });
      // Important to sync local object with actual saved OOR state
      const refreshedState = loadPaperState({ filePath });
      if (refreshedState.open_trades?.[trade.id]) {
         Object.assign(trade.oor_state || {}, refreshedState.open_trades[trade.id].oor_state);
      }
    } catch (error) {
      errors += 1;
      log("paper_eval_warn", `markPaperTrade failed for trade ${trade.id}: ${error.message}`);
      continue;
    }

    const markReturnPct = Number(currentEstimate.total_return_pct) || 0;
    let closeReason = null;

    if (markReturnPct <= stopLossPct) {
      closeReason = "stop_loss";
    } else if (markReturnPct >= takeProfitPct) {
      closeReason = "take_profit";
    } else if (trade.bin_range?.upper != null && snapshot?.active_bin != null && snapshot.active_bin > trade.bin_range.upper + outOfRangeBinsToClose) {
      closeReason = "pumped_far_above_range";
    } else if (trade.oor_state?.minutes_out_of_range >= outOfRangeWaitMinutes) {
      closeReason = "oor";
    } else if (snapshot?.fee_per_tvl_24h != null && snapshot.fee_per_tvl_24h < minFeePerTvl24h && ageMinutes >= minAgeBeforeYieldCheck) {
      closeReason = "low_yield";
    }

    if (closeReason) {
      appendComparisonLog({
        trade,
        event: "close",
        prediction: currentEstimate,
        snapshot,
        closeReason,
        now,
      });
      await closePaperTrade({
        filePath,
        tradeId: trade.id,
        closeReasonCode: closeReason,
        finalReturnPct: markReturnPct,
        closePrice: snapshot?.price ?? null,
        closeActiveBin: snapshot?.active_bin ?? null,
        now,
      });
      closed += 1;
      closedTradeIds.push(trade.id);
      continue; // Skip horizons if closed
    }

    // PASS 2: Horizon snapshots
    const dueHorizons = uniqueHorizons.filter((h) => ageMinutes >= h && !trade.evaluations?.[String(h)]);
    if (dueHorizons.length) {
      for (const horizonMin of dueHorizons) {
        let evaluation;
        let estimate;
        try {
          estimate = estimatePaperReturn({
            trade,
            currentPrice: snapshot?.price,
            snapshot,
            horizonMin,
            now,
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
            fee_return_pct: estimate.fee_return_pct,
            il_proxy_pct: estimate.il_proxy_pct,
            total_return_pct: estimate.total_return_pct,
          };
        } catch (error) {
          errors += 1;
          log("paper_eval_warn", `estimatePaperReturn horizon failed for trade ${trade.id} horizon ${horizonMin}: ${error.message}`);
          continue;
        }
        try {
          await markPaperTrade({
            filePath,
            tradeId: trade.id,
            price: snapshot?.price ?? null,
            activeBin: snapshot?.active_bin ?? null,
            returnPct: estimate.total_return_pct, // Latest tick return used
            unrealizedPnlSol: estimate.unrealized_pnl_sol, // Latest tick return used
            evaluation,
            oorState: trade.oor_state,
            now,
          });
          evaluated += 1;
        } catch (error) {
          errors += 1;
          log("paper_eval_warn", `markPaperTrade horizon failed for trade ${trade.id}: ${error.message}`);
          continue;
        }
      }
    }

    if (autoCloseAtMaxHorizon) {
      const refreshed = loadPaperState({ filePath }).open_trades?.[trade.id];
      if (refreshed && refreshed.evaluations?.[String(maxHorizon)]) {
        appendComparisonLog({
          trade,
          event: "close",
          prediction: refreshed.evaluations[String(maxHorizon)],
          snapshot,
          closeReason: "max_horizon_reached",
          now,
        });
        await closePaperTrade({
          filePath,
          tradeId: trade.id,
          closeReasonCode: "max_horizon_reached",
          finalReturnPct: refreshed.evaluations[String(maxHorizon)].total_return_pct,
          closePrice: snapshot?.price ?? null,
          closeActiveBin: snapshot?.active_bin ?? null,
          now,
        });
        closed += 1;
        closedTradeIds.push(trade.id);
      }
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
