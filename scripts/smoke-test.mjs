#!/usr/bin/env node
// Smoke test — hits /api/health and /api/login, exits 0 on success.
// Usage:  node scripts/smoke-test.mjs [BASE_URL]

const BASE = process.argv[2] || process.env.BASE_URL || "http://localhost:4000";

async function main() {
  console.log(`Smoke-testing ${BASE} …\n`);

  // 1. Health
  const h = await fetch(`${BASE}/api/health`);
  if (h.status !== 200) throw new Error(`Health check failed: ${h.status}`);
  const hj = await h.json();
  if (!hj.ok) throw new Error("Health check returned ok: false");
  console.log("  [PASS] GET /api/health → 200 ok");

  // 2. Login with bad creds → 401
  const bad = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "__bad__", password: "__bad__" }),
  });
  if (bad.status !== 401) throw new Error(`Expected 401 for bad login, got ${bad.status}`);
  console.log("  [PASS] POST /api/login (bad creds) → 401");

  // 3. Protected route without token → 401
  const unauth = await fetch(`${BASE}/api/quotations`);
  if (unauth.status !== 401) throw new Error(`Expected 401, got ${unauth.status}`);
  console.log("  [PASS] GET /api/quotations (no token) → 401");

  // 4. Unknown route → 404
  const nf = await fetch(`${BASE}/api/nonexistent`);
  if (nf.status !== 404) throw new Error(`Expected 404, got ${nf.status}`);
  console.log("  [PASS] GET /api/nonexistent → 404");

  console.log("\nAll smoke tests passed.");
}

main().catch((err) => {
  console.error(`\n  FAIL: ${err.message}`);
  process.exit(1);
});
