import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { initializePaperState, loadPaperState } from "../paper-state.js";
import { openPaperTrade } from "../paper-engine.js";
import { estimatePaperReturn, evaluatePaperTrades } from "../paper-evaluator.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paper-evaluator-"));
}

async function main() {
  const dir = makeTempDir();
  const filePath = path.join(dir, "paper-state.json");
  const lessonsPath = path.join(dir, "lessons.json");
  fs.writeFileSync(lessonsPath, JSON.stringify({ lessons: [], performance: [] }, null, 2));
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const prevCwd = process.cwd();

  try {
    process.chdir(dir);
    initializePaperState({ filePath, startingBalanceSol: 2 });

    const opened = await openPaperTrade({
      filePath,
      amountSol: 0.3,
      poolAddress: "PoolA",
      poolName: "Pool A",
      baseMint: "MintA",
      reserveGasBufferSol: 0.2,
      maxOpenTrades: 5,
      entryPrice: 10,
      now: Date.UTC(2026, 0, 1, 0, 0, 0),
    });

    const estimated = estimatePaperReturn({
      trade: opened.trade,
      currentPrice: 10.5,
      snapshot: { fee_active_tvl_ratio: 0.1, volatility: 2, active_bin: 12 },
    });
    assert.ok(estimated.total_return_pct > 0);
    assert.ok(estimated.unrealized_pnl_sol > 0);

    const result = await evaluatePaperTrades({
      filePath,
      now: Date.UTC(2026, 0, 1, 0, 20, 0),
      horizonsMin: [5, 15],
      primaryHorizonMin: 15,
      takeProfitPct: 3,
      stopLossPct: -3,
      priceFetcher: async () => ({
        price: 10.5,
        active_bin: 12,
        volatility: 2,
        fee_active_tvl_ratio: 0.1,
      }),
    });

    assert.equal(result.evaluated, 2);
    assert.equal(result.closed, 1);
    const state = loadPaperState({ filePath });
    assert.equal(Object.keys(state.open_trades).length, 0);
    assert.equal(Object.keys(state.closed_trades).length, 1);

    const lessonsState = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
    assert.equal(lessonsState.performance.length, 1);

    console.log("paper-evaluator tests passed");
  } finally {
    process.chdir(prevCwd);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
