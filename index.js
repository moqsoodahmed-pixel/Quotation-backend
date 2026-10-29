import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { MongoClient, ObjectId } from "mongodb";
import crypto from "crypto";
import jwt from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Config — fail fast if required vars are missing
// ---------------------------------------------------------------------------
const required = ["MONGO_URI", "JWT_SECRET", "ADMIN_USER", "ADMIN_PASS"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`FATAL — missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

// DB_NAME: env > database name from MONGO_URI path > "launcherdesk".
function resolveDbName() {
  if (process.env.DB_NAME) return process.env.DB_NAME;
  try {
    const url = new URL(MONGO_URI);
    const fromPath = url.pathname.replace(/^\//, "").split("/")[0];
    if (fromPath) return fromPath;
  } catch { /* ignore parse errors */ }
  return "launcherdesk";
}
const DB_NAME = resolveDbName();

// ALLOWED_ORIGINS: comma-separated, trim whitespace and trailing slashes.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Company prefix map — keeps numbering independent per entity.
const COMPANY_PREFIX = {
  launcherdesk: "LD",
  dutylaunch: "DL",
  officerestore: "OR",
};
const VALID_COMPANIES = Object.keys(COMPANY_PREFIX);

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // Railway / Cloudflare sit behind a proxy
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin(origin, cb) {
      // Allow requests with no origin (curl, server-to-server).
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("CORS: origin not allowed"));
    },
  })
);
app.use(express.json({ limit: "5mb" }));

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
let db;
const client = new MongoClient(MONGO_URI);

function quotations() {
  return db.collection("quotations");
}
function counters() {
  return db.collection("counters");
}

async function connectDb() {
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`Database: ${DB_NAME}`);
}

// ---------------------------------------------------------------------------
// Startup housekeeping — runs after connect, before listen
// ---------------------------------------------------------------------------

// Drop legacy unique index on `quotNo` if it exists (safe for production).
async function dropLegacyIndexes() {
  try {
    await quotations().dropIndex("quotNo_1");
    console.log("Dropped legacy quotNo_1 index");
  } catch {
    // index doesn't exist — that's fine
  }
}

async function ensureIndexes() {
  await quotations().createIndex(
    { companyId: 1, "data.quotationNo": 1 },
    { unique: true, sparse: true, name: "companyId_quotationNo_unique" }
  );
  await quotations().createIndex(
    { companyId: 1, savedAt: -1 },
    { name: "companyId_savedAt" }
  );
  console.log("Indexes ensured");
}

// Set companyId = "launcherdesk" and fill quotationNo for any old docs
// that don't have a companyId.  Idempotent: only touches docs where the
// field is missing, so safe on every boot.
async function migrateOldDocs() {
  const year = new Date().getFullYear();
  const prefix = COMPANY_PREFIX.launcherdesk;
  const cursor = quotations().find({ companyId: { $exists: false } });
  let migrated = 0;

  for await (const doc of cursor) {
    const update = { $set: { companyId: "launcherdesk" } };
    if (!doc.data?.quotationNo) {
      const seq = await consumeSeq("launcherdesk", year);
      update.$set["data.quotationNo"] = `${prefix}/${year}/${formatSeq(seq)}`;
    }
    try {
      await quotations().updateOne({ _id: doc._id }, update);
      migrated++;
    } catch (err) {
      if (err.code === 11000) {
        // Duplicate key — just set companyId without changing quotationNo.
        await quotations().updateOne({ _id: doc._id }, { $set: { companyId: "launcherdesk" } });
        migrated++;
      } else {
        throw err;
      }
    }
  }

  console.log(`Migration: ${migrated} doc(s) updated`);
}

// Seed / reconcile the yearly counter for every company so restarts never
// duplicate numbers.  Runs on EVERY boot (not just the first) so it
// catches numbers created by an earlier version of the code that didn't
// use yearly counters.
async function seedCounters() {
  const year = new Date().getFullYear();
  let seeded = 0;

  for (const companyId of VALID_COMPANIES) {
    const prefix = COMPANY_PREFIX[companyId];
    const key = `quotationSeq:${companyId}:${year}`;

    // Parse the highest seq from existing quotationNo values for this company/year.
    const pattern = new RegExp(`^${prefix}/${year}/`);
    const docs = await quotations()
      .find({ companyId, "data.quotationNo": pattern })
      .project({ "data.quotationNo": 1 })
      .toArray();

    let maxSeq = 0;
    for (const doc of docs) {
      const parts = doc.data?.quotationNo?.split("/");
      if (parts?.length === 3) {
        const n = parseInt(parts[2], 10);
        if (n > maxSeq) maxSeq = n;
      }
    }

    // Also check the old global counter (from the original code).
    if (companyId === "launcherdesk") {
      const oldGlobal = await counters().findOne({ _id: "quotationSeq" });
      if (oldGlobal) maxSeq = Math.max(maxSeq, oldGlobal.seq || 0);
    }
    // Also check old per-company (non-yearly) counter.
    const oldPerCompany = await counters().findOne({ _id: `quotationSeq:${companyId}` });
    if (oldPerCompany) maxSeq = Math.max(maxSeq, oldPerCompany.seq || 0);

    // Only bump the counter if the DB shows a higher number than the counter has.
    const existing = await counters().findOne({ _id: key });
    const currentSeq = existing?.seq ?? 0;

    if (maxSeq > currentSeq) {
      await counters().updateOne(
        { _id: key },
        { $set: { seq: maxSeq } },
        { upsert: true }
      );
      console.log(`Seeded counter ${key}: ${currentSeq} → ${maxSeq}`);
      seeded++;
    }
  }

  console.log(`Counter seeding: ${seeded} counter(s) updated`);
}

// Warn if the chosen DB looks empty but a known DB has data.
async function warnIfWrongDb() {
  const count = await quotations().countDocuments({}, { limit: 1 });
  if (count > 0) return; // chosen DB has data — all good

  const knownNames = ["launcherdesk", "LauncherDeskQuotation"];
  for (const name of knownNames) {
    if (name === DB_NAME) continue;
    try {
      const other = client.db(name);
      const otherCount = await other.collection("quotations").countDocuments({}, { limit: 1 });
      if (otherCount > 0) {
        console.warn(
          `⚠  WARNING: Database "${DB_NAME}" has zero quotations, but "${name}" has data. ` +
          `Set DB_NAME=${name} if that's the database you intended.`
        );
      }
    } catch { /* ignore — DB may not exist */ }
  }
}

