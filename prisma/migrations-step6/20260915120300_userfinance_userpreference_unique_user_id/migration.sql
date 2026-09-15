-- Phase 9 — D11: the physical UNIQUE (user_id) on fondo_api_userfinance and
-- fondo_api_userpreference.
--
-- Same latent defect as D6, one table lower: v1 declares both as plain FKs while every read
-- is `.get(user_id=...)`, so a second row makes that user's finance endpoints 500 forever.
-- The application half shipped in Phase 3 (deterministic lowest-id reads, so a duplicate
-- degrades to "ignored"); this is the physical half, deferred for the same §4 rule 6 reason.
--
-- Measured read-only on fondodev 2026-09-15: 15 rows / 15 distinct user_id in each table,
-- 0 NULL. The duplicate stop condition also runs in `_step6_preflight`.
--
-- ⚠️ BEGIN/COMMIT because this file has two statements and a Prisma migration file is NOT
-- atomic by default (measured, docs/phase-9-design.md §3 M-D34-5). Both halves of D11 land
-- together or neither does. The cost is the usual masked error message: a duplicate in
-- `fondo_api_userpreference` is reported as `current transaction is aborted`, and the
-- preflight migration is where the readable version lives.

BEGIN;

ALTER TABLE "fondo_api_userfinance"
  ADD CONSTRAINT "fondo_api_userfinance_user_id_key" UNIQUE ("user_id");

ALTER TABLE "fondo_api_userpreference"
  ADD CONSTRAINT "fondo_api_userpreference_user_id_key" UNIQUE ("user_id");

COMMIT;
