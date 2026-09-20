#!/usr/bin/env bash
# step6-verify.sh — the Phase 9 step-6 verification, with an exit code.
#
#   scripts/parity/step6-verify.sh preimage <file>     # run at the QUIESCE step, before the backup
#   scripts/parity/step6-verify.sh verify   <file>     # run after `migrate deploy`
#
# Replaces the eyeballed SELECTs the first draft of the runbook carried (review finding M4).
# Two things that draft got wrong and this does not:
#
#  1. **It compares against a pre-image taken from the same database**, not against literals.
#     626 and 94 are `fondodev` numbers; production's row counts are unmeasured, and a
#     verification that asserts someone else's constants either passes vacuously or fails for
#     the wrong reason.
#  2. **It exits non-zero.** A block of SELECTs an operator reads at 3am during an irreversible
#     step is not a check.
#
# Target selection is deliberate: `PGDATABASE`/`PGHOST`/`PGPORT` as usual, and the script
# prints the identity it resolved before doing anything, so the value appears in the log.
set -euo pipefail

MODE="${1:?usage: step6-verify.sh preimage|verify <file>}"
FILE="${2:?usage: step6-verify.sh preimage|verify <file>}"

TABLES=(fondo_api_schedulertask fondo_api_notificationsubscriptions)

identity() {
  psql -At -F'|' -c "SELECT 'database', current_database()
                     UNION ALL SELECT 'host', coalesce(host(inet_server_addr())::text, '<local socket>')
                     UNION ALL SELECT 'port', coalesce(inet_server_port()::text, '<local socket>')
                     UNION ALL SELECT 'server_version', current_setting('server_version')
                     ORDER BY 1"
}

