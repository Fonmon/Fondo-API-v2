#!/usr/bin/env python3
"""D3 — M3's compare-and-set, exercised with a DETERMINISTIC two-connection interleaving.

⚠️ **Landed in the repo by review condition C56.** This file used to live only in
`~/.fondo-parity-harness/p4/`. It is the only artifact that has ever *demonstrated* the defect
M3's compare-and-set designs out — v1 answering 200/200, writing two `LoanDetail` rows and
sending two borrower emails for one double-clicked approve — and **Phase 9's
`UNIQUE (loan_id)` work needs to re-run it**, once before the constraint and once after.

It is kept here **verbatim**, harness dependencies and absolute paths included, because
rewriting it would make it a different probe with different evidence. To run it you need the
Phase 4 parity harness: both stacks up, `wcell`/`cmp`/`awsdec` on `sys.path`, the SES/SQS
capture running, and `fondodev` restorable (`W.restore()` is called between cells and at the
end). Loan **456** must exist and be WAITING_APPROVAL, which `W.restore()` guarantees.

The **v2-only half** of this construction is also an opt-in Jest cell that needs no harness at
all — `test/loan-race.e2e-spec.ts`, `FONDO_RACE_CELL=1 npm run test:e2e -- loan-race`. That
cell asserts one 200 and one 409, one detail row and one mail; it cannot produce the *v1*
positive control (200/200, two rows, two mails), which is what makes this script worth keeping.
"""

import sys, json, subprocess, time
sys.path.insert(0, '/home/miguel/.fondo-parity-harness/p4')
import wcell as W, cmp as C, awsdec

LOAN = 456                     # WAITING_APPROVAL, user 2
ADMIN = C.TOKENS['admin']


def curl_bg(base):
    return subprocess.Popen(
        ['curl', '-s', '--path-as-is', '-o', '/dev/stdout',
         '-w', '\n@@@STATUS=%{http_code}\n', '-X', 'PATCH', '-H', 'Host: localhost',
         '-H', 'Authorization: Token ' + ADMIN, '-H', 'Content-Type: application/json',
         '--max-time', '120', '--data-binary', '{"state": 1}',
         base + '/api/loan/%d' % LOAN],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def waiters():
    return int(W.psql("select count(*) from pg_stat_activity "
                      "where datname='fondodev' and wait_event_type='Lock' and state='active'").strip())


def cell(stack, base):
    W.restore()
    W.assert_capture_up()
    W.clear_cap(stack)

    lockers = subprocess.Popen(['psql', '-h', '127.0.0.1', '-U', 'fondouser', '-d', 'fondodev', '-At'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True)
    lockers.stdin.write("BEGIN;\nSELECT id, state FROM fondo_api_loan WHERE id=%d FOR UPDATE;\n" % LOAN)
    lockers.stdin.flush()
    time.sleep(1.0)

    a = curl_bg(base); time.sleep(1.5)
    b = curl_bg(base)

    ok, n = False, -1
    for _ in range(40):                     # up to 20 s to establish the precondition
        n = waiters()
        if n >= 2:
            ok = True
            break
        time.sleep(0.5)
    time.sleep(0.5)
    blocked = waiters()

    lockers.stdin.write("ROLLBACK;\n\\q\n"); lockers.stdin.flush()
    lockers.wait(timeout=30)

    outs = []
    for p in (a, b):
        txt = p.communicate(timeout=180)[0].decode('utf-8', 'replace')
        st = txt.rsplit('@@@STATUS=', 1)
        outs.append({'status': st[1].strip() if len(st) == 2 else '???',
                     'body': (st[0].rstrip('\n') if len(st) == 2 else txt)})
    time.sleep(3.0)

    state = W.psql("select state from fondo_api_loan where id=%d" % LOAN).strip()
    ndet = int(W.psql("select count(*) from fondo_api_loandetail where loan_id=%d" % LOAN).strip())
    ses = [x for x in awsdec.decode_all(W.read_cap(stack)) if x['kind'] == 'SES']
    return {'stack': stack, 'precondition_met': ok, 'blocked_sessions': blocked,
            'responses': outs, 'final_state': state, 'loandetail_rows': ndet,
            'ses_count': len(ses),
            'ses_subjects': sorted(x['subject'] for x in ses)}


res = {}
for stack, base in (('v1', C.V1), ('v2', C.V2)):
    r = cell(stack, base)
    res[stack] = r
    print('--- %s ---' % stack)
    print('  precondition (two sessions blocked on the row lock): %s (saw %d)'
          % ('MET' if r['precondition_met'] else '*** NOT MET — INCONCLUSIVE ***', r['blocked_sessions']))
    for i, o in enumerate(r['responses']):
        print('  request %d: %s  %s' % (i + 1, o['status'], o['body'][:120]))
    print('  final loan.state=%s   LoanDetail rows for loan %d = %d   SES mails = %d'
          % (r['final_state'], LOAN, r['loandetail_rows'], r['ses_count']))
W.restore()

print('=' * 78)
ctrl = []
ctrl.append(('the interleaving was ESTABLISHED BY THE DATABASE on both stacks '
             '(two sessions observed waiting on the lock) — not by a sleep',
             res['v1']['precondition_met'] and res['v2']['precondition_met']))
ctrl.append(('POSITIVE CONTROL — v1 loses the update: BOTH requests answer 200',
             sorted(o['status'] for o in res['v1']['responses']) == ['200', '200']))
ctrl.append(('POSITIVE CONTROL — v1 writes TWO LoanDetail rows and sends TWO mails '
             '(the corruption M3 designs out)',
             res['v1']['loandetail_rows'] == 2 and res['v1']['ses_count'] == 2))
ctrl.append(('v2: exactly one 200 and one 409',
             sorted(o['status'] for o in res['v2']['responses']) == ['200', '409']))
ctrl.append(('v2: the loser gets D9 own body',
             any(o['status'] == '409' and o['body'] == '{"message":"Invalid state transition"}'
                 for o in res['v2']['responses'])))
ctrl.append(('v2: exactly ONE LoanDetail row and ONE mail',
             res['v2']['loandetail_rows'] == 1 and res['v2']['ses_count'] == 1))
ctrl.append(('both stacks end with the loan APPROVED (state 1)',
             res['v1']['final_state'] == '1' and res['v2']['final_state'] == '1'))
for l, ok in ctrl:
    print('CONTROL %-88s %s' % (l, 'ok' if ok else '*** FAILED ***'))
json.dump(res, open('/home/miguel/.fondo-parity-harness/p4/out-d3.json', 'w'), indent=1)
