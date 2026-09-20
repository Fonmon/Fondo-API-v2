#!/usr/bin/env bash
# fixture-check.sh — is `fondodev` at baseline?
#
# ⚠️ **Counts alone was false-green #22**: they matched while sequences were off by four and
# `xmin` cardinality had doubled. A baseline is **counts AND sequences AND `xmin` cardinality**,
# so this prints all three and you diff the whole output against a saved run.
#
#   ./fixture-check.sh > /tmp/before.txt      # before the phase's first write
#   ...                                        # do the round
#   ./fixture-check.sh > /tmp/after.txt
#   diff -q /tmp/before.txt /tmp/after.txt && echo AT_BASELINE || echo DRIFT
#
# ⚠️ **And give it a positive control** (rule C67 — a check that can only say "nothing found"
# is not a check). The cheapest one needs no writes at all: run it against the empty test
# database and confirm the output *differs*.
#
#   ./fixture-check.sh | sed 's/-d fondodev/-d fondo_api_test/' ...   # see README, or:
#   DB=fondo_api_test ./fixture-check.sh > /tmp/control.txt
#   diff -q /tmp/before.txt /tmp/control.txt && echo 'CONTROL FAILED — probe is blind'
#
# ⚠️ Phase 8 added `fondo_api_file` (count, maxid, xmin). Until then this script had no row for
# that table, so a Phase 8 write would have been invisible to it except through its sequence.
# The baseline saved before that change has no file rows; diff against the one saved with it.
#
# `xmin` cardinality is the part that catches a write-then-restore: a table whose rows were
# all inserted by one transaction reads 1, and any later UPDATE or INSERT raises it, even if
# the row count comes back to where it started.
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-fondo}"
PGH="${PGH:-localhost}"; PGU="${PGU:-fondouser}"; DB="${DB:-fondodev}"

psql -h "$PGH" -U "$PGU" -d "$DB" -At -F'|' <<'SQL'
SELECT 'count', 'fondo_api_activityyear', count(*) FROM fondo_api_activityyear
UNION ALL SELECT 'count','fondo_api_activity', count(*) FROM fondo_api_activity
UNION ALL SELECT 'count','fondo_api_activityuser', count(*) FROM fondo_api_activityuser
UNION ALL SELECT 'count','fondo_api_loan', count(*) FROM fondo_api_loan
UNION ALL SELECT 'count','fondo_api_loandetail', count(*) FROM fondo_api_loandetail
UNION ALL SELECT 'count','fondo_api_schedulertask', count(*) FROM fondo_api_schedulertask
UNION ALL SELECT 'count','fondo_api_notificationsubscriptions', count(*) FROM fondo_api_notificationsubscriptions
UNION ALL SELECT 'count','auth_user', count(*) FROM auth_user
UNION ALL SELECT 'count','fondo_api_power', count(*) FROM fondo_api_power
UNION ALL SELECT 'count','fondo_api_savingaccount', count(*) FROM fondo_api_savingaccount
UNION ALL SELECT 'count','fondo_api_userprofile', count(*) FROM fondo_api_userprofile
UNION ALL SELECT 'maxid','fondo_api_notificationsubscriptions', max(id) FROM fondo_api_notificationsubscriptions
UNION ALL SELECT 'maxid','fondo_api_schedulertask', max(id) FROM fondo_api_schedulertask
UNION ALL SELECT 'keyact_null','fondo_api_userprofile', count(*) FROM fondo_api_userprofile WHERE key_activation IS NULL
UNION ALL SELECT 'xmin','fondo_api_schedulertask', count(DISTINCT xmin::text) FROM fondo_api_schedulertask
UNION ALL SELECT 'xmin','fondo_api_notificationsubscriptions', count(DISTINCT xmin::text) FROM fondo_api_notificationsubscriptions
UNION ALL SELECT 'xmin','fondo_api_loan', count(DISTINCT xmin::text) FROM fondo_api_loan
UNION ALL SELECT 'xmin','fondo_api_loandetail', count(DISTINCT xmin::text) FROM fondo_api_loandetail
UNION ALL SELECT 'xmin','auth_user', count(DISTINCT xmin::text) FROM auth_user
UNION ALL SELECT 'xmin','fondo_api_userprofile', count(DISTINCT xmin::text) FROM fondo_api_userprofile
UNION ALL SELECT 'xmin','fondo_api_activity', count(DISTINCT xmin::text) FROM fondo_api_activity
UNION ALL SELECT 'xmin','fondo_api_activityuser', count(DISTINCT xmin::text) FROM fondo_api_activityuser
UNION ALL SELECT 'xmin','fondo_api_power', count(DISTINCT xmin::text) FROM fondo_api_power
UNION ALL SELECT 'count','fondo_api_file', count(*) FROM fondo_api_file
UNION ALL SELECT 'maxid','fondo_api_file', max(id) FROM fondo_api_file
UNION ALL SELECT 'xmin','fondo_api_file', count(DISTINCT xmin::text) FROM fondo_api_file
ORDER BY 1,2;
SQL

echo '--- sequences ---'
psql -h "$PGH" -U "$PGU" -d "$DB" -At -F'|' -c \
  "SELECT sequencename, last_value FROM pg_sequences WHERE schemaname='public' ORDER BY 1;"