case "$MODE" in
  preimage)
    echo "== step 6 pre-image =="
    identity | sed 's/^/  /'
    {
      identity
      for t in "${TABLES[@]}"; do
        psql -At -F'|' -c "SELECT 'count:$t', count(*)::text FROM $t
                           UNION ALL SELECT 'maxid:$t', coalesce(max(id)::text, '<empty>') FROM $t"
      done
      psql -At -F'|' -c "SELECT 'column:' || table_name, udt_name FROM information_schema.columns
                          WHERE (table_name, column_name) IN
                                (('fondo_api_schedulertask','payload'),
                                 ('fondo_api_notificationsubscriptions','subscription'))
                          ORDER BY 1"
      psql -At -F'|' -c "SELECT 'django_migrations', count(*)::text FROM django_migrations"
    } | sort > "$FILE"
    echo "  written to $FILE"
    cat "$FILE" | sed 's/^/  /'
    echo
    echo "PRE-IMAGE CAPTURED. Keep this file; step 6.4 compares against it."
    ;;

  verify)
    [ -f "$FILE" ] || { echo "REFUSING: no pre-image at $FILE. It is captured at the quiesce step." >&2; exit 4; }
    echo "== step 6 verification =="
    identity | sed 's/^/  /'
    echo

    fail=0
    check() { # label, actual, expected
      if [ "$2" = "$3" ]; then
        printf '  PASS  %-46s %s\n' "$1" "$2"
      else
        printf '  FAIL  %-46s got %s, expected %s\n' "$1" "$2" "$3"
        fail=1
      fi
    }
    val() { psql -At -c "$1"; }

    pre() { grep "^$1|" "$FILE" | cut -d'|' -f2-; }

    # a. same database, same server as the pre-image. A verification run against a different
    #    database than the one that was converted is the failure mode B3 is about.
    check "identity: database" "$(val "SELECT current_database()")" "$(pre database)"
    # ⚠️ review N3 — the pre-image captured `host` and nothing compared it. A verification run
    # against a same-named database on a *different* server (a restored copy, a replica, a
    # staging clone) passed the two remaining identity lines.
    check "identity: host"     "$(val "SELECT coalesce(host(inet_server_addr())::text,'<local socket>')")" "$(pre host)"
    check "identity: port"     "$(val "SELECT coalesce(inet_server_port()::text,'<local socket>')")" "$(pre port)"

    # b. both columns converted.
    check "column type: payload" \
      "$(val "SELECT udt_name FROM information_schema.columns WHERE table_name='fondo_api_schedulertask' AND column_name='payload'")" jsonb
    check "column type: subscription" \
      "$(val "SELECT udt_name FROM information_schema.columns WHERE table_name='fondo_api_notificationsubscriptions' AND column_name='subscription'")" jsonb

    # c. no row lost or gained, measured against the pre-image rather than a literal.
    for t in "${TABLES[@]}"; do
      check "row count: $t"  "$(val "SELECT count(*) FROM $t")"                 "$(pre "count:$t")"
      check "max(id): $t"    "$(val "SELECT coalesce(max(id)::text,'<empty>') FROM $t")" "$(pre "maxid:$t")"
    done

    # d. the repair pass finished, and nothing else was converted with it.
    #
    # ⚠️ On an UNCONVERTED (hstore) schema these probes error — `payload -> 'user_ids'` has no
    # jsonb meaning there — and psql returns an empty string, which reads as
    # `got , expected 0` and FAILs. That is the right direction (it is a failure), and it is
    # measured: run against an un-migrated clone the script reports 9 FAILs and exits 1.
    check "user_ids still doubly stringified" \
      "$(val "SELECT count(*) FROM fondo_api_schedulertask WHERE jsonb_typeof(payload->'user_ids')='string'")" 0
    check "user_ids present but not an array" \
      "$(val "SELECT count(*) FROM fondo_api_schedulertask WHERE payload ? 'user_ids' AND jsonb_typeof(payload->'user_ids') NOT IN ('array','null')")" 0
    check "keys not an object" \
      "$(val "SELECT count(*) FROM fondo_api_notificationsubscriptions WHERE subscription ? 'keys' AND jsonb_typeof(subscription->'keys') NOT IN ('object','null')")" 0
    # ⚠️ Omitted from the first draft (M4): every `keys` object must decode to exactly the two
    # fields the push layer reads. An object with the right type and the wrong fields passes
    # every other check here.
    check "keys whose fields are not {auth,p256dh}" \
      "$(val "SELECT count(*) FROM fondo_api_notificationsubscriptions n
               WHERE jsonb_typeof(n.subscription->'keys')='object'
                 AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(n.subscription->'keys') k)
                     <> ARRAY['auth','p256dh']")" 0
    check "non-string values outside user_ids/keys" \
      "$(val "SELECT count(*) FROM (
                SELECT 1 FROM fondo_api_schedulertask t, jsonb_each(t.payload) e
                  WHERE e.key<>'user_ids' AND jsonb_typeof(e.value) NOT IN ('string','null')
                UNION ALL
                SELECT 1 FROM fondo_api_notificationsubscriptions n, jsonb_each(n.subscription) e
                  WHERE e.key<>'keys' AND jsonb_typeof(e.value) NOT IN ('string','null')) s")" 0

    # e. ⚠️ Also omitted from the first draft: the conversion and both repair UPDATEs ran in
    #    ONE transaction, so every rewritten row carries a single xid. A cardinality above 1
    #    means something touched the table outside the migration — e.g. a writer that was not
    #    quiesced. (It is a weak probe in general — see step6-prove.sh's M6 note — but here it
    #    is being used for the one thing it does say: "one transaction wrote all of this".)
    #
    # 🔴 **This check has a shelf life — review N4.** It is only true while nothing has written
    # since the conversion. The moment Release B serves a subscribe, an unsubscribe or a
    # scheduler pass, the cardinality rises and **that is correct behaviour, not a fault**. So
    # this script is a *step 6.4* instrument, run between the migration and the Release B
    # rollout. Re-running it during a later incident will report these two lines as FAIL for a
    # healthy system; runbook §6.7 says so, and so does this comment, because an operator at
    # 3am reads the script, not the document.
    for t in "${TABLES[@]}"; do
      check "xmin cardinality: $t" "$(val "SELECT count(DISTINCT xmin::text) FROM $t")" 1
    done

    # f. D6 and D11.
    check "unique constraints created" \
      "$(val "SELECT count(*) FROM pg_constraint WHERE conname IN
               ('fondo_api_loandetail_loan_id_key','fondo_api_userfinance_user_id_key','fondo_api_userpreference_user_id_key')")" 3

    # g. the two ledgers, in the state D34 requires.
    check "0_init still applied_steps_count = 0" \
      "$(val "SELECT applied_steps_count FROM _prisma_migrations WHERE migration_name='0_init'")" 0
    check "step-6 migrations applied" \
      "$(val "SELECT count(*) FROM _prisma_migrations WHERE migration_name LIKE '2026%step6%' OR migration_name LIKE '2026%hstore_to_jsonb' OR migration_name LIKE '2026%unique%'")" 4
    check "failed migration rows" \
      "$(val "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")" 0
    check "django_migrations frozen" \
      "$(val "SELECT count(*) FROM django_migrations")" "$(pre django_migrations)"

    echo
    if [ "$fail" -eq 0 ]; then
      echo "STEP 6 VERIFICATION: PASS"
    else
      echo "STEP 6 VERIFICATION: FAIL — do NOT deploy Release B; see §6.5 of docs/phase-9-design.md"
    fi
    exit "$fail"
    ;;

  *)
    echo "usage: step6-verify.sh preimage|verify <file>" >&2; exit 2;;
esac
