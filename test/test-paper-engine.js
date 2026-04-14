import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  closePaperTrade,
  getPaperLedger,
  getPaperRejectSummary,
  getPaperStatus,
  getPaperTradeById,
  openPaperTrade,
  preflightPaperDeploy,
} from "../paper-engine.js";
import { initializePaperState, loadPaperState } from "../paper-state.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paper-engine-"));
}

async function main() {
  const dir = makeTempDir();
  const filePath = path.join(dir, "paper-state.json");
  initializePaperState({ filePath, startingBalanceSol: 2 });

  const ok = preflightPaperDeploy({
    filePath,
    amountSol: 0.3,
    poolAddress: "PoolA",
    baseMint: "MintA",
    reserveGasBufferSol: 0.2,
    maxOpenTrades: 5,
  });
  assert.equal(ok.ok, true);

  const opened = await openPaperTrade({
    filePath,
    amountSol: 0.3,
    poolAddress: "PoolA",
    poolName: "Pool A",
    baseMint: "MintA",
    reserveGasBufferSol: 0.2,
    maxOpenTrades: 5,
    entryPrice: 1.23,
  });
  assert.equal(opened.ok, true);
  assert.ok(opened.trade.id);

  const duplicatePool = preflightPaperDeploy({
    filePath,
    amountSol: 0.3,
    poolAddress: "PoolA",
    baseMint: "MintB",
    reserveGasBufferSol: 0.2,
    maxOpenTrades: 5,
  });
  assert.equal(duplicatePool.ok, false);
  assert.equal(duplicatePool.reason_code, "duplicate_pool_exposure");

  const duplicateToken = preflightPaperDeploy({
    filePath,
    amountSol: 0.3,
    poolAddress: "PoolB",
    baseMint: "MintA",
    reserveGasBufferSol: 0.2,
    maxOpenTrades: 5,
  });
  assert.equal(duplicateToken.ok, false);
  assert.equal(duplicateToken.reason_code, "duplicate_token_exposure");

  const nullTokenNoCollision = preflightPaperDeploy({
    filePath,
    amountSol: 0.3,
    poolAddress: "PoolC",
    baseMint: null,
    reserveGasBufferSol: 0.2,
    maxOpenTrades: 5,
  });
  assert.equal(nullTokenNoCollision.ok, true);

  const closeResult = await closePaperTrade({
    filePath,
    tradeId: opened.trade.id,
    closeReasonCode: "manual_close",
    finalReturnPct: 2,
  });
  assert.equal(closeResult.ok, true);
  assert.equal(closeResult.closedTrade.status, "closed");

  const state = loadPaperState({ filePath });
  assert.equal(Object.keys(state.open_trades).length, 0);
  assert.equal(Object.keys(state.closed_trades).length, 1);

  const status = getPaperStatus({ filePath });
  assert.equal(status.open_trade_count, 0);
  assert.equal(status.closed_trade_count, 1);

  const inspected = getPaperTradeById({ filePath, tradeId: opened.trade.id });
  assert.equal(inspected.trade.id, opened.trade.id);

  const ledger = getPaperLedger({ filePath, limit: 10 });
  assert.ok(ledger.events.length >= 3);

  const rejected = await openPaperTrade({
    filePath,
    amountSol: 9,
    poolAddress: "PoolZ",
    baseMint: "MintZ",
    reserveGasBufferSol: 0.2,
    maxOpenTrades: 5,
  });
  assert.equal(rejected.ok, false);
  const rejects = getPaperRejectSummary({ filePath });
  assert.ok(rejects.by_reason_code.insufficient_free_balance >= 1);

  console.log("paper-engine tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
