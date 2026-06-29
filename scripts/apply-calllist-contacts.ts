// One-off: write researched decision-maker contacts + company contact details
// into the top call-list companies' profile_json. Non-destructive: existing
// contact fields and existing people are preserved; researched data fills gaps
// and merges onto matching names.
import { Database } from "bun:sqlite";

const DB_PATH = process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite";
const db = new Database(DB_PATH);
const RESULTS_PATH = process.argv[2] || "/tmp/research/results.json";
const results = JSON.parse(await Bun.file(RESULTS_PATH).text()) as any[];
const now = Date.now();
const actor = "user:manual-research";

function normName(s: string) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// --- Backup affected profiles before touching anything ---
const backup: Record<string, unknown> = {};
for (const r of results) {
  const row = db.query("SELECT id, name, profile_json FROM companies WHERE id = ?1").get(r.companyId) as any;
  if (row) backup[r.companyId] = { name: row.name, profile_json: row.profile_json };
}
const stamp = new Date(now).toISOString().replace(/[:.]/g, "").slice(0, 15);
await Bun.write(`data/calllist-contacts-backup-${stamp}.json`, JSON.stringify(backup, null, 2));
console.log(`Backed up ${Object.keys(backup).length} profiles to data/calllist-contacts-backup-${stamp}.json\n`);

let updated = 0;
for (const r of results) {
  const row = db.query("SELECT id, name, profile_json FROM companies WHERE id = ?1").get(r.companyId) as any;
  if (!row) { console.log(`!! MISSING company ${r.company} (${r.companyId})`); continue; }
  const profile = row.profile_json ? JSON.parse(row.profile_json) : {};

  // 1) Company contact: fill only missing fields.
  const contact = (profile.contact && typeof profile.contact === "object") ? profile.contact : {};
  for (const k of ["email", "phone", "contactUrl"] as const) {
    if (!String(contact[k] || "").trim() && String(r.contact?.[k] || "").trim()) {
      contact[k] = r.contact[k];
    }
  }
  profile.contact = contact;

  // 2) Decision-makers: merge by name onto any existing entries.
  const existing: any[] = Array.isArray(profile.decisionMakers) ? profile.decisionMakers : [];
  const byName = new Map<string, any>();
  for (const p of existing) byName.set(normName(p.name), { ...p });
  for (const p of r.decisionMakers) {
    const key = normName(p.name);
    const prev = byName.get(key) || {};
    const merged = { ...prev };
    for (const f of ["title", "tier", "email", "phone", "linkedin", "sourceUrl", "notes", "confidence"] as const) {
      const val = (p as any)[f];
      if (val !== "" && val != null) merged[f] = val;        // researched value fills/overrides
      else if (merged[f] == null) merged[f] = val;            // keep blank if nothing else
    }
    merged.name = p.name;
    byName.set(key, merged);
  }
  const decisionMakers = [...byName.values()];
  profile.decisionMakers = decisionMakers;

  // 3) Provenance.
  const withEmail = decisionMakers.filter((p) => String(p.email || "").trim()).length;
  const withAnyContact = decisionMakers.filter((p) => String(p.email || "").trim() || String(p.phone || "").trim() || String(p.linkedin || "").trim()).length;
  profile.contactEnrichment = {
    ...(profile.contactEnrichment && typeof profile.contactEnrichment === "object" ? profile.contactEnrichment : {}),
    capturedAt: now,
    method: "manual-web-research",
    emailPattern: r.emailPattern || "",
    decisionMakerCount: decisionMakers.length,
    withEmail,
    withAnyContact,
  };
  const fieldsUpdated = new Set<string>(Array.isArray(profile.fieldsUpdated) ? profile.fieldsUpdated : []);
  fieldsUpdated.add("decisionMakers");
  fieldsUpdated.add("contact");
  profile.fieldsUpdated = [...fieldsUpdated];

  db.query("UPDATE companies SET profile_json = ?2, updated_at = ?3 WHERE id = ?1")
    .run(r.companyId, JSON.stringify(profile), now);

  const actId = crypto.randomUUID();
  db.query(`INSERT INTO activities(id, target_type, target_id, actor, action_type, summary, payload_json, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).run(
    actId, "company", r.companyId, actor, "contacts_captured",
    `Captured ${decisionMakers.length} decision-maker(s) (${withAnyContact} with contact) + company details via web research`,
    JSON.stringify({ decisionMakerCount: decisionMakers.length, withEmail, withAnyContact, emailPattern: r.emailPattern || "", contact }),
    now,
  );

  updated++;
  console.log(`${r.company.padEnd(34)} people:${String(decisionMakers.length).padStart(2)}  wContact:${String(withAnyContact).padStart(2)}  email:${String(withEmail).padStart(2)}  compEmail:${contact.email ? "Y" : "-"}  compPhone:${contact.phone ? "Y" : "-"}`);
}

console.log(`\nUpdated ${updated}/${results.length} companies.`);
db.close();
