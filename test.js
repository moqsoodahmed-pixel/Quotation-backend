// Integration test for the quotation API.
// Usage:  PORT=4002 node test.js
// The backend must already be running on $PORT.

const PORT = process.env.PORT || 4002;
const BASE = `http://localhost:${PORT}`;
const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASS || "testpass";

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function authedApi(token, path, opts = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...opts.headers };
  return api(path, { ...opts, headers });
}

async function run() {
  console.log("\n=== 1. Health ===");
  {
    const { status, body } = await api("/api/health");
    assert(status === 200 && body.ok === true, "GET /api/health returns 200 ok");
  }

  console.log("\n=== 2. Login ===");
  let token;
  {
    const { status, body } = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    assert(status === 200 && body.token, "Valid login returns token");
    token = body.token;
  }
  {
    const { status } = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "wrong", password: "wrong" }),
    });
    assert(status === 401, "Bad credentials return 401");
  }

  console.log("\n=== 3. 401 on missing/invalid token ===");
  {
    const { status } = await api("/api/quotations");
    assert(status === 401, "No token → 401");
  }
  {
    const { status } = await api("/api/quotations", {
      headers: { Authorization: "Bearer invalid_token_here" },
    });
    assert(status === 401, "Bad token → 401");
  }

  console.log("\n=== 4. Save 2 quotations per company ===");
  const savedIds = {};
  const companies = ["launcherdesk", "dutylaunch", "officerestore"];
  for (const co of companies) {
    savedIds[co] = [];
    for (let i = 1; i <= 2; i++) {
      const { status, body } = await authedApi(token, "/api/quotations", {
        method: "POST",
        body: JSON.stringify({
          companyId: co,
          data: { to: `Client ${co} ${i}`, company: `${co} Corp`, subject: `Test ${i}` },
        }),
      });
      assert(status === 201, `Save ${co} #${i} → 201`);
      assert(body.data?.quotationNo?.length > 0, `Save ${co} #${i} got quotationNo: ${body.data?.quotationNo}`);
      savedIds[co].push(body.id);
    }
  }

  console.log("\n=== 5. Independent numbering ===");
  {
    const { body: list } = await authedApi(token, "/api/quotations");
    const ldNos = list.filter((q) => q.companyId === "launcherdesk").map((q) => q.quotationNo).filter(Boolean);
    const dlNos = list.filter((q) => q.companyId === "dutylaunch").map((q) => q.quotationNo).filter(Boolean);
    const orNos = list.filter((q) => q.companyId === "officerestore").map((q) => q.quotationNo).filter(Boolean);
    assert(ldNos.every((n) => n.startsWith("LD/")), "LauncherDesk numbers start with LD/");
    assert(dlNos.every((n) => n.startsWith("DL/")), "DutyLaunch numbers start with DL/");
    assert(orNos.every((n) => n.startsWith("OR/")), "OfficeRestore numbers start with OR/");

    // Check no duplicates within a company
    assert(new Set(ldNos).size === ldNos.length, "LD: no duplicate numbers");
    assert(new Set(dlNos).size === dlNos.length, "DL: no duplicate numbers");
    assert(new Set(orNos).size === orNos.length, "OR: no duplicate numbers");
  }

  console.log("\n=== 6. History filtering ===");
  {
    const { body } = await authedApi(token, "/api/quotations?company=dutylaunch");
    assert(body.every((q) => q.companyId === "dutylaunch"), "Filter by dutylaunch");
  }

  console.log("\n=== 7. Search ===");
  {
    const { body } = await authedApi(token, "/api/quotations?q=dutylaunch%20Corp");
    assert(body.length > 0, "Search returns results");
    assert(body.every((q) => q.clientCompany === "dutylaunch Corp"), "Search results match");
  }

  console.log("\n=== 8. Duplicate ===");
  {
    const origId = savedIds.officerestore[0];
    const { status, body } = await authedApi(token, `/api/quotations/${origId}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ companyId: "officerestore" }),
    });
    assert(status === 201, "Duplicate returns 201");
    assert(body.data?.quotationNo?.startsWith("OR/"), "Duplicate gets new OR/ number");
    assert(body.id !== origId, "Duplicate has a different ID");
  }

  console.log("\n=== 9. Next-number preview ===");
  {
    const { body: before } = await authedApi(token, "/api/quotations/next-number?company=dutylaunch");
    const seqBefore = before.seq;
    // Call again — peek should NOT consume
    const { body: after } = await authedApi(token, "/api/quotations/next-number?company=dutylaunch");
    assert(after.seq === seqBefore, "Peek does not consume number");
  }

  console.log("\n=== 10. 404 handler ===");
  {
    const { status } = await authedApi(token, "/api/nonexistent");
    assert(status === 404, "Unknown route → 404");
  }

  console.log("\n=== 11. Delete ===");
  {
    const delId = savedIds.launcherdesk[1];
    const { status } = await authedApi(token, `/api/quotations/${delId}`, { method: "DELETE" });
    assert(status === 200, "Delete → 200");
    const { status: s2 } = await authedApi(token, `/api/quotations/${delId}`);
    assert(s2 === 404, "Deleted doc → 404");
  }

  // ----- Summary -----
  console.log(`\n${"=".repeat(40)}`);
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
