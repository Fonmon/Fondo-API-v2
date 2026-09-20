# Phase 9 step 6 — business answers to Q-P9-A (C91), Q-P9-5, Q-P9-6

**Author:** `business-analyst` · 2026-09-15 · branch `feat/phase-9-cutover` · **not committed by me**
**Scope:** read-only. No code, plan or design edits. `fondodev` read with
`SET default_transaction_read_only = on` on every session; no test suite and no proof script run.
Process check before any DB work: `ps -eo comm,args` filtered on name showed no `jest`, no `npm`,
no `node` app and no `manage.py` / `celery` process (only VS Code helpers).

**Verdict: Concerns** — two of the three questions are settled by evidence; **C91 needs one
operator decision**, and my measurements add **one adjacent blocking question the plan does not
yet ask** (§1.5).

---

## 1. Q-P9-A / C91 — the `keys` object reorders on the SQS wire

### 1.1 What consumes the queue — plainly, what I can and cannot know

**Can know, from the two repos:**

* The consumer is **out of both repositories**. v1 publishes and stops:
  `fondo_api/celery/tasks.py:13-24` does `sqs_client.send_message(QueueUrl=…,
  MessageBody=json.dumps(message['content']))` and logs. Nothing reads the queue in v1 or v2.
* Its history names it. Before `27e8551` ("send notifications to queue to be read by lambda
  function", #91, 2023-10-20) the same function **POSTed to `http://$MNS_HOST:9901/mns/send`**
  and consumed a JSON response `{"invalid": [...]}` to delete dead subscriptions. #91 replaced
  that call with SQS and **deleted the response handling**. So the consumer is the same "MNS"
  web-push component, now behind a Lambda, and its source lives in neither repo.
* `CONTEXT.md:254-256` says the same: "an external Lambda does the actual Web Push".
* The body carries **only** `{"subscriptions": [...], "message": {"body", "target"}}`
  (`services/notification.py:41-46`; v2 `src/notifications/notification-publisher.ts`). No
  `owner_id`, no ids, no auth material of ours.
* **Nothing in either repo hashes, signs, dedupes or byte-compares that body.** Grep for
  `md5|hmac|sha256|signature|MessageGroupId|MessageDeduplicationId|FIFO|MessageAttributes` across
  `src/` and `fondo_api/` returns only password hashing and unrelated prose. v2 sends
  `new SendMessageCommand({ QueueUrl, MessageBody })` and nothing else.
* The queue is therefore a **standard** queue, not FIFO: FIFO `SendMessage` requires
  `MessageGroupId`, v1 sends none, and v1 delivers today. So no content-based deduplication hash
  is computed over the body by SQS itself.
* **v1 no longer prunes dead subscriptions.** `__remove_invalid_subscriptions`
  (`celery/tasks.py:26`) has **zero call sites** since #91 (grep, whole repo). Live shape agrees:
  94 rows over 13 members, **64 of them on user 2** — what "nobody prunes" looks like.

**Cannot know, from these two repos:** the Lambda's source, its language, its web-push library,
whether it logs/caches/persists the raw body, and — see §1.5 — whether it touches our database.
The deploy path that would name it (`scripts/trigger-deploy.sh` → SSM) is out-of-repo too.

### 1.2 Does anything plausibly depend on key order?

* **Web push crypto does not.** RFC 8291 consumes `p256dh` (the client public key) and `auth`
  (a 16-byte secret) **as values** into HKDF; RFC 8292 VAPID signs its own JWT (`aud/exp/sub`),
  not our message. Neither signs or hashes the subscription's JSON rendering. v1's *own*
  pre-SQS flow did nothing of the kind either — it POSTed the same JSON and read a list back.
* **Measured on the values themselves:** all 94 `p256dh` are 87 chars, all 94 `auth` are 22
  chars, **94/94 match `^[A-Za-z0-9_=-]+$`** — plain base64url. There is no structure in them
  for an order-sensitive parser to exploit.
* **Stored order, re-measured by me today** (independent of `nestjs-reviewer`'s run):
  **94/94** rows match `{'p256dh': '…', 'auth': '…'}`, **0/94** contain a `"`, **1** distinct
  length (135). `SELECT '{"p256dh":"P","auth":"A"}'::jsonb::text` → `{"auth": "A", "p256dh": "P"}`.
  So the reorder is real and total: **100 % of push messages change bytes at step 6**.
  Top-level order (`keys, endpoint, expirationTime`) is unaffected — 4 < 8 < 14 under both
  hstore's and jsonb's `(length, bytes)` rule, which is what the proof's `keyorder` PASS covers.
* **The remaining, unfalsifiable-from-here risk** is a consumer that string-matches, caches or
  de-duplicates on the serialized subscription. I cannot exclude it without the Lambda.

### 1.3 The business impact if the Lambda does care

**Silent.** v1's publish is fire-and-forget (the `except` swallows everything), there is no
delivery receipt, and the dead-subscription feedback loop was removed in #91. If the Lambda
rejected the reordered body, **members simply stop receiving push notifications** — birthday
announcements and, more seriously for the treasurer, the **T-5d / T-1d loan payment reminders** —
and the first signal would be a member mentioning it weeks later. Email (SES) is unaffected, so
nothing loud breaks.

### 1.4 Recommendation — **preserve `p256dh, auth` explicitly in Release B**

Route the mechanism to `nestjs-developer`; the business position is:

1. **It is the no-change option across the one-way door.** Every other wire-format decision in
   this migration was held to "v2 emits what v1 emits" (§4 rules 5d and 8, the Phase 2
   round-trip cell, the 35 KB all-94-rows byte comparison in `docs/parity-phase-2.md`). Changing
   it at the single step that cannot be rolled back is the worst moment to make the exception.
2. **`p256dh, auth` is not an arbitrary pin** — it is the order the browser's own
   `PushSubscription.toJSON()` produces, which is why 94/94 live rows carry it, so the pin also
   matches every *future* subscription's natural order.
3. **After step 6 order can no longer be stored at all** — jsonb always re-sorts — so this is
   not "preserve what is in the column", it is "emit a fixed order at the publish boundary".
   That makes it a deliberate, testable one-liner rather than an emergent property, and it must
   be pinned by a cell or it will regress.
4. **Cost asymmetry.** Preserving costs one serialization step plus one test. Reordering costs
   nothing today and, if it is wrong, produces months of silent non-delivery with no alarm.

**Does the operator have to decide? Yes, but narrowly.** The evidence settles that *our* systems
do not depend on key order, and that web-push cryptography does not. It cannot settle the
Lambda's behaviour. So either:

* **(a) adopt the recommendation** — preserve `p256dh, auth` in Release B and register the
  storage-vs-wire split (storage reorders, the wire does not) as a deviation. **No Lambda source
  needed.** ← recommended; or
* **(b) the operator retrieves the Lambda's source** before step 6 and confirms it parses the
  body into a map and passes `keys` to a web-push library. If so, the reorder is safe and can be
  registered as an accepted deviation.

Either way this note records the canonical order (`p256dh` then `auth`) so it stays recoverable
after the stored order becomes unobservable.

### 1.5 ⚠️ Adjacent blocking question C91 does not ask — **does the Lambda touch our database?**

Step 6 breaks **any** out-of-repo reader or writer of the two converted columns, not just v1 and
Release A. The pre-#91 design had the notification component telling v1 which subscriptions to
delete, i.e. the component already reasoned about rows in `fondo_api_notificationsubscriptions`.
Evidence that it does **not** write today: v1's pruning path is dead and dead subscriptions have
accumulated (64 on one member). That is suggestive, not conclusive — I cannot see the Lambda.

**Operator question, before step 6:** *does the web-push Lambda (or any other out-of-repo job)
connect to this database and read or write `fondo_api_notificationsubscriptions` or
`fondo_api_schedulertask`?* If yes, it needs its own release step in the runbook, on the jsonb
side of the door.

---

## 2. Q-P9-5 — `owner_id` stays the string `"53"`. **Confirmed. Keep it a string.**

**Measured on `fondodev` today:** 626 payload rows; **626/626** `owner_id` match `^[0-9]+$`;
153 distinct values; range 1–457; **0** with a leading zero.

**One correction to the question's premise:** `owner_id` **never reaches the SQS body.** The
executer publishes only `user_ids`, `message` and `target`
(`fondo_api/scheduler/executers/notification_executer.py:10-17`), and the body is
`{subscriptions, message:{body,target}}`. So the format is **internal to the fund's database**:
its only consumers are the same-day dedupe (`schedule_notification`) and
`remove_sch_notitfications`, plus v2's D39/D49 inactive-owner check. No external system has an
opinion, which removes the only party who could want a number.

**Why a number would be a business regression, not a tidy-up:**

* Both writers and both readers compare it as **text** today — Django's `KeyTransform` on an
  `HStoreField` is `output_field = TextField()`, and v2 mirrors that
  (`src/scheduler/scheduler-task.repository.ts:199,294`). A type change means **every** dedupe
  and delete site must change in lockstep. If any row or any writer stays on the other type, the
  two failure modes are both member-visible: dedupe misses → **a member gets the same payment
  reminder or birthday push twice in one day**; `remove_sch_notitfications` misses → **a member
  keeps getting reminders for a loan that is already paid or closed**.
* `owner_id` is **overloaded**, so a numeric type would imply an entity it does not have.
  Measured: `type = 'birthdate'` (86 rows) → owner is a **member id** (1–15);
  `type = 'payment_reminder'` (540 rows) → owner is a **loan id** (53–457), and **540/540** join
  to `fondo_api_loan` and match their own `target = '/loan/<id>'`.

**Who might want otherwise:** only future v2 code wanting a typed payload. That is a normal,
reversible, post-cutover change with a backfill — it must not ride on the one-way door.
`hstore_to_jsonb` **strict** (not `_loose`) with post-condition (c) is the right choice.

---

## 3. Q-P9-6 — the preflight **stops** on a `keys` value containing a `"`. **Stopping is right.**

**Measured:** 0 of 94 today, and the values are plain base64url (§1.2), so a `"` **cannot occur
in a legitimate `p256dh` or `auth`**. Its presence means the row did not come from Django's repr
path — a manual edit, a different writer, or corruption.

**Why "convert and record" is worse here:**

* v1's decode is the blunt `keys.replace("'", '"')`. On a value already containing `"` that
  repair can produce **valid-but-wrong JSON** (silently wrong key material → that device's push
  fails forever, with no error anywhere, per §1.3) or **invalid JSON** — and in v1 invalid JSON
  raises inside `send_notification`, so **every recipient in that batch loses the notification**,
  not just the bad row. Neither outcome has ever been measured.
* Conversion is **permanent**: whatever the repair produced becomes the stored jsonb value. A
  silent auto-repair at the one-way door is exactly the class of change this project refuses
  everywhere else.
* The cost of stopping is small and bounded: a readable `P0001` naming the row, **nothing
  changed**, re-runnable at will, inside a planned outage that has already quiesced the writers.

**Business guidance to put beside the stop** (so the operator is not stranded mid-outage): the
cheap resolution is to **delete the offending subscription row**. A push subscription is not
fund data — no money, no history, no audit value; the member's browser re-registers it and the
worst case is that one device misses notifications until then. Deleting one row is strictly safer
than hand-repairing key material nobody can validate. ⚠️ One check the operator owns: the PWA
front-end is out of repo, so **confirm it calls `POST /api/notification/subscribe` on load**; if
it only subscribes on an explicit opt-in, the member must re-enable notifications manually and
should be told.

---

## 4. What needs the operator

| # | Question | Blocking? |
|---|---|---|
| 1 | **C91:** adopt (a) preserve `p256dh, auth` in Release B *(recommended, needs no Lambda source)*, or (b) produce the Lambda's source and accept the reorder. | 🔴 **before step 6** |
| 2 | **New (§1.5):** does the web-push Lambda — or any out-of-repo job — read/write `fondo_api_notificationsubscriptions` or `fondo_api_schedulertask` directly? | 🔴 **before step 6** |
| 3 | Does the PWA re-subscribe on load? Decides whether "delete the row" is a safe Q-P9-6 resolution. | 🟡 before step 6 |

Q-P9-5 and Q-P9-6 need **no** operator input: the evidence settles both.

---

## 5. Measurements in this note

All on `fondodev`, `SET default_transaction_read_only = on`, 2026-09-15.

| claim | check |
|---|---|
| 94/94 stored as `{'p256dh': …, 'auth': …}`, 0/94 contain `"`, 1 distinct length (135) | `strpos` comparison + `LIKE` filters over `subscription->'keys'` |
| `p256dh` 87 chars, `auth` 22 chars, 94/94 `^[A-Za-z0-9_=-]+$` | `substring(... from '''p256dh'': ''([^'']*)''')` + regex filter |
| jsonb renders the nested object `{"auth": …, "p256dh": …}` | `SELECT '{"p256dh":"P","auth":"A"}'::jsonb::text` |
| endpoints: 93 `fcm.googleapis.com`, 1 `web.push.apple.com` | `split_part` group-by |
| 94 rows over 13 members, 64 on user 2 | group-by `user_id` |
| 626/626 `owner_id` `^[0-9]+$`, 153 distinct, 1–457, 0 leading zeros | regex + cast aggregates |
| birthdate 86 rows owner 1–15; payment_reminder 540 rows owner 53–457, 540/540 join `fondo_api_loan` and match their own `/loan/<id>` target | group-by + join |
| `__remove_invalid_subscriptions` has 0 call sites; the MNS HTTP response handling was deleted in `27e8551` | repo-wide grep; `git show 27e8551^:fondo_api/celery/tasks.py` |
| no hashing/signing/FIFO on the SQS path in either repo | grep `md5\|hmac\|sha256\|signature\|MessageGroupId\|MessageDeduplicationId\|FIFO\|MessageAttributes` over `src/` and `fondo_api/` |
