// ---------------------------------------------------------------------------
// LauncherDesk Quotation Maker — backend
// Express API with a tiny JSON-file database. Every saved quotation lands in
// db.json and shows up under "History" in the app.
// ---------------------------------------------------------------------------
import express from "express";
import cors from "cors";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "db.json");
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// --- tiny JSON store -------------------------------------------------------
async function readDb() {
  if (!existsSync(DB_PATH)) return { quotations: [], nextSeq: 1 };
  try {
    const raw = await readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      quotations: Array.isArray(parsed.quotations) ? parsed.quotations : [],
      nextSeq: Number.isInteger(parsed.nextSeq) ? parsed.nextSeq : 1,
    };
  } catch {
    return { quotations: [], nextSeq: 1 };
  }
}

// Zero-pad to 2 digits (01, 02, ... 99); once the count reaches 3+ digits
// it's left as-is (100, 101, ...) rather than padded further.
function formatSeq(seq) {
  return String(seq).padStart(2, "0");
}

async function writeDb(db) {
  await mkdir(dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --- routes ----------------------------------------------------------------

// List quotations (newest first, lightweight fields only for the sidebar).
app.get("/api/quotations", async (_req, res) => {
  const db = await readDb();
  const list = db.quotations
    .map((q) => ({
      id: q.id,
      savedAt: q.savedAt,
      quotationNo: q.data?.quotationNo || "",
      clientCompany: q.data?.company || "",
      clientName: q.data?.to || "",
      subject: q.data?.subject || "",
    }))
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  res.json(list);
});

// Reserve and return the next quotation number, e.g. LD/2026/01, LD/2026/02,
// ... LD/2026/99, LD/2026/100 (no leading zero once it's 3+ digits). Must be
// registered before the /:id route below, or Express would match "next-number"
// as an :id and 404.
app.get("/api/quotations/next-number", async (_req, res) => {
  const db = await readDb();
  const seq = db.nextSeq;
  db.nextSeq = seq + 1;
  await writeDb(db);
  const year = new Date().getFullYear();
  res.json({ seq, quotationNo: `LD/${year}/${formatSeq(seq)}` });
});

// Fetch a single full quotation to reload into the form.
app.get("/api/quotations/:id", async (req, res) => {
  const db = await readDb();
  const found = db.quotations.find((q) => q.id === req.params.id);
  if (!found) return res.status(404).json({ error: "Quotation not found" });
  res.json(found);
});

// Save a new quotation (or update an existing one when an id is supplied).
app.post("/api/quotations", async (req, res) => {
  const { id, data } = req.body || {};
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "Missing quotation data" });
  }
  const db = await readDb();
  const now = new Date().toISOString();

  if (id) {
    const idx = db.quotations.findIndex((q) => q.id === id);
    if (idx !== -1) {
      db.quotations[idx] = { ...db.quotations[idx], data, savedAt: now };
      await writeDb(db);
      return res.json(db.quotations[idx]);
    }
  }
  const record = { id: makeId(), data, savedAt: now };
  db.quotations.push(record);
  await writeDb(db);
  res.status(201).json(record);
});

// Delete a quotation from history.
app.delete("/api/quotations/:id", async (req, res) => {
  const db = await readDb();
  const before = db.quotations.length;
  db.quotations = db.quotations.filter((q) => q.id !== req.params.id);
  if (db.quotations.length === before) {
    return res.status(404).json({ error: "Quotation not found" });
  }
  await writeDb(db);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`LauncherDesk quotation API running on http://localhost:${PORT}`);
});