// ---------------------------------------------------------------------------
// Auth — stateless JWT (12h expiry)
// ---------------------------------------------------------------------------
function signToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatSeq(seq) {
  return String(seq).padStart(3, "0");
}

// Counter _id = `quotationSeq:{companyId}:{year}` — resets each year.
async function consumeSeq(companyId, year) {
  const key = `quotationSeq:${companyId}:${year}`;
  const result = await counters().findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return result.seq;
}

async function peekNextSeq(companyId, year) {
  const key = `quotationSeq:${companyId}:${year}`;
  const doc = await counters().findOne({ _id: key });
  return (doc?.seq ?? 0) + 1;
}

// Timing-safe credential comparison.
function credentialsMatch(user, pass) {
  const uOk =
    user.length === ADMIN_USER.length &&
    crypto.timingSafeEqual(Buffer.from(user), Buffer.from(ADMIN_USER));
  const pOk =
    pass.length === ADMIN_PASS.length &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASS));
  return uOk && pOk;
}

// Async route wrapper — catches rejected promises and forwards to Express
// error handler so unhandled rejections don't crash the process.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: "Database unreachable" });
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again later" },
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (
    typeof username === "string" &&
    typeof password === "string" &&
    username.length > 0 &&
    password.length > 0 &&
    credentialsMatch(username, password)
  ) {
    return res.json({ token: signToken() });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// ---------------------------------------------------------------------------
// Protected routes
// ---------------------------------------------------------------------------

// List quotations — optional ?company= and ?q= filters.
app.get("/api/quotations", requireAuth, wrap(async (req, res) => {
  const { company, q } = req.query;
  const filter = {};
  if (company) filter.companyId = company;
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { "data.to": re },
      { "data.company": re },
      { "data.subject": re },
      { "data.quotationNo": re },
    ];
  }

  const list = await quotations()
    .find(filter, { projection: { data: 1, savedAt: 1, companyId: 1 } })
    .sort({ savedAt: -1 })
    .toArray();

  res.json(
    list.map((q) => ({
      id: q._id.toString(),
      savedAt: q.savedAt,
      companyId: q.companyId || "launcherdesk",
      quotationNo: q.data?.quotationNo || "",
      clientCompany: q.data?.company || "",
      clientName: q.data?.to || "",
      subject: q.data?.subject || "",
    }))
  );
}));

