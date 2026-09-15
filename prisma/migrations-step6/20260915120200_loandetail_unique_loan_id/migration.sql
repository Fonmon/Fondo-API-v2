-- Phase 9 — D6: the physical UNIQUE (loan_id) on fondo_api_loandetail.
--
-- v1 declares `LoanDetail.loan` as a plain FK, so re-approving a closed loan inserts a
-- SECOND detail row and `LoanDetail.objects.get(loan_id=...)` then 500s that loan
-- permanently. v2 has shipped the application half since Phase 4 (D10 blocks the transition
-- at the source, and reads are deterministic lowest-id); this is the belt-and-braces half,
-- deferred to Phase 9 because §4 rule 6 forbids v2 running migrations against a database v1
-- still shares.
--
-- Measured read-only on fondodev 2026-09-15: 374 rows, 374 distinct loan_id, 0 NULL.
-- The duplicate stop condition also runs in `_step6_preflight`, so it fires BEFORE the
-- hstore one-way door rather than after it.
--
-- One statement, so it needs no BEGIN/COMMIT: PostgreSQL reports a violation itself, with
-- the offending key, e.g.
--   ERROR: could not create unique index "fondo_api_loandetail_loan_id_key"
--   DETAIL: Key (loan_id)=(123) is duplicated.
--
-- The name is Prisma's own convention for `@unique` on a mapped field
-- (`<table>_<column>_key`), so the stage-2 schema.prisma change introduces no drift.
-- Django's non-unique index `fondo_api_loandetail_loan_id_6a9fa8c0` is deliberately left in
-- place: dropping it is a separate, reviewable decision, not a side effect of this one.

ALTER TABLE "fondo_api_loandetail"
  ADD CONSTRAINT "fondo_api_loandetail_loan_id_key" UNIQUE ("loan_id");
