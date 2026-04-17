/**
 * auth.js — OAuth provider for Codex login
 *
 * Handles:
 *  - OAuth authorization code → access token exchange
 *  - Token persistence in .auth-token.json
 *  - Auto-refresh of expired tokens
 *  - getApiKey() — unified API key resolution across env vars + OAuth
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, ".auth-token.json");

/**
 * OAuth token structure stored in .auth-token.json:
 * {
 *   provider: 'openai' | 'openrouter' | 'custom',
 *   access_token: 'sk-...',
 *   refresh_token: 'rt-...',      // optional
 *   expires_at: '2026-05-01T...',  // ISO timestamp
 *   token_type: 'bearer',
 *   scopes: ['chat.completions', 'models.read'],
 * }
 */

export function loadAuthToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    if (token.expires_at && new Date(token.expires_at) < new Date()) {
      log("auth", "Stored token expired — needs refresh or re-login");
      return { ...token, expired: true };
    }
    return token;
  } catch {
    return null;
  }
}

export function saveAuthToken(token) {
  const safe = { ...token };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(safe, null, 2));
  log("auth", `Auth token saved (provider: ${token.provider}, expires: ${token.expires_at || "never"})`);
}

export function clearAuthToken() {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  log("auth", "Auth token cleared");
}

/**
 * Exchange an OAuth authorization code for an access token.
 * Supports OpenAI's OAuth2 flow for Codex.
 */
export async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, provider = "openai" }) {
  const tokenEndpoints = {
    openai: "https://auth.openai.com/oauth/token",
  };
  const endpoint = tokenEndpoints[provider];
  if (!endpoint) throw new Error(`Unknown OAuth provider: ${provider}`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OAuth token exchange failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const token = {
    provider,
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    token_type: data.token_type || "bearer",
    scopes: data.scope ? data.scope.split(" ") : [],
  };

  saveAuthToken(token);
  return token;
}

/**
 * Refresh an expired token using the refresh_token.
 */
export async function refreshToken(storedToken) {
  if (!storedToken?.refresh_token) {
    throw new Error("No refresh token available — re-login required");
  }

  const clientId = process.env.OPENAI_CLIENT_ID || "";
  const clientSecret = process.env.OPENAI_CLIENT_SECRET || "";

  const res = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: storedToken.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  const token = {
    ...storedToken,
    expired: undefined,
    access_token: data.access_token,
    refresh_token: data.refresh_token || storedToken.refresh_token,
    expires_at: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : storedToken.expires_at,
  };
  saveAuthToken(token);
  return token;
}

/**
 * Get a valid API key — checks env vars first, then OAuth token store.
 * Auto-refreshes expired tokens.
 * @returns {{ key: string, provider: string } | null}
 */
export async function getApiKey() {
  // Env vars take priority (simple deployment)
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, provider: "openai" };
  if (process.env.OPENROUTER_API_KEY) return { key: process.env.OPENROUTER_API_KEY, provider: "openrouter" };
  if (process.env.LLM_API_KEY) return { key: process.env.LLM_API_KEY, provider: "custom" };

  // OAuth token store
  let token = loadAuthToken();
  if (!token) return null;

  if (token.expired && token.refresh_token) {
    try {
      token = await refreshToken(token);
    } catch (err) {
      log("auth_error", `Token refresh failed: ${err.message}`);
      return null;
    }
  } else if (token.expired) {
    return null; // Needs re-login
  }

  return { key: token.access_token, provider: token.provider };
}
