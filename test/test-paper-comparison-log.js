import assert from "assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { appendComparisonLog, readComparisonLog } from "../paper-comparison-log.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paper-comp-"));
}

async function runTests() {
  console.log("=== Running Paper Comparison Log Tests ===");
  const dir = makeTempDir();
  const filePath = path.join(dir, "paper-comparison.jsonl");

  const trade = {
    id: "trade_1",
    pool_address: "PoolA",
    opened_at: new Date(Date.now() - 60000 * 42).toISOString(),
    entry: { price: 10 },
  };

  const prediction = {
    total_return_pct: 1.78,
    directional_return_pct: 0.62,
    fee_return_pct: 0.28,
    il_proxy_pct: -0.12,
  };

  const snapshot = {
    price: 10.5,
    active_bin: 55,
    pool_tvl: 45000,
    fee_active_tvl_ratio: 0.08,
    volatility: 2.1,
  };

  const ok = appendComparisonLog({
    filePath,
    trade,
    event: "close",
    prediction,
    snapshot,
    closeReason: "take_profit",
  });

  assert.equal(ok, true, "append should succeed");

  const read = readComparisonLog({ filePath, limit: 10 });
  assert.equal(read.length, 1, "should read 1 record");
  assert.equal(read[0].trade_id, "trade_1");
  assert.equal(read[0].paper_prediction.total_return_pct, 1.78);
  assert.equal(read[0].paper_prediction.duration_min, 42);
  assert.equal(read[0].market_actual.price_at_entry, 10);
  assert.equal(read[0].market_actual.price_return_pct, 5); // (10.5 - 10) / 10 * 100

  // append another
  appendComparisonLog({
    filePath,
    trade: { id: "trade_2", entry: { price: 20 } },
    event: "close",
    prediction: {},
    snapshot: {},
    closeReason: "oor",
  });

  const read2 = readComparisonLog({ filePath, limit: 1 });
  assert.equal(read2.length, 1, "Should respect limit and get newest");
  assert.equal(read2[0].trade_id, "trade_2", "Newest should be trade_2");

  console.log("✅ Comparison log tests passed");
  process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