// Preview the next quotation number (does NOT consume the number).
app.get("/api/quotations/next-number", requireAuth, wrap(async (req, res) => {
  const companyId = req.query.company || "launcherdesk";
  const prefix = COMPANY_PREFIX[companyId] || "LD";
  const year = new Date().getFullYear();
  const nextSeq = await peekNextSeq(companyId, year);
  res.json({ seq: nextSeq, quotationNo: `${prefix}/${year}/${formatSeq(nextSeq)}` });
}));

app.get("/api/quotations/:id", requireAuth, wrap(async (req, res) => {
  try {
    const found = await quotations().findOne({ _id: new ObjectId(req.params.id) });
    if (!found) return res.status(404).json({ error: "Quotation not found" });
    res.json({ ...found, id: found._id.toString() });
  } catch {
    res.status(400).json({ error: "Invalid ID" });
  }
}));

// Save (create or update).  Assigns a real quotation number on first save.
app.post("/api/quotations", requireAuth, wrap(async (req, res) => {
  const { id, companyId: bodyCompanyId, data } = req.body || {};
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "Missing quotation data" });
  }
  const companyId = bodyCompanyId || data.companyId || "launcherdesk";
  const prefix = COMPANY_PREFIX[companyId] || "LD";
  const now = new Date().toISOString();
  const year = new Date().getFullYear();

  if (id) {
    try {
      const result = await quotations().findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { data, companyId, savedAt: now } },
        { returnDocument: "after" }
      );
      if (result) return res.json({ ...result, id: result._id.toString() });
    } catch {
      // fall through to insert
    }
  }

  // New quotation — consume a sequence number.
  const seq = await consumeSeq(companyId, year);
  const quotationNo = `${prefix}/${year}/${formatSeq(seq)}`;
  data.quotationNo = quotationNo;

  const record = { data, companyId, savedAt: now };
  const inserted = await quotations().insertOne(record);
  res.status(201).json({ ...record, id: inserted.insertedId.toString() });
}));

// Duplicate an existing quotation under a (possibly different) company.
app.post("/api/quotations/:id/duplicate", requireAuth, wrap(async (req, res) => {
  try {
    const original = await quotations().findOne({ _id: new ObjectId(req.params.id) });
    if (!original) return res.status(404).json({ error: "Not found" });

    const targetCompanyId = req.body?.companyId || original.companyId || "launcherdesk";
    const prefix = COMPANY_PREFIX[targetCompanyId] || "LD";
    const year = new Date().getFullYear();
    const seq = await consumeSeq(targetCompanyId, year);
    const quotationNo = `${prefix}/${year}/${formatSeq(seq)}`;

    const now = new Date().toISOString();
    const newData = { ...original.data, quotationNo, companyId: targetCompanyId };
    const record = { data: newData, companyId: targetCompanyId, savedAt: now };
    const inserted = await quotations().insertOne(record);
    res.status(201).json({ ...record, id: inserted.insertedId.toString() });
  } catch {
    res.status(400).json({ error: "Invalid ID" });
  }
}));

app.delete("/api/quotations/:id", requireAuth, wrap(async (req, res) => {
  try {
    const result = await quotations().deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "Invalid ID" });
  }
}));

// ---------------------------------------------------------------------------
// 404 + error handler
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown
// ---------------------------------------------------------------------------
let server;

async function startup() {
  await connectDb();
  await dropLegacyIndexes();
  await ensureIndexes();
  await migrateOldDocs();
  await seedCounters();
  await warnIfWrongDb();

  console.log(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);

  server = app.listen(PORT, () => {
    console.log(`LauncherDesk API running on port ${PORT}`);
  });
}

startup().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  if (server) server.close();
  try {
    await client.close();
  } catch { /* ignore */ }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
