import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paper-integration-"));
}

async function main() {
  const dir = makeTempDir();
  const filePath = path.join(dir, "paper-state.json");
  process.env.PAPER_STATE_FILE = filePath;
  process.env.DRY_RUN = "true";

  const { config } = await import("../config.js");
  const { initPaperState, getPaperStatus } = await import("../paper-engine.js");
  const { executeTool } = await import("../tools/executor.js");

  config.paper.enabled = true;
  config.paper.startingBalanceSol = 2;
  config.paper.maxOpenTrades = 5;
  config.paper.reserveGasBufferSol = 0.2;

  initPaperState({ startingBalanceSol: 2 });

  const deploy = await executeTool("deploy_position", {
    pool_address: "PoolA",
    pool_name: "Pool A",
    amount_y: 0.5,
    strategy: "spot",
    base_mint: "MintA",
    bin_step: 100,
  });
  assert.equal(deploy.success, true);
  assert.equal(deploy.paper, true);
  const statusAfterDeploy = getPaperStatus({});
  assert.equal(statusAfterDeploy.open_trade_count, 1);

  const rejected = await executeTool("deploy_position", {
    pool_address: "PoolA",
    pool_name: "Pool A",
    amount_y: 0.5,
    strategy: "spot",
    base_mint: "MintB",
    bin_step: 100,
  });
  assert.equal(rejected.blocked, true);

  const close = await executeTool("close_position", {
    position_address: deploy.position,
    reason: "manual_close",
  });
  assert.equal(close.success, true);
  const statusAfterClose = getPaperStatus({});
  assert.equal(statusAfterClose.open_trade_count, 0);
  assert.equal(statusAfterClose.closed_trade_count, 1);

  const walletJson = execFileSync("node", ["cli.js", "paper", "wallet"], {
    cwd: path.resolve("/workspace/meridian"),
    env: { ...process.env, PAPER_STATE_FILE: filePath, DRY_RUN: "true" },
    encoding: "utf8",
  });
  const wallet = JSON.parse(walletJson);
  assert.ok(typeof wallet.equity_sol === "number");

  console.log("paper-integration tests passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
