import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadPaperState } from "../paper-state.js";
import { openPaperTrade, initPaperState } from "../paper-engine.js";
import { evaluatePaperTrades } from "../paper-evaluator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testFilePath = path.join(__dirname, ".test-paper-evaluator-close-rules.json");

const TEST_NOW = Date.parse("2026-04-18T12:00:00.000Z");

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`[FAIL] ${msg}: expected ${expected}, got ${actual}`);
  }
}

async function runTests() {
  console.log("=== Running Paper Evaluator Close Rules Tests ===");
  if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);

  initPaperState({ filePath: testFilePath, startingBalanceSol: 10, now: TEST_NOW });

  // 1. Open a trade at T=0
  const openRes = await openPaperTrade({
    filePath: testFilePath,
    amountSol: 1,
    poolAddress: "PoolA",
    poolName: "Pool A",
    entryPrice: 10,
    entrySnapshot: { active_bin: 100 },
    lowerBin: 90,
    upperBin: 110,
    now: TEST_NOW,
  });
  
  if (!openRes.ok) throw new Error("Failed to open trade");
  const tradeId = openRes.trade.id;

  // Initial state check
  const state0 = loadPaperState({ filePath: testFilePath });
  assertEqual(Object.keys(state0.open_trades).length, 1, "Should have 1 open trade");

  // Helper to evaluate at an offset with mocked price data
  const evalAt = async (minutesElapsed, mockSnapshot) => {
    return await evaluatePaperTrades({
      filePath: testFilePath,
      now: TEST_NOW + (minutesElapsed * 60_000),
      horizonsMin: [5, 15, 60],
      takeProfitPct: 3,
      stopLossPct: -3,
      outOfRangeWaitMinutes: 10,
      outOfRangeBinsToClose: 20,
      minFeePerTvl24h: 5,
      minAgeBeforeYieldCheck: 30,
      priceFetcher: async () => mockSnapshot,
    });
  };

  try {
    // 2. Test Instant Take Profit between horizons (e.g. at min 2, no horizon due)
    await evalAt(2, {
      price: 15, // 50% pump
      active_bin: 105,
      fee_active_tvl_ratio: 0.1,
      fee_per_tvl_24h: 10, // Good yield
      il_proxy_pct: 0, // Disable automatic IL computation for this test to hit TP threshold
    });

    const state1 = loadPaperState({ filePath: testFilePath });
    assertEqual(Object.keys(state1.open_trades).length, 0, "Trade should be closed");
    const closedTrade = Object.values(state1.closed_trades).find(t => t.id === tradeId);
    assertEqual(closedTrade.close_reason_code, "take_profit", "Reason should be take_profit");

    console.log("✅ TP between horizons passed");

    // 3. Test Far OOR Close 
    initPaperState({ filePath: testFilePath, startingBalanceSol: 10, now: TEST_NOW });
    await openPaperTrade({
      filePath: testFilePath, amountSol: 1, poolAddress: "PoolB", entryPrice: 10, 
      entrySnapshot: { active_bin: 100 }, lowerBin: 90, upperBin: 110, now: TEST_NOW,
    });

    // Min 1: active bin jumps to 135 (upper + 25)
    await evalAt(1, { price: 10, active_bin: 135, fee_active_tvl_ratio: 0, fee_per_tvl_24h: 10 });
    const state2 = loadPaperState({ filePath: testFilePath });
    assertEqual(Object.keys(state2.open_trades).length, 0, "Trade should be closed instantly due to far OOR");
    assertEqual(Object.values(state2.closed_trades)[0].close_reason_code, "pumped_far_above_range", "Reason should be pumped_far_above_range");
    
    console.log("✅ Far OOR instant close passed");

    // 4. Test OOR wait minutes
    initPaperState({ filePath: testFilePath, startingBalanceSol: 10, now: TEST_NOW });
    const openResC = await openPaperTrade({
      filePath: testFilePath, amountSol: 1, poolAddress: "PoolC", entryPrice: 10, 
      entrySnapshot: { active_bin: 100 }, lowerBin: 90, upperBin: 110, now: TEST_NOW,
    });
    const tradeIdC = openResC.trade.id;

    // Min 5: out of range (115), but not far enough to instant close (110 + 20 = 130). OOR timer starts.
    await evalAt(5, { price: 10, active_bin: 115, fee_active_tvl_ratio: 0, fee_per_tvl_24h: 10 });
    let state3 = loadPaperState({ filePath: testFilePath });
    assertEqual(Object.keys(state3.open_trades).length, 1, "Trade should still be open immediately after going OOR");
    assertEqual(state3.open_trades[tradeIdC].oor_state.out_of_range_since != null, true, "OOR timer should be set");
    assertEqual(state3.open_trades[tradeIdC].oor_state.minutes_out_of_range, 0, "OOR minutes should be 0");

    // Min 12: 7 minutes OOR. Still under limit of 10.
    await evalAt(12, { price: 10, active_bin: 115, fee_active_tvl_ratio: 0, fee_per_tvl_24h: 10 });
    state3 = loadPaperState({ filePath: testFilePath });
    assertEqual(Object.keys(state3.open_trades).length, 1, "Trade should still be open at 7m OOR");
    assertEqual(state3.open_trades[tradeIdC].oor_state.minutes_out_of_range, 7, "OOR minutes should be 7");

    // Min 16: 11 minutes OOR. Over limit of 10.
    await evalAt(16, { price: 10, active_bin: 115, fee_active_tvl_ratio: 0, fee_per_tvl_24h: 10 });
    state3 = loadPaperState({ filePath: testFilePath });
    assertEqual(Object.keys(state3.open_trades).length, 0, "Trade should be closed at 11m OOR");
    assertEqual(Object.values(state3.closed_trades)[0].close_reason_code, "oor", "Reason should be oor");

    console.log("✅ OOR timer close passed");

    // 5. Test Low Yield close
    initPaperState({ filePath: testFilePath, startingBalanceSol: 10, now: TEST_NOW });
    await openPaperTrade({
      filePath: testFilePath, amountSol: 1, poolAddress: "PoolD", entryPrice: 10, 
      entrySnapshot: { active_bin: 100 }, lowerBin: 90, upperBin: 110, now: TEST_NOW,
    });

    // Min 20: low yield, but age is 20 < 30. Should stay open.
    await evalAt(20, { price: 10, active_bin: 100, fee_active_tvl_ratio: 0, fee_per_tvl_24h: 2 });
    let state4 = loadPaperState({ filePath: testFilePath });
    assertEqual(Object.keys(state4.open_trades).length, 1, "Trade should stay open (too young for yield check)");

    // Min 35: low yield, age is 35 >= 30. Should close.
    await evalAt(35, { price: 10, active_bin: 100, fee_active_tvl_ratio: 0, fee_per_tvl_24h: 2 });
    state4 = loadPaperState({ filePath: testFilePath });
    assertEqual(Object.keys(state4.open_trades).length, 0, "Trade should close due to low yield");
    assertEqual(Object.values(state4.closed_trades)[0].close_reason_code, "low_yield", "Reason should be low_yield");

    console.log("✅ Low yield close passed");

    console.log("paper-evaluator-close-rules tests passed");
  } finally {
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
  }
}

runTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
