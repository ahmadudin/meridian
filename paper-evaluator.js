import { closePaperTrade, markPaperTrade } from "./paper-engine.js";
import { loadPaperState } from "./paper-state.js";

function roundPct(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundSol(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

export function estimatePaperReturn({ trade, currentPrice, snapshot = {}, horizonMin = null } = {}) {
  const entryPrice = Number(trade?.entry?.price);
  const nextPrice = Number(currentPrice);
  const allocatedSol = Number(trade?.allocated_sol) || 0;
  const priceReturnPct = entryPrice > 0 && Number.isFinite(nextPrice)
    ? ((nextPrice - entryPrice) / entryPrice) * 100
    : 0;
  const directionalReturnPct = priceReturnPct * 0.35;
  const feeReturnPct = Number(snapshot?.fee_return_pct)
    || Math.max(0, Number(snapshot?.fee_active_tvl_ratio || 0)) * Math.max(1, Number(horizonMin || 0) / 60) * 0.25;
  const ilProxyPct = Number(snapshot?.il_proxy_pct) || 0;
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
      continue;
    }

    for (const horizonMin of dueHorizons) {
      const estimate = estimatePaperReturn({
        trade,
        currentPrice: snapshot?.price,
        snapshot,
        horizonMin,
      });
      const evaluation = {
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
      await markPaperTrade({
        filePath,
        tradeId: trade.id,
        price: snapshot?.price ?? null,
        activeBin: snapshot?.active_bin ?? null,
        returnPct: estimate.total_return_pct,
        unrealizedPnlSol: estimate.unrealized_pnl_sol,
        evaluation,
        now,
      });
      evaluated += 1;
    }

    const refreshed = loadPaperState({ filePath }).open_trades?.[trade.id];
    if (!refreshed) continue;
    const primaryEval = refreshed.evaluations?.[String(primaryHorizonMin)] || null;
    const maxEval = refreshed.evaluations?.[String(maxHorizon)] || null;

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
