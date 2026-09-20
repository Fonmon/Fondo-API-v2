# Business alignment — Phase 8 (files): P8-F1, P8-F2, P8-F3, §7.1

Reviewed: `Fondo-API-v2` `feat/phase-8-files` at `71cd7de`; `docs/phase-8-deviations.md` §2.2,
§4, §7.1; v1 `fondo_api/services/file.py`, `fondo_api/views/file.py`, `fondo_api/models.py`
(`File`), `fondo_api/permissions.py` (`FileView`, `FileDetailView`).

**Verdict: Concerns.** The port matches v1. Nothing here blocks Phase 8 as a parity port. But
P8-F1 and P8-F2 are real hazards for the one person who publishes documents, and the operator
has to decide on them before cutover. That decision, and the question about fund practice
below, are what's open.

---

## 0. What the fund's data shows

All queries are read-only, against `fondodev` (per `MIGRATION_PLAN.md`, it was reloaded from a
recent snapshot). Run on 2026-09-12.

| # | query | result |
|---|---|---|
| Q1 | `SELECT type, count(*) FROM fondo_api_file GROUP BY type ORDER BY type;` | type 0: **23**, type 1: **14** (37 rows) |
| Q2 | `SELECT lower(display_name), array_agg(DISTINCT type), count(*) FROM fondo_api_file GROUP BY lower(display_name) HAVING count(DISTINCT type) > 1;` | **0 rows** |
| Q3 | `SELECT type, lower(display_name), array_agg(display_name) FROM fondo_api_file GROUP BY type, lower(display_name) HAVING count(*) > 1;` | **0 rows** |
| Q4 | `SELECT count(*) FROM (SELECT lower(display_name) FROM fondo_api_file GROUP BY 1 HAVING count(*) > 1) s;` | **0** (no case-insensitive duplicate at all, across or within types) |
| Q5 | `SELECT count(*) FROM fondo_api_file WHERE type NOT IN (0,1);` | **0** |
| Q6 | `SELECT id, type, display_name, created_at::date FROM fondo_api_file ORDER BY created_at;` | Every type 0 row is named `Acta número N` (N = 1..23). Every type 1 row is named `Resultados YYYY` (2012..2025). Since 2023, each upload date has exactly one Acta and one Resultados (2023-02-07, 2024-02-06, 2025-02-10, 2026-02-02). |
| Q7 | `SELECT id FROM fondo_api_file WHERE display_name <> btrim(display_name) OR display_name LIKE '%/%';` | **0 rows** |
| Q8 | `SELECT g FROM generate_series(1,(SELECT max(id) FROM fondo_api_file)) g WHERE g NOT IN (SELECT id FROM fondo_api_file);` plus `SELECT last_value FROM fondo_api_file_id_seq;` | missing ids **16, 21, 34, 35, 40, 41**; sequence at 43 |

**How to read Q8.** v1 cannot delete a `File` row: there is no `DELETE` on either file view,
and no Django admin is mounted (I grepped for `admin.site` and `register(`: 0 hits). PostgreSQL
does not give back a sequence value when an insert fails. So each missing id is **either** an
insert that failed **or** a row deleted outside the app. The database cannot tell those apart.
It also cannot tell whether a failed insert left a stored document behind. The gaps fall close
to upload dates (16 between 2020-04-12 and 2020-06-26; 21 just before the 2022-03-13 batch;
34-35 before 2024-02-06; 40-41 before 2026-02-02). That fits with, but **does not prove**,
failed upload attempts. Only a listing of the `fonmon` bucket can show whether orphans exist.
That listing is not possible from this machine.

---

## P8-F1 — same name under the other type leaves an orphaned document

**1. Does the fund file one name under both types?** Not today. Q2 finds **0** collisions
across types, compared case-insensitively. The two naming patterns (Q6) never overlap.

The likely trigger is still worth naming, because it is an ordinary mistake. The admin uploads
`Acta número 24` with the **wrong type** selected. That succeeds, and the acta shows up under
presentations. The app has no delete or edit, so the only fix available is to upload it again
with the right type. That second upload is exactly P8-F1: the document is stored, the request
answers **500**, and a retry answers **201** with no new row. The admin is left believing the
correction worked. The acta stays listed under the wrong type, and the corrected copy is never
visible to anyone.

**2. Is an orphan a problem?**
- **Members not being informed (main impact).** A 201 on retry tells the admin the document was
  published when it was not. For actas, which record what an assembly decided, members would not
  get a document the fund believes it gave them.
- **Privacy: probably low, but not verified.** An orphan can only be reached by someone with
  bucket credentials, not through the app, because downloads need a row id. That holds only if
  `fonmon` is private, and I could not check it (no GCS access, by constraint). **Operator to
  confirm** that the bucket has no public access.
