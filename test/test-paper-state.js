import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_PAPER_STATE,
  initializePaperState,
  loadPaperState,
  reconcilePaperState,
  resetPaperState,
  withPaperStateTransaction,
} from "../paper-state.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paper-state-"));
}

function makeFile(dir, name = "paper-state.json") {
  return path.join(dir, name);
}

async function main() {
  const dir = makeTempDir();
  const filePath = makeFile(dir);

  const init = initializePaperState({ filePath, startingBalanceSol: 2 });
  assert.equal(init.wallet.starting_balance_sol, 2);
  assert.equal(init.wallet.free_balance_sol, 2);
  assert.equal(init.wallet.reserved_balance_sol, 0);
  assert.ok(Array.isArray(init.events));
  assert.equal(init.events.length, 1);

  const loaded = loadPaperState({ filePath });
  assert.equal(loaded.wallet.equity_sol, 2);
  assert.deepEqual(Object.keys(loaded.open_trades), []);

  await withPaperStateTransaction({ filePath }, (state) => {
    state.open_trades.t1 = {
      id: "t1",
      status: "open",
      allocated_sol: 0.5,
      latest_mark: { unrealized_pnl_sol: 0.1 },
    };
    state.wallet.free_balance_sol = 1.5;
    state.wallet.reserved_balance_sol = 0.5;
    state.wallet.unrealized_pnl_sol = 0.1;
    state.wallet.equity_sol = 2.1;
    state.events.push({ id: "evt_test", ts: new Date().toISOString(), type: "trade_opened", trade_id: "t1", payload: {} });
  });

  const afterTxn = loadPaperState({ filePath });
  assert.equal(afterTxn.open_trades.t1.allocated_sol, 0.5);
  assert.equal(afterTxn.wallet.equity_sol, 2.1);

  await withPaperStateTransaction({ filePath }, (state) => {
    state.wallet.equity_sol = 999;
  });
  const reconciled = reconcilePaperState({ filePath });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.state.wallet.equity_sol, 2.1);
  assert.ok(reconciled.invariants.equity_matches);

  const reset = resetPaperState({ filePath, startingBalanceSol: 3 });
  assert.equal(reset.wallet.starting_balance_sol, 3);
  assert.equal(reset.wallet.free_balance_sol, 3);
  assert.deepEqual(Object.keys(reset.open_trades), []);

  console.log("paper-state tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
