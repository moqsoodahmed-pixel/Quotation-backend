// server/index.js — MongoDB version
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI; // set this in Render env vars
const ALLOWED_ORIGIN = process.env.CLIENT_URL 

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "5mb" }));

// --- DB connection ----------------------------------------------------------
let db;
const client = new MongoClient(MONGO_URI);

async function connectDb() {
  await client.connect();
  db = client.db("launcherdesk");
  console.log("Connected to MongoDB");
}

function quotations() {
  return db.collection("quotations");
}

// --- helpers ----------------------------------------------------------------
function formatSeq(seq) {
  return String(seq).padStart(2, "0");
}

async function getNextSeq() {
  const counters = db.collection("counters");
  const result = await counters.findOneAndUpdate(
    { _id: "quotationSeq" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return result.seq;
}

// --- routes -----------------------------------------------------------------
app.get("/api/quotations", async (_req, res) => {
  const list = await quotations()
    .find({}, { projection: { data: 1, savedAt: 1 } })
    .sort({ savedAt: -1 })
    .toArray();

  res.json(
    list.map((q) => ({
      id: q._id.toString(),
      savedAt: q.savedAt,
      quotationNo: q.data?.quotationNo || "",
      clientCompany: q.data?.company || "",
      clientName: q.data?.to || "",
      subject: q.data?.subject || "",
    }))
  );
});

app.get("/api/quotations/next-number", async (_req, res) => {
  const seq = await getNextSeq();
  const year = new Date().getFullYear();
  res.json({ seq, quotationNo: `LD/${year}/${formatSeq(seq)}` });
});

app.get("/api/quotations/:id", async (req, res) => {
  try {
    const found = await quotations().findOne({ _id: new ObjectId(req.params.id) });
    if (!found) return res.status(404).json({ error: "Quotation not found" });
    res.json({ ...found, id: found._id.toString() });
  } catch {
    res.status(400).json({ error: "Invalid ID" });
  }
});

app.post("/api/quotations", async (req, res) => {
  const { id, data } = req.body || {};
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "Missing quotation data" });
  }
  const now = new Date().toISOString();

  if (id) {
    try {
      const result = await quotations().findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { data, savedAt: now } },
        { returnDocument: "after" }
      );
      if (result) return res.json({ ...result, id: result._id.toString() });
    } catch {
      // fall through to insert
    }
  }

  const record = { data, savedAt: now };
  const inserted = await quotations().insertOne(record);
  res.status(201).json({ ...record, id: inserted.insertedId.toString() });
});

app.delete("/api/quotations/:id", async (req, res) => {
  try {
    const result = await quotations().deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "Invalid ID" });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- start ------------------------------------------------------------------
connectDb().then(() => {
  app.listen(PORT, () => {
    console.log(`LauncherDesk API running on port ${PORT}`);
  });
});
