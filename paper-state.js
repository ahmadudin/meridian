import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PAPER_STATE_FILE = process.env.PAPER_STATE_FILE || path.join(__dirname, "paper-state.json");

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function roundSol(value) {
  return Math.round((Number(value) || 0) * 1e8) / 1e8;
}

export const DEFAULT_PAPER_STATE = Object.freeze({
  version: 2,
  metadata: {
    created_at: null,
    updated_at: null,
  },
  wallet: {
    starting_balance_sol: 0,
    free_balance_sol: 0,
    reserved_balance_sol: 0,
    realized_pnl_sol: 0,
    unrealized_pnl_sol: 0,
    equity_sol: 0,
  },
  open_trades: {},
  closed_trades: {},
  events: [],
  reconciliation: {
    last_run_at: null,
    last_status: null,
    last_error: null,
  },
});

function buildInitialState({ startingBalanceSol = 0, now = Date.now() } = {}) {
  const ts = nowIso(now);
  return {
    version: 2,
    metadata: {
      created_at: ts,
      updated_at: ts,
    },
    wallet: {
      starting_balance_sol: roundSol(startingBalanceSol),
      free_balance_sol: roundSol(startingBalanceSol),
      reserved_balance_sol: 0,
      realized_pnl_sol: 0,
      unrealized_pnl_sol: 0,
      equity_sol: roundSol(startingBalanceSol),
    },
    open_trades: {},
    closed_trades: {},
    events: [
      {
        id: `evt_${now}_wallet_initialized`,
        ts,
        type: "wallet_initialized",
        trade_id: null,
        payload: { starting_balance_sol: roundSol(startingBalanceSol) },
      },
    ],
    reconciliation: {
      last_run_at: ts,
      last_status: "ok",
      last_error: null,
    },
  };
}

export function initializePaperState({ filePath = DEFAULT_PAPER_STATE_FILE, startingBalanceSol = 0, now = Date.now() } = {}) {
  const state = buildInitialState({ startingBalanceSol, now });
  savePaperState(state, { filePath });
  return state;
}

export function resetPaperState({ filePath = DEFAULT_PAPER_STATE_FILE, startingBalanceSol = 0, now = Date.now() } = {}) {
  const state = buildInitialState({ startingBalanceSol, now });
  state.events.push({
    id: `evt_${now}_wallet_reset`,
    ts: nowIso(now),
    type: "wallet_reset",
    trade_id: null,
    payload: { starting_balance_sol: roundSol(startingBalanceSol) },
  });
  savePaperState(state, { filePath });
  return state;
}

export function loadPaperState({ filePath = DEFAULT_PAPER_STATE_FILE } = {}) {
  if (!fs.existsSync(filePath)) {
    return clone(DEFAULT_PAPER_STATE);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    version: raw.version ?? 2,
    metadata: {
      created_at: raw.metadata?.created_at ?? null,
      updated_at: raw.metadata?.updated_at ?? null,
    },
    wallet: {
      starting_balance_sol: roundSol(raw.wallet?.starting_balance_sol),
      free_balance_sol: roundSol(raw.wallet?.free_balance_sol),
      reserved_balance_sol: roundSol(raw.wallet?.reserved_balance_sol),
      realized_pnl_sol: roundSol(raw.wallet?.realized_pnl_sol),
      unrealized_pnl_sol: roundSol(raw.wallet?.unrealized_pnl_sol),
      equity_sol: roundSol(raw.wallet?.equity_sol),
    },
    open_trades: raw.open_trades && typeof raw.open_trades === "object" ? raw.open_trades : {},
    closed_trades: raw.closed_trades && typeof raw.closed_trades === "object" ? raw.closed_trades : {},
    events: Array.isArray(raw.events) ? raw.events : [],
    reconciliation: {
      last_run_at: raw.reconciliation?.last_run_at ?? null,
      last_status: raw.reconciliation?.last_status ?? null,
      last_error: raw.reconciliation?.last_error ?? null,
    },
  };
}

export function savePaperState(state, { filePath = DEFAULT_PAPER_STATE_FILE, now = Date.now() } = {}) {
  const next = clone(state);
  next.metadata ||= {};
  next.metadata.updated_at = nowIso(now);
  next.metadata.created_at ||= next.metadata.updated_at;
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

export async function withPaperStateTransaction({ filePath = DEFAULT_PAPER_STATE_FILE, now = Date.now() } = {}, fn) {
  const state = loadPaperState({ filePath });
  const working = clone(state);
  const result = await fn(working);
  savePaperState(working, { filePath, now });
  return { state: working, result };
}

function computeWalletProjection(state) {
  const openTrades = Object.values(state.open_trades || {});
  const closedTrades = Object.values(state.closed_trades || {});
  const reserved = roundSol(openTrades.reduce((sum, trade) => sum + (Number(trade.allocated_sol) || 0), 0));
  const realized = roundSol(closedTrades.reduce((sum, trade) => sum + (Number(trade.realized_pnl_sol) || 0), 0));
  const unrealized = roundSol(openTrades.reduce((sum, trade) => sum + (Number(trade.latest_mark?.unrealized_pnl_sol) || 0), 0));
  const free = roundSol((Number(state.wallet?.starting_balance_sol) || 0) + realized - reserved);
  const equity = roundSol(free + reserved + unrealized);
  return { reserved, realized, unrealized, free, equity };
}

export function reconcilePaperState({ filePath = DEFAULT_PAPER_STATE_FILE, now = Date.now() } = {}) {
  const state = loadPaperState({ filePath });
  const projection = computeWalletProjection(state);
  state.wallet.starting_balance_sol = roundSol(state.wallet.starting_balance_sol);
  state.wallet.free_balance_sol = projection.free;
  state.wallet.reserved_balance_sol = projection.reserved;
  state.wallet.realized_pnl_sol = projection.realized;
  state.wallet.unrealized_pnl_sol = projection.unrealized;
  state.wallet.equity_sol = projection.equity;

  const invariants = {
    reserved_matches: state.wallet.reserved_balance_sol === projection.reserved,
    realized_matches: state.wallet.realized_pnl_sol === projection.realized,
    unrealized_matches: state.wallet.unrealized_pnl_sol === projection.unrealized,
    equity_matches: state.wallet.equity_sol === projection.equity,
  };

  state.reconciliation = {
    last_run_at: nowIso(now),
    last_status: "ok",
    last_error: null,
  };
  state.events.push({
    id: `evt_${now}_reconciliation_run`,
    ts: nowIso(now),
    type: "reconciliation_run",
    trade_id: null,
    payload: { invariants },
  });
  savePaperState(state, { filePath, now });
  return { ok: true, state, invariants };
}