- **Cleanup.** An orphan cannot be seen or removed through the app. Only the GCS console can.
- **Cost.** Negligible at this volume (37 documents in about 6 years, per Q6).

**3. Recommendation: refuse before uploading.** If `display_name` already exists (as the
operator decides to define "exists", see below), answer with a 4xx and store nothing. No
existing data depends on the current behaviour (Q2 = 0). The change is business-visible: an
admin who would have got 500 and then 201 now gets a clear refusal.

Operator decisions:
- **(a)** Refuse before upload (recommended), or keep v1's behaviour, or "delete the object when
  the row fails" (the developer's alternative, which adds a second failure point).
- **(b)** Should the "already exists" check be exact or case-insensitive? This connects to
  P8-F2.
- **(c)** How does the fund recover from a wrong-type upload? Today nothing in the app can fix
  it. Is a manual database fix by the developer acceptable, or is an edit/delete action wanted
  later? (That would be new scope, not Phase 8.)
- **(d)** Pre-cutover check: who has GCS access to list `fonmon` and compare it with the 37
  expected paths `<proceeding|presentations>/<lower(display_name)>`? Any extra object is an
  orphan or older content. The operator decides whether to keep or delete each one.
- **(e)** The web client's reaction to a new 4xx is unknown. The frontend repository is not on
  this machine. Does the upload screen show errors other than success?

## P8-F2 — a name differing only in case silently replaces a document

**2. Measured:** Q3 finds **0** names that differ only in case within a type, and Q4 finds 0
overall. That **confirms** the pre-brief count (0 of 37).

**1. Is replacement a real workflow?** The data cannot answer this. A re-upload with the exact
same name writes no row and leaves no timestamp, so it leaves no trace in the database.
**Question for the operator:** has the admin ever uploaded `Acta número N` again to replace it,
for example with the signed or corrected version? If yes, that exact-name replacement is a
feature v2 must keep. Replacing through a **differently-cased** name is, in my reading, an
accident of lowercasing the path, not a design choice: nothing in v1 documents it, and no data
uses it. **Operator to confirm.**

**Business impact if kept.** An acta that members may already have downloaded quietly starts
serving different content under the same list entry. Nothing records it: no audit, no
`created_at` change. Nobody is told; v1 sends no email or push on any upload. For assembly
records, this is a document-integrity risk.

**3. Recommendation, pending the answer above:**
- If exact-name replacement **is** a workflow: **keep** exact-name replacement, **refuse**
  case-variant names (they would overwrite a different entry's document).
- If replacement is **not** a workflow: refuse any upload whose object already exists. The admin
  would need a different name.
- In both cases, I recommend at least a server log line whenever an existing document is
  replaced, so there is a trace. How to implement it is for nestjs-developer.

## P8-F3 — `type` is not validated

**2. Measured:** Q5 finds **0** rows outside `{0, 1}`, and Q6's naming shows exactly two kinds in
use.

**1. Question for the operator:** has a third kind of document ever been planned, such as
statutes (estatutos), regulations or financial statements? The code and the data show only two,
and I cannot rule out plans.

**3. Recommendation: refuse unknown types** (400, nothing stored), unless the operator names a
planned third kind. Nothing existing depends on accepting them. Today an unknown type creates a
document listed with a bare number as its type, which members would not see in either section of
the app (if the client filters by 0 and 1; not verifiable here). It also cannot be corrected
through the app. This is business-visible only for a mistaken request.

## §7.1 — "and the object is overwritten"

It describes **v1's behaviour** accurately, and it is correct as a **parity** criterion for the
port as shipped. It is **not yet confirmed** as what the fund expects; that depends on the P8-F2
question. Suggested wording until the operator answers:

> no duplicate row when the object already exists, and the object is overwritten — the path is
> `<type name>/<lowercased name>`, so this includes a name differing only in case (v1 behaviour,
> ported; subject to P8-F1/P8-F2 decisions).

If the operator chooses "refuse" for F1 or F2, this criterion changes along with it.

---

## Unchanged and confirmed (no action)

- **Permissions:** uploads are ADMIN only (`POST 0`). Listing and download links are for every
  role (`GET 3`). They match `fondo_api/permissions.py`, and the phase checked them rather than
  editing them.
- **Download link:** v4 signed URL, 5 minutes. Measured byte-identical to v1.
- **Notifications:** v1 sends no email or push when a document is uploaded, and v2 adds none.
  **Question for the operator:** is that intended, or do members learn about a new acta some
  other way? (This is a new-feature question, not a parity gap.)
- **Alexa:** no file process used the Alexa intent. Nothing is lost here.
- **P8-D1** (tie-break by `id` for documents uploaded at the same instant): harmless to members.
