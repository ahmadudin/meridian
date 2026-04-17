import fs from "fs";
import path from "path";
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COMPARISON_LOG_FILE = path.join(__dirname, "data", "paper-comparison.jsonl");

export function appendComparisonLog({
  filePath = DEFAULT_COMPARISON_LOG_FILE,
  trade,
  event = "close",
  prediction = {},
  snapshot = {},
  closeReason = null,
  now = Date.now(),
} = {}) {
  try {
    ensureDir(filePath);

    const priceAtEntry = Number(trade?.entry?.price) || null;
    const priceAtClose = Number(snapshot?.price) || null;
    const priceReturnPct = priceAtEntry > 0 && priceAtClose > 0 ? ((priceAtClose - priceAtEntry) / priceAtEntry) * 100 : 0;
    const durationMin = Math.max(0, Math.floor((now - (Date.parse(trade?.opened_at) || now)) / 60_000));

    const record = {
      trade_id: trade?.id,
      pool_address: trade?.pool_address,
      event,
      timestamp: nowIso(now),
      paper_prediction: {
        total_return_pct: prediction.total_return_pct ?? trade?.latest_mark?.return_pct ?? null,
        directional_return_pct: prediction.directional_return_pct ?? null,
        fee_return_pct: prediction.fee_return_pct ?? null,
        il_proxy_pct: prediction.il_proxy_pct ?? null,
        price_at_close: priceAtClose,
        duration_min: durationMin,
        close_reason: closeReason,
      },
      market_actual: {
        price_at_entry: priceAtEntry,
        price_at_close: priceAtClose,
        price_return_pct: priceReturnPct,
        fee_active_tvl_at_close: snapshot?.fee_active_tvl_ratio ?? null,
        fee_per_tvl_24h_at_close: snapshot?.fee_per_tvl_24h ?? null,
        volatility_at_close: snapshot?.volatility ?? null,
        active_bin: snapshot?.active_bin ?? null,
        pool_tvl: snapshot?.pool_tvl ?? null,
      },
    };

    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
    return true;
  } catch (error) {
    console.error(`Failed to append to comparison log: ${error.message}`);
    return false;
  }
}

export function readComparisonLog({ filePath = DEFAULT_COMPARISON_LOG_FILE, limit = 100 } = {}) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    const records = [];
    // Read from end to get recent first
    for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        records.push(JSON.parse(lines[i]));
      } catch (e) {
        // skip bad lines
      }
    }
    return records;
  } catch (e) {
    return [];
  }
}
