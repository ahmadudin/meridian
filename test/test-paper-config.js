import assert from "assert/strict";
import { config } from "../config.js";

function main() {
  assert.ok(config.paper, "config.paper should exist");
  assert.equal(typeof config.paper.enabled, "boolean");
  assert.equal(typeof config.paper.startingBalanceSol, "number");
  assert.ok(Array.isArray(config.paper.evaluationHorizonsMin));
  assert.equal(typeof config.paper.primaryHorizonMin, "number");
  assert.equal(typeof config.paper.takeProfitPct, "number");
  assert.equal(typeof config.paper.stopLossPct, "number");
  assert.equal(typeof config.paper.autoCloseAtMaxHorizon, "boolean");
  assert.equal(typeof config.paper.reserveGasBufferSol, "number");
  assert.equal(typeof config.paper.telegramStatusEnabled, "boolean");
  console.log("paper-config tests passed");
}

main();
