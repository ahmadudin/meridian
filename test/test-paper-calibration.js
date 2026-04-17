import assert from "assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { loadCalibration, saveCalibration } from "../paper-calibration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paper-cal-"));
}

async function runTests() {
  console.log("=== Running Paper Calibration Tests ===");
  const dir = makeTempDir();
  const filePath = path.join(dir, "paper-calibration.json");

  // Test 1: Load defaults when no file
  const defaultCal = loadCalibration({ filePath, force: true });
  assert.equal(defaultCal.coefficients.alpha_directional, 0.35);

  // Test 2: Save and load custom coefficients
  const newCal = saveCalibration({
    filePath,
    data: { coefficients: { alpha_directional: 0.5, new_coef: 10 } }
  });
  assert.equal(newCal.coefficients.alpha_directional, 0.5);

  const reloaded = loadCalibration({ filePath, force: true });
  assert.equal(reloaded.coefficients.alpha_directional, 0.5);
  // Merges with defaults underneath
  assert.equal(reloaded.coefficients.beta_fee, 0.25);
  assert.equal(reloaded.coefficients.new_coef, 10);

  // Test 3: CLI integration (mocking config)
  // Let's run a quick cli.js text check 
  const projectRoot = path.join(__dirname, "..");
  
  // NOTE: CLI will use the default file path (~/src/mrdn/data/paper-calibration.json), so we'll test that it doesn't crash rather than mutating data.
  const showText = execFileSync("node", ["cli.js", "paper", "calibration", "show"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.ok(showText.includes("alpha_directional"));

  console.log("✅ Calibration tests passed");
  process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
