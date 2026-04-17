import { loadPaperState, reconcilePaperState, resetPaperState, savePaperState, withPaperStateTransaction } from "./paper-state.js";
import { recordPerformance } from "./lessons.js";
import { log } from "./logger.js";

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function roundSol(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

function normalizeKey(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.toLowerCase() : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function recordPaperClosePerformance(closedTrade) {
  if (!closedTrade) return;

  const solPriceUsd = Number(closedTrade.meta?.sol_price) || 20;
  const amountSol = Number(closedTrade.allocated_sol) || 0;
  const returnPct = Number(closedTrade.final_return_pct) || 0;
  const initialValueUsd = roundSol(amountSol * solPriceUsd);
  const finalValueUsd = roundSol(initialValueUsd * (1 + returnPct / 100));
  const feesEarnedUsd = roundSol((Number(closedTrade.meta?.fees_earned_sol) || 0) * solPriceUsd);

  try {
    await recordPerformance({
      position: closedTrade.id,
      pool: closedTrade.pool_address,
      pool_name: closedTrade.pool_name,
      base_mint: closedTrade.base_mint,
      strategy: closedTrade.strategy ?? "spot",
      bin_range: closedTrade.bin_range,
      bin_step: closedTrade.meta?.bin_step ?? null,
      volatility: closedTrade.meta?.volatility ?? null,
      fee_tvl_ratio: closedTrade.meta?.fee_tvl_ratio ?? null,
      organic_score: closedTrade.meta?.organic_score ?? null,
      amount_sol: amountSol,
      fees_earned_usd: feesEarnedUsd,
      final_value_usd: finalValueUsd,
      initial_value_usd: initialValueUsd,
      minutes_in_range: closedTrade.meta?.minutes_in_range ?? 0,
      minutes_held: closedTrade.meta?.minutes_held ?? 0,
      close_reason: closedTrade.close_reason_code ?? "paper_close",
      deployed_at: closedTrade.opened_at ?? null,
      paper_trade: true,
    });
  } catch (error) {
    log("paper_eval_warn", `recordPerformance failed for paper trade ${closedTrade.id}: ${error.message}`);
  }
}

export function getTradeKeys({ poolAddress = null, baseMint = null, quoteMint = null } = {}) {
  const pool_key = normalizeKey(poolAddress);
  const token_key = normalizeKey(baseMint);
  const pair_key = token_key && quoteMint ? `${token_key}:${normalizeKey(quoteMint)}` : null;
  return { pool_key, token_key, pair_key };
}

function getOpenTrades(state) {
  return Object.values(state.open_trades || {});
}

function getClosedTrades(state) {
  return Object.values(state.closed_trades || {});
}

export function preflightPaperDeploy({
  filePath,
  amountSol,
  poolAddress,
  baseMint = null,
  quoteMint = null,
  reserveGasBufferSol = 0,
  maxOpenTrades = Number.POSITIVE_INFINITY,
} = {}) {
  const state = loadPaperState({ filePath });
  const amount = roundSol(amountSol);
  const required = roundSol(amount + (Number(reserveGasBufferSol) || 0));
  const { pool_key, token_key, pair_key } = getTradeKeys({ poolAddress, baseMint, quoteMint });
  const openTrades = getOpenTrades(state);
  const conflicts = [];

  if (!(amount > 0)) {
    return {
      ok: false,
      reason_code: "invalid_amount",
      reason: "Paper deploy requires a positive SOL amount.",
      available_free_sol: state.wallet.free_balance_sol,
      required_free_sol: required,
      conflicts,
    };
  }

  if (openTrades.length >= maxOpenTrades) {
    return {
      ok: false,
      reason_code: "max_open_trades_reached",
      reason: `Paper max open trades reached (${maxOpenTrades}).`,
      available_free_sol: state.wallet.free_balance_sol,
      required_free_sol: required,
      conflicts,
    };
  }

  for (const trade of openTrades) {
    if (pool_key && trade.pool_key === pool_key) {
      conflicts.push({ type: "pool", trade_id: trade.id, key: pool_key });
    }
    if (token_key && trade.token_key === token_key) {
      conflicts.push({ type: "token", trade_id: trade.id, key: token_key });
    }
    if (pair_key && trade.pair_key === pair_key) {
      conflicts.push({ type: "pair", trade_id: trade.id, key: pair_key });
    }
  }

  if (conflicts.some((c) => c.type === "pool")) {
    return {
      ok: false,
      reason_code: "duplicate_pool_exposure",
      reason: "Paper trade already open for this pool.",
      available_free_sol: state.wallet.free_balance_sol,
      required_free_sol: required,
      conflicts,
    };
  }

  if (token_key && conflicts.some((c) => c.type === "token")) {
    return {
      ok: false,
      reason_code: "duplicate_token_exposure",
      reason: "Paper trade already open for this token.",
      available_free_sol: state.wallet.free_balance_sol,
      required_free_sol: required,
      conflicts,
    };
  }

  if (state.wallet.free_balance_sol < required) {
    return {
      ok: false,
      reason_code: "insufficient_free_balance",
      reason: `Insufficient paper balance: have ${state.wallet.free_balance_sol} SOL, need ${required} SOL.`,
      available_free_sol: state.wallet.free_balance_sol,
      required_free_sol: required,
      conflicts,
    };
  }

  return {
    ok: true,
    reason_code: null,
    reason: null,
    available_free_sol: state.wallet.free_balance_sol,
    required_free_sol: required,
    conflicts,
  };
}

function makeEvent({ now = Date.now(), type, tradeId = null, payload = {} }) {
  return {
    id: `evt_${now}_${Math.random().toString(36).slice(2, 8)}`,
    ts: nowIso(now),
    type,
    trade_id: tradeId,
    payload,
  };
}

function makeTradeId(now = Date.now()) {
  return `paper_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function openPaperTrade({
  filePath,
  amountSol,
  poolAddress,
  poolName = null,
  baseMint = null,
  quoteMint = null,
  strategy = "spot",
  reserveGasBufferSol = 0,
  maxOpenTrades = Number.POSITIVE_INFINITY,
  entryPrice = null,
  entryPriceSource = "provided",
  entrySnapshot = null,
  meta = {},
  now = Date.now(),
} = {}) {
  const requestEvent = makeEvent({
    now,
    type: "deploy_requested",
    payload: { poolAddress, baseMint, amountSol: roundSol(amountSol), strategy },
  });

  const preflight = preflightPaperDeploy({
    filePath,
    amountSol,
    poolAddress,
    baseMint,
    quoteMint,
    reserveGasBufferSol,
    maxOpenTrades,
  });

  if (!preflight.ok) {
    await withPaperStateTransaction({ filePath, now }, (state) => {
      state.events.push(requestEvent);
      state.events.push(makeEvent({
        now,
        type: "deploy_rejected",
        payload: {
          reason_code: preflight.reason_code,
          reason: preflight.reason,
          poolAddress,
          baseMint,
          amountSol: roundSol(amountSol),
          conflicts: preflight.conflicts,
        },
      }));
    });
    return { ok: false, ...preflight };
  }

  const tradeId = makeTradeId(now);
  const keys = getTradeKeys({ poolAddress, baseMint, quoteMint });
  const trade = {
    id: tradeId,
    status: "open",
    opened_at: nowIso(now),
    source: "dry_run_deploy",
    pool_address: poolAddress || null,
    pool_name: poolName,
    base_mint: baseMint,
    quote_mint: quoteMint,
    ...keys,
    strategy,
    allocated_sol: roundSol(amountSol),
    entry: {
      price: entryPrice,
      price_source: entryPriceSource,
      snapshot: entrySnapshot,
    },
    bin_range: {
      lower_bin: entrySnapshot?.active_bin != null && meta?.bins_below != null
        ? entrySnapshot.active_bin - Number(meta.bins_below)
        : null,
      upper_bin: entrySnapshot?.active_bin != null
        ? entrySnapshot.active_bin + Number(meta?.bins_above || 0)
        : null,
      active_bin_at_entry: entrySnapshot?.active_bin ?? null,
      bin_step: entrySnapshot?.bin_step ?? meta?.bin_step ?? null,
    },
    oor_minutes: 0,
    last_oor_at: null,
    latest_mark: {
      marked_at: nowIso(now),
      price: entryPrice,
      active_bin: entrySnapshot?.active_bin ?? null,
      return_pct: 0,
      unrealized_pnl_sol: 0,
    },
    evaluations: {},
    meta: clone(meta || {}),
  };

  await withPaperStateTransaction({ filePath, now }, (state) => {
    state.events.push(requestEvent);
    state.open_trades[tradeId] = trade;
    state.wallet.free_balance_sol = roundSol(state.wallet.free_balance_sol - trade.allocated_sol);
    state.events.push(makeEvent({
      now,
      type: "trade_opened",
      tradeId,
      payload: {
        poolAddress,
        baseMint,
        allocated_sol: trade.allocated_sol,
      },
    }));
  });

  const reconciled = reconcilePaperState({ filePath, now });
  return { ok: true, trade: reconciled.state.open_trades[tradeId], wallet: reconciled.state.wallet };
}

export async function markPaperTrade({
  filePath,
  tradeId,
  price = null,
  activeBin = null,
  returnPct = 0,
  unrealizedPnlSol = 0,
  evaluation = null,
  inRange = true,
  now = Date.now(),
} = {}) {
  let markedTrade = null;
  await withPaperStateTransaction({ filePath, now }, (state) => {
    const trade = state.open_trades?.[tradeId];
    if (!trade) throw new Error(`Paper trade not found: ${tradeId}`);
    trade.latest_mark = {
      marked_at: nowIso(now),
      price,
      active_bin: activeBin,
      return_pct: Number(returnPct) || 0,
      unrealized_pnl_sol: roundSol(unrealizedPnlSol),
      in_range: inRange,
    };
    // Track cumulative OOR minutes
    if (!inRange) {
      const lastMarkTime = trade.latest_mark_at ? Date.parse(trade.latest_mark_at) : (Date.parse(trade.opened_at) || now);
      const elapsedMin = Math.max(1, Math.round((now - lastMarkTime) / 60_000));
      trade.oor_minutes = (trade.oor_minutes || 0) + elapsedMin;
      trade.last_oor_at = nowIso(now);
    }
    trade.latest_mark_at = nowIso(now);
    if (evaluation?.horizon_min != null) {
      trade.evaluations ||= {};
      trade.evaluations[String(evaluation.horizon_min)] = clone(evaluation);
    }
    state.events.push(makeEvent({
      now,
      type: "trade_marked",
      tradeId,
      payload: {
        return_pct: trade.latest_mark.return_pct,
        unrealized_pnl_sol: trade.latest_mark.unrealized_pnl_sol,
        in_range: inRange,
        oor_minutes: trade.oor_minutes || 0,
      },
    }));
    markedTrade = clone(trade);
  });
  const reconciled = reconcilePaperState({ filePath, now });
  return { ok: true, trade: reconciled.state.open_trades[tradeId] || markedTrade, wallet: reconciled.state.wallet };
}

export async function closePaperTrade({
  filePath,
  tradeId,
  closeReasonCode,
  closeReasonDetail = null,
  finalReturnPct = null,
  closePrice = null,
  closeActiveBin = null,
  now = Date.now(),
} = {}) {
  let closedTrade = null;
  await withPaperStateTransaction({ filePath, now }, (state) => {
    const trade = state.open_trades?.[tradeId];
    if (!trade) throw new Error(`Paper trade not found: ${tradeId}`);
    const effectiveReturnPct = Number.isFinite(Number(finalReturnPct))
      ? Number(finalReturnPct)
      : Number(trade.latest_mark?.return_pct) || 0;
    const effectiveClosePrice = closePrice ?? trade.latest_mark?.price ?? null;
    const effectiveCloseActiveBin = closeActiveBin ?? trade.latest_mark?.active_bin ?? null;
    const realizedPnlSol = roundSol((Number(trade.allocated_sol) || 0) * (effectiveReturnPct / 100));
    trade.latest_mark = {
      marked_at: nowIso(now),
      price: effectiveClosePrice,
      active_bin: effectiveCloseActiveBin,
      return_pct: effectiveReturnPct,
      unrealized_pnl_sol: realizedPnlSol,
    };
    delete state.open_trades[tradeId];
    closedTrade = {
      ...trade,
      status: "closed",
      closed_at: nowIso(now),
      close_reason_code: closeReasonCode,
      close_reason_detail: closeReasonDetail,
      close: {
        price: effectiveClosePrice,
        active_bin: effectiveCloseActiveBin,
        return_pct: effectiveReturnPct,
        realized_pnl_sol: realizedPnlSol,
      },
      realized_pnl_sol: realizedPnlSol,
      final_return_pct: effectiveReturnPct,
      outcome: effectiveReturnPct > 0 ? "win" : (effectiveReturnPct < 0 ? "loss" : "flat"),
    };
    state.closed_trades[tradeId] = closedTrade;
    state.wallet.free_balance_sol = roundSol(state.wallet.free_balance_sol + (Number(trade.allocated_sol) || 0) + realizedPnlSol);
    state.events.push(makeEvent({
      now,
      type: "trade_closed",
      tradeId,
      payload: {
        close_reason_code: closeReasonCode,
        final_return_pct: closedTrade.final_return_pct,
        realized_pnl_sol: realizedPnlSol,
      },
    }));
  });
  const reconciled = reconcilePaperState({ filePath, now });
  if (closedTrade) {
    await recordPaperClosePerformance(closedTrade);
  }
  return { ok: true, closedTrade, wallet: reconciled.state.wallet };
}

export function getPaperStatus({ filePath } = {}) {
  const state = loadPaperState({ filePath });
  return {
    wallet: clone(state.wallet),
    open_trade_count: Object.keys(state.open_trades || {}).length,
    closed_trade_count: Object.keys(state.closed_trades || {}).length,
    open_trades: getOpenTrades(state),
    closed_trades: getClosedTrades(state),
    reconciliation: clone(state.reconciliation),
  };
}

export function getPaperWalletSummary({ filePath } = {}) {
  return getPaperStatus({ filePath }).wallet;
}

export function getPaperLedger({ filePath, limit = 50 } = {}) {
  const state = loadPaperState({ filePath });
  const count = Math.max(0, Number(limit) || 0) || 50;
  return { events: state.events.slice(-count).reverse() };
}

export function getPaperRejectSummary({ filePath } = {}) {
  const state = loadPaperState({ filePath });
  const summary = {};
  for (const event of state.events || []) {
    if (event.type !== "deploy_rejected") continue;
    const code = event.payload?.reason_code || "unknown";
    summary[code] = (summary[code] || 0) + 1;
  }
  return { by_reason_code: summary };
}

export function getPaperTradeById({ filePath, tradeId } = {}) {
  const state = loadPaperState({ filePath });
  return {
    trade: state.open_trades?.[tradeId] || state.closed_trades?.[tradeId] || null,
  };
}

export function initPaperState({ filePath, startingBalanceSol = 0, now = Date.now() } = {}) {
  return resetPaperState({ filePath, startingBalanceSol, now });
}

export async function depositPaperCapital({ filePath, amountSol, now = Date.now() } = {}) {
  const amount = roundSol(amountSol);
  if (!(amount > 0)) throw new Error("Deposit amount must be positive.");
  await withPaperStateTransaction({ filePath, now }, (state) => {
    state.wallet.starting_balance_sol = roundSol(state.wallet.starting_balance_sol + amount);
    state.wallet.free_balance_sol = roundSol(state.wallet.free_balance_sol + amount);
    state.events.push(makeEvent({ now, type: "capital_deposited", payload: { amount_sol: amount } }));
  });
  return reconcilePaperState({ filePath, now }).state;
}

export async function withdrawPaperCapital({ filePath, amountSol, now = Date.now() } = {}) {
  const amount = roundSol(amountSol);
  if (!(amount > 0)) throw new Error("Withdraw amount must be positive.");
  const state = loadPaperState({ filePath });
  if (state.wallet.free_balance_sol < amount) {
    throw new Error(`Insufficient free paper balance: have ${state.wallet.free_balance_sol} SOL, need ${amount} SOL.`);
  }
  await withPaperStateTransaction({ filePath, now }, (next) => {
    next.wallet.starting_balance_sol = roundSol(next.wallet.starting_balance_sol - amount);
    next.wallet.free_balance_sol = roundSol(next.wallet.free_balance_sol - amount);
    next.events.push(makeEvent({ now, type: "capital_withdrawn", payload: { amount_sol: amount } }));
  });
  return reconcilePaperState({ filePath, now }).state;
}

export function purgePaperState({ filePath, now = Date.now() } = {}) {
  return resetPaperState({ filePath, startingBalanceSol: 0, now });
}

export function getPaperPositions({ filePath } = {}) {
  const state = loadPaperState({ filePath });
  const positions = getOpenTrades(state).map((trade) => {
    const activeBin = trade.latest_mark?.active_bin ?? null;
    const lowerBin = trade.bin_range?.lower_bin ?? null;
    const upperBin = trade.bin_range?.upper_bin ?? null;
    const isInRange = activeBin != null && lowerBin != null && upperBin != null
      ? activeBin >= lowerBin && activeBin <= upperBin
      : (trade.latest_mark?.in_range ?? true);
    return {
      position: trade.id,
      pool: trade.pool_address,
      pair: trade.pool_name || trade.pool_address || "paper trade",
      base_mint: trade.base_mint,
      lower_bin: lowerBin,
      upper_bin: upperBin,
      active_bin: activeBin,
      in_range: isInRange,
      unclaimed_fees_usd: null,
      total_value_usd: roundSol((Number(trade.allocated_sol) || 0) + (Number(trade.latest_mark?.unrealized_pnl_sol) || 0)),
      total_value_true_usd: null,
      collected_fees_usd: null,
      collected_fees_true_usd: null,
      pnl_usd: roundSol(Number(trade.latest_mark?.unrealized_pnl_sol) || 0),
      pnl_true_usd: null,
      pnl_pct: Number(trade.latest_mark?.return_pct) || 0,
      pnl_pct_derived: Number(trade.latest_mark?.return_pct) || 0,
      pnl_pct_diff: 0,
      pnl_pct_suspicious: false,
      unclaimed_fees_true_usd: null,
      fee_per_tvl_24h: null,
      age_minutes: Math.max(0, Math.floor((Date.now() - Date.parse(trade.opened_at)) / 60000)),
      minutes_out_of_range: trade.oor_minutes || 0,
      instruction: null,
      paper_trade: true,
      allocated_sol: trade.allocated_sol,
    };
  });
  return {
    wallet: null,
    total_positions: positions.length,
    positions,
    paper: true,
  };
}
