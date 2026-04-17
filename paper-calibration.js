import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CALIBRATION_FILE = path.join(__dirname, "data", "paper-calibration.json");

const DEFAULT_COEFFICIENTS = {
  alpha_directional: 0.35,
  beta_fee: 0.25,
  gamma_il: -0.008,
  concentration_factor_base: 1.0,
};

let cachedCalibration = null;
let lastLoadTime = 0;

export function loadCalibration({ filePath = DEFAULT_CALIBRATION_FILE, force = false } = {}) {
  const now = Date.now();
  if (!force && cachedCalibration && (now - lastLoadTime < 60000)) {
    return cachedCalibration;
  }
  let data = { coefficients: { ...DEFAULT_COEFFICIENTS } };
  try {
    if (fs.existsSync(filePath)) {
      const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (stored && stored.coefficients) {
        data.coefficients = { ...DEFAULT_COEFFICIENTS, ...stored.coefficients };
      }
    }
  } catch (e) {
    // default
  }
  cachedCalibration = data;
  lastLoadTime = now;
  return data;
}

export function saveCalibration({ filePath = DEFAULT_CALIBRATION_FILE, data } = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  cachedCalibration = data;
  lastLoadTime = Date.now();
  return data;
}
