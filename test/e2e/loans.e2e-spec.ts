import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { acquireApp, releaseApp, FIXTURES, adminAuth, presidentAuth } from './helpers/setup';

/**
 * Loan E2E tests — mirrors fondo_api/tests/test_loan_views.py
 *
 * Key assertions from line 418 of test_loan_views.py (test_update_loan_approved_monthly):
 *   - Approving a monthly loan (value=200, timelimit=10, disbursement_date=2017-11-09)
 *     produces total_payment=222, minimum_payment=24, payday_limit='9 dic. 2017'
 *   - The loan_table HTML is the exact string verified in the Python test at line 418
 *   - Loan detail shows disbursement_date='9 nov. 2017' (Spanish date format)
 *   - rate=0.020 (timelimit 7–12)
 *
 * Rate table: timelimit ≤6 → 0.015, ≤12 → 0.020, ≤24 → 0.022, ≤36 → 0.025
 * Days360 (US NASD): used for interest calculation.
 * Timelimit is capped at 36.
 */

/**
 * Expected loan_table for: value=200, timelimit=10, disbursement_date=2017-11-09, fee=0 (MONTHLY), rate=0.020
 * This is the exact string from test_loan_views.py line 418.
 * Verifies: days360 algorithm, Spanish date formatting, interest rounding, capital/payment calculations.
 *
 * Period breakdown (each 30 days, capital=20/period):
 *   1: balance=200, interests=4, payment=24, final=180  (9 nov→9 dic 2017)
 *   2: balance=180, interests=4, payment=24, final=160  (9 dic 2017→9 ene 2018)
 *   3: balance=160, interests=3, payment=23, final=140  (9 ene→9 feb 2018)
 *   4: balance=140, interests=3, payment=23, final=120  (9 feb→9 mar 2018)
 *   5: balance=120, interests=2, payment=22, final=100  (9 mar→9 abr 2018)
 *   6: balance=100, interests=2, payment=22, final=80   (9 abr→9 may 2018)
 *   7: balance=80,  interests=2, payment=22, final=60   (9 may→9 jun 2018)
 *   8: balance=60,  interests=1, payment=21, final=40   (9 jun→9 jul 2018)
 *   9: balance=40,  interests=1, payment=21, final=20   (9 jul→9 ago 2018)
 *  10: balance=20,  interests=0, payment=20, final=0    (9 ago→9 sept 2018)
 * total_payment = 222, minimum_payment = 24 (first), payday_limit = '9 dic. 2017' (first)
 */
const LOAN_TABLE_10_MONTHLY =
  '<table style="width:100%" border="1">' +
  '<tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr>' +
  '<tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$4</td><td>$20</td><td>9 dic. 2017</td><td>$24</td><td>$180</td></tr>' +
  '<tr><td>2</td><td>$180</td><td>9 dic. 2017</td><td>$4</td><td>$20</td><td>9 ene. 2018</td><td>$24</td><td>$160</td></tr>' +
  '<tr><td>3</td><td>$160</td><td>9 ene. 2018</td><td>$3</td><td>$20</td><td>9 feb. 2018</td><td>$23</td><td>$140</td></tr>' +
  '<tr><td>4</td><td>$140</td><td>9 feb. 2018</td><td>$3</td><td>$20</td><td>9 mar. 2018</td><td>$23</td><td>$120</td></tr>' +
  '<tr><td>5</td><td>$120</td><td>9 mar. 2018</td><td>$2</td><td>$20</td><td>9 abr. 2018</td><td>$22</td><td>$100</td></tr>' +
  '<tr><td>6</td><td>$100</td><td>9 abr. 2018</td><td>$2</td><td>$20</td><td>9 may. 2018</td><td>$22</td><td>$80</td></tr>' +
  '<tr><td>7</td><td>$80</td><td>9 may. 2018</td><td>$2</td><td>$20</td><td>9 jun. 2018</td><td>$22</td><td>$60</td></tr>' +
  '<tr><td>8</td><td>$60</td><td>9 jun. 2018</td><td>$1</td><td>$20</td><td>9 jul. 2018</td><td>$21</td><td>$40</td></tr>' +
  '<tr><td>9</td><td>$40</td><td>9 jul. 2018</td><td>$1</td><td>$20</td><td>9 ago. 2018</td><td>$21</td><td>$20</td></tr>' +
  '<tr><td>10</td><td>$20</td><td>9 ago. 2018</td><td>$0</td><td>$20</td><td>9 sept. 2018</td><td>$20</td><td>$0</td></tr>' +
  '</table>';

/**
 * Expected loan_table for: value=200, timelimit=13, fee=1 (UNIQUE), rate=0.022
 * This is the exact string from test_loan_views.py line 472.
 * days360(2017-11-09, 2018-12-09) = 390 days
 * interests = round(200 × 0.022/30 × 390) = round(57.2) = 57
 */
const LOAN_TABLE_13_UNIQUE =
  '<table style="width:100%" border="1">' +
  '<tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr>' +
  '<tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$57</td><td>$200</td><td>9 dic. 2018</td><td>$257</td><td>$0</td></tr>' +
  '</table>';

/** Fixture loan with MONTHLY fee, 10 months — matches test_post_loan_2 / test_update_loan_approved_monthly */
const LOAN_10_MONTHLY = {
  value: 200,
  timelimit: 10,
  disbursement_date: '2017-11-09',
  payment: 1, // BANK_ACCOUNT
  fee: 0,     // MONTHLY
  comments: '',
  disbursement_value: 205,
};

/** Fixture loan with MONTHLY fee, 5 months — matches test_post_loan_1 */
const LOAN_5_MONTHLY = {
  value: 100,
  timelimit: 5,
  disbursement_date: '2017-12-09',
  payment: 0, // CASH
  fee: 0,
  comments: '',
  disbursement_value: 105,
};

describe('Loans (e2e)', () => {
  let app: INestApplication;
  let server: any;

  beforeAll(async () => {
    app = await acquireApp();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await releaseApp();
  });

  // ─── POST /api/loan ──────────────────────────────────────────────────────────

  describe('POST /api/loan', () => {
    it('creates a loan (timelimit=5) → rate 0.015', async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_5_MONTHLY);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');

      // Verify stored rate via GET (mirrors test_post_loan_1)
      const get = await request(server)
        .get(`/api/loan/${res.body.id}`)
        .set(adminAuth());
      expect(get.status).toBe(200);
      expect(get.body.loan.value).toBe(100);
      expect(get.body.loan.fee).toBe(0);      // MONTHLY
      expect(get.body.loan.state).toBe(0);    // WAITING_APPROVAL
      expect(parseFloat(get.body.loan.rate)).toBeCloseTo(0.015, 3);
      expect(get.body.loan.payment).toBe(0);  // CASH
      expect(get.body.loan.disbursement_value).toBe(105);
    });

    it('creates a loan (timelimit=10) → rate 0.020', async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');

      const get = await request(server)
        .get(`/api/loan/${res.body.id}`)
        .set(adminAuth());
      expect(get.status).toBe(200);
      expect(get.body.loan.value).toBe(200);
      expect(get.body.loan.state).toBe(0);
      expect(parseFloat(get.body.loan.rate)).toBeCloseTo(0.020, 3);
      expect(get.body.loan.payment).toBe(1);  // BANK_ACCOUNT
      expect(get.body.loan.disbursement_value).toBe(205);
    });

    it('creates a loan (timelimit=20) → rate 0.022', async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send({ value: 300, timelimit: 20, disbursement_date: '2018-01-01', payment: 0, fee: 0, comments: '', disbursement_value: 305 });
      expect(res.status).toBe(201);

      const get = await request(server)
        .get(`/api/loan/${res.body.id}`)
        .set(adminAuth());
      expect(parseFloat(get.body.loan.rate)).toBeCloseTo(0.022, 3);
      expect(get.body.loan.timelimit).toBe(20);
    });

    it('creates a loan (timelimit=30) → rate 0.025', async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send({ value: 300, timelimit: 30, disbursement_date: '2018-01-01', payment: 0, fee: 0, comments: '', disbursement_value: 305 });
      expect(res.status).toBe(201);

      const get = await request(server)
        .get(`/api/loan/${res.body.id}`)
        .set(adminAuth());
      expect(parseFloat(get.body.loan.rate)).toBeCloseTo(0.025, 3);
      expect(get.body.loan.timelimit).toBe(30);
    });

    it('caps timelimit=37 → stored as 36 with rate 0.025', async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send({ value: 300, timelimit: 37, disbursement_date: '2018-01-01', payment: 0, fee: 0, comments: '', disbursement_value: 305 });
      expect(res.status).toBe(201);

      const get = await request(server)
        .get(`/api/loan/${res.body.id}`)
        .set(adminAuth());
      expect(get.body.loan.timelimit).toBe(36);
      expect(parseFloat(get.body.loan.rate)).toBeCloseTo(0.025, 3);
    });

    it('returns 406 when value exceeds available_quota', async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(presidentAuth())
        .send({ value: 999999999, timelimit: 5, disbursement_date: '2024-01-01', payment: 0, fee: 0, comments: '', disbursement_value: null });
      expect(res.status).toBe(406);
      expect(res.body.message).toBe('User does not have available quota');
    });

    it('returns 401 without auth', async () => {
      const res = await request(server)
        .post('/api/loan')
        .send(LOAN_5_MONTHLY);
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/loan ───────────────────────────────────────────────────────────

  describe('GET /api/loan', () => {
    it('returns paginated loan list for admin', async () => {
      const res = await request(server)
        .get('/api/loan?page=1')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('list');
      expect(Array.isArray(res.body.list)).toBe(true);
      expect(res.body).toHaveProperty('num_pages');
      expect(res.body).toHaveProperty('count');
    });

    it('returns 400 when page=0', async () => {
      const res = await request(server)
        .get('/api/loan?page=0')
        .set(adminAuth());
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Page number must be greater or equal than 0');
    });

    it('returns unpaginated list without page param', async () => {
      const res = await request(server)
        .get('/api/loan')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('list');
      expect(res.body).not.toHaveProperty('num_pages');
    });

    it('each loan has required fields', async () => {
      const res = await request(server)
        .get('/api/loan?page=1')
        .set(adminAuth());
      expect(res.status).toBe(200);
      const loan = res.body.list[0];
      expect(loan).toHaveProperty('id');
      expect(loan).toHaveProperty('value');
      expect(loan).toHaveProperty('timelimit');
      expect(loan).toHaveProperty('disbursement_date');
      expect(loan).toHaveProperty('fee');
      expect(loan).toHaveProperty('state');
      expect(loan).toHaveProperty('rate');
      expect(loan).toHaveProperty('user_full_name');
      expect(loan).toHaveProperty('created_at');
      expect(loan).toHaveProperty('disbursement_value');
    });

    it('returns 400 for state=5 (out of range)', async () => {
      const res = await request(server)
        .get('/api/loan?state=5')
        .set(adminAuth());
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('State must be between 0 and 4');
    });

    it('filters by state=1 (APPROVED)', async () => {
      const res = await request(server)
        .get('/api/loan?state=1')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('list');
      res.body.list.forEach((loan: any) => {
        expect(loan.state).toBe(1);
      });
    });

    it('returns 401 without auth', async () => {
      const res = await request(server).get('/api/loan');
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/loan/:id ───────────────────────────────────────────────────────

  describe('GET /api/loan/:id', () => {
    it('returns loan fields for state=0 (no loan_detail yet)', async () => {
      // Create a loan to retrieve (state=0 WAITING_APPROVAL — no loan_detail)
      const createRes = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      expect(createRes.status).toBe(201);
      const loanId = createRes.body.id;

      const res = await request(server)
        .get(`/api/loan/${loanId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.loan.id).toBe(loanId);
      expect(res.body.loan.value).toBe(200);
      expect(res.body.loan.timelimit).toBe(10);
      // Spanish date format: babel.dates.format_date('2017-11-09', locale='es') → '9 nov. 2017'
      expect(res.body.loan.disbursement_date).toBe('9 nov. 2017');
      expect(res.body.loan.payment).toBe(1);
      expect(res.body.loan.fee).toBe(0);
      expect(res.body.loan.comments).toBe('');
      expect(res.body.loan.state).toBe(0);
      expect(parseFloat(res.body.loan.rate)).toBeCloseTo(0.020, 3);
      expect(res.body.loan.user_full_name).toBeDefined();
      expect(res.body.loan.created_at).toBeDefined();
      expect(res.body.loan.disbursement_value).toBe(205);
      // No loan_detail for non-approved state (mirrors Django get_loan)
      expect(res.body.loan_detail).toBeUndefined();
    });

    it('returns 404 for non-existent loan', async () => {
      const res = await request(server)
        .get('/api/loan/999999999')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /api/loan/:id (approve/deny) ─────────────────────────────────────

  describe('PATCH /api/loan/:id — approve monthly (mirrors test_update_loan_approved_monthly)', () => {
    /**
     * This is the critical test from line 418 of test_loan_views.py.
     *
     * Loan: value=200, timelimit=10, disbursement_date=2017-11-09, fee=0 (MONTHLY)
     * Expected after approval (state=1):
     *   total_payment  = 222   (10 × 20 capital + cumulative interests)
     *   minimum_payment = 24  (first installment: 20 capital + 4 interest)
     *   payday_limit   = '9 dic. 2017'
     *
     * Verification of days360 + date formatting:
     *   Period 1: 9 nov → 9 dic = 30 days, balance=200 → interest = round(200 × 0.020/30 × 30) = 4
     *   All 10 installments sum to 222 total.
     */
    let loanId: number;

    beforeEach(async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      expect(res.status).toBe(201);
      loanId = res.body.id;
    });

    it('approves loan: total_payment=222, minimum_payment=24, payday_limit="9 dic. 2017"', async () => {
      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });
      expect(res.status).toBe(200);
      expect(res.body.total_payment).toBe(222);
      expect(res.body.minimum_payment).toBe(24);
      expect(res.body.payday_limit).toBe('9 dic. 2017');
    });

    /**
     * THE KEY TEST — mirrors test_loan_views.py line 418
     * Verifies the exact HTML table passed to the email (loan_table field in PATCH response).
     * Validates: days360 algorithm, Intl.DateTimeFormat('es') Spanish month abbreviations,
     * interest rounding (round(balance * rate/30 * days360)), and capital/payment arithmetic.
     */
    it('loan_table matches exact HTML from test_loan_views.py line 418', async () => {
      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });
      expect(res.status).toBe(200);
      expect(res.body.loan_table).toBe(LOAN_TABLE_10_MONTHLY);
    });

    it('after approval, GET loan shows state=1 and correct loan_detail (single object)', async () => {
      await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });

      const res = await request(server)
        .get(`/api/loan/${loanId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.loan.state).toBe(1);
      expect(res.body.loan.value).toBe(200);
      expect(res.body.loan.timelimit).toBe(10);
      // Spanish date format matches Django: babel.dates.format_date(date, locale='es')
      expect(res.body.loan.disbursement_date).toBe('9 nov. 2017');
      expect(res.body.loan.payment).toBe(1);
      expect(res.body.loan.fee).toBe(0);
      expect(res.body.loan.comments).toBe('');
      expect(parseFloat(res.body.loan.rate)).toBeCloseTo(0.020, 3);
      expect(res.body.loan.created_at).toBeDefined();
      // loan_detail is a single object (not array) — mirrors Django LoanDetailSerializer
      expect(res.body.loan_detail).toBeDefined();
      expect(res.body.loan_detail.total_payment).toBe(222);
      expect(res.body.loan_detail.minimum_payment).toBe(24);
      expect(res.body.loan_detail.payday_limit).toBe('9 dic. 2017');
      expect(res.body.loan_detail.from_date).toBe('9 nov. 2017');
    });
  });

  describe('PATCH /api/loan/:id — approve unique payment (mirrors test_update_loan_approved_unique)', () => {
    /**
     * Loan: value=200, timelimit=13, fee=1 (UNIQUE — single payment)
     * Expected:
     *   total_payment  = 257  (200 capital + 57 interest for 13 months)
     *   minimum_payment = 257 (same — single payment)
     *   payday_limit   = '9 dic. 2018'
     *
     * days360(2017-11-09, 2018-12-09) = 390 days
     * interest = round(200 × 0.022/30 × 390) = round(57.2) = 57
     * rate = 0.022 (timelimit=13, 12 < 13 ≤ 24)
     */
    let loanId: number;

    beforeEach(async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send({ ...LOAN_10_MONTHLY, fee: 1, timelimit: 13 });
      expect(res.status).toBe(201);
      loanId = res.body.id;
    });

    it('approves unique loan: total_payment=257, minimum_payment=257, payday_limit="9 dic. 2018"', async () => {
      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });
      expect(res.status).toBe(200);
      expect(res.body.total_payment).toBe(257);
      expect(res.body.minimum_payment).toBe(257);
      expect(res.body.payday_limit).toBe('9 dic. 2018');
    });

    /**
     * Mirrors test_loan_views.py line 472 — exact HTML table for single-payment loan.
     * days360(2017-11-09, 2018-12-09) = 390 days
     * interests = round(200 × 0.022/30 × 390) = round(57.2) = 57
     */
    it('loan_table matches exact HTML from test_loan_views.py line 472 (unique fee)', async () => {
      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });
      expect(res.status).toBe(200);
      expect(res.body.loan_table).toBe(LOAN_TABLE_13_UNIQUE);
    });

    it('after approval, GET loan shows rate=0.022 and single loan_detail', async () => {
      await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });

      const res = await request(server)
        .get(`/api/loan/${loanId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.loan.state).toBe(1);
      expect(res.body.loan.timelimit).toBe(13);
      expect(res.body.loan.fee).toBe(1);
      expect(parseFloat(res.body.loan.rate)).toBeCloseTo(0.022, 3);
      expect(res.body.loan_detail.total_payment).toBe(257);
      expect(res.body.loan_detail.minimum_payment).toBe(257);
      expect(res.body.loan_detail.payday_limit).toBe('9 dic. 2018');
    });
  });

  describe('PATCH /api/loan/:id — deny (mirrors test_update_loan_denied)', () => {
    let loanId: number;

    beforeEach(async () => {
      const res = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      expect(res.status).toBe(201);
      loanId = res.body.id;
    });

    it('denies loan → state=2, returns 200', async () => {
      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 2 });
      expect(res.status).toBe(200);

      const get = await request(server)
        .get(`/api/loan/${loanId}`)
        .set(adminAuth());
      expect(get.body.loan.state).toBe(2);
    });
  });

  describe('PATCH /api/loan/:id — state transitions', () => {
    it('returns 400 for state=5 (out of range)', async () => {
      const createRes = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      const loanId = createRes.body.id;

      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 5 });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('State must be less or equal than 3');
    });

    it('returns 404 for non-existent loan', async () => {
      const res = await request(server)
        .patch('/api/loan/999999999')
        .set(adminAuth())
        .send({ state: 2 });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Loan does not exist');
    });

    it('transitions to PAID_OUT (state=3)', async () => {
      const createRes = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      const loanId = createRes.body.id;

      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 3 });
      expect(res.status).toBe(200);

      const get = await request(server)
        .get(`/api/loan/${loanId}`)
        .set(adminAuth());
      expect(get.body.loan.state).toBe(3);
    });

    it('returns 403 for president (only admin/treasurer can update state)', async () => {
      const createRes = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      const loanId = createRes.body.id;

      const res = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(presidentAuth())
        .send({ state: 2 });
      expect(res.status).toBe(403);
    });
  });

  // ─── POST /api/loan/:id/paymentProjection ────────────────────────────────────

  describe('POST /api/loan/:id/paymentProjection (mirrors test_payment_projection)', () => {
    /**
     * Loan: value=200, timelimit=10, disbursement_date=2017-11-09
     * After approval, payment projection:
     *   to_date=2017-11-09 → interests=0,  capital_balance=200
     *   to_date=2017-11-15 → interests=1,  capital_balance=200  (6 days at 0.020/30 → round(200*0.020/30*6)=1)
     *   to_date=2017-12-09 → interests=4,  capital_balance=200  (30 days → round(200*0.020/30*30)=4)
     */
    let loanId: number;

    beforeEach(async () => {
      const createRes = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      expect(createRes.status).toBe(201);
      loanId = createRes.body.id;

      const approveRes = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });
      expect(approveRes.status).toBe(200);
    });

    it('returns 400 when to_date is missing', async () => {
      const res = await request(server)
        .post(`/api/loan/${loanId}/paymentProjection`)
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 when to_date is empty string', async () => {
      const res = await request(server)
        .post(`/api/loan/${loanId}/paymentProjection`)
        .set(adminAuth())
        .send({ to_date: '' });
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent loan', async () => {
      const res = await request(server)
        .post('/api/loan/999999999/paymentProjection')
        .set(adminAuth())
        .send({ to_date: '2017-11-15' });
      expect(res.status).toBe(404);
    });

    it('to_date=2017-11-09 → interests=0, capital_balance=200', async () => {
      const res = await request(server)
        .post(`/api/loan/${loanId}/paymentProjection`)
        .set(adminAuth())
        .send({ to_date: '2017-11-09' });
      expect(res.status).toBe(200);
      expect(res.body.capital_balance).toBe(200);
      expect(res.body.interests).toBe(0);
    });

    it('to_date=2017-11-15 → interests=1, capital_balance=200', async () => {
      const res = await request(server)
        .post(`/api/loan/${loanId}/paymentProjection`)
        .set(adminAuth())
        .send({ to_date: '2017-11-15' });
      expect(res.status).toBe(200);
      expect(res.body.capital_balance).toBe(200);
      expect(res.body.interests).toBe(1);
    });

    it('to_date=2017-12-09 → interests=4, capital_balance=200', async () => {
      const res = await request(server)
        .post(`/api/loan/${loanId}/paymentProjection`)
        .set(adminAuth())
        .send({ to_date: '2017-12-09' });
      expect(res.status).toBe(200);
      expect(res.body.capital_balance).toBe(200);
      expect(res.body.interests).toBe(4);
    });
  });

  // ─── POST /api/loan/:id/refinance ────────────────────────────────────────────

  describe('POST /api/loan/:id/refinance (mirrors test_refinance_loan)', () => {
    it('returns 400 for non-existent loan', async () => {
      const res = await request(server)
        .post('/api/loan/999999999/refinance')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 when loan is not APPROVED (state=0)', async () => {
      const createRes = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      const loanId = createRes.body.id;

      const res = await request(server)
        .post(`/api/loan/${loanId}/refinance`)
        .set(adminAuth())
        .send({ disbursement_date: '2017-12-09', includeInterests: false, comments: '', timelimit: 12, fee: 0 });
      expect(res.status).toBe(400);
    });

    it('refinances an approved loan — creates new loan with correct fields', async () => {
      // Create and approve original loan
      const createRes = await request(server)
        .post('/api/loan')
        .set(adminAuth())
        .send(LOAN_10_MONTHLY);
      expect(createRes.status).toBe(201);
      const loanId = createRes.body.id;

      const approveRes = await request(server)
        .patch(`/api/loan/${loanId}`)
        .set(adminAuth())
        .send({ state: 1 });
      expect(approveRes.status).toBe(200);

      // Refinance (includeInterests=false → new value = capital_balance = 200)
      const refinanceRes = await request(server)
        .post(`/api/loan/${loanId}/refinance`)
        .set(adminAuth())
        .send({
          disbursement_date: '2017-12-09',
          includeInterests: false,
          comments: 'Suite test',
          timelimit: 12,
          fee: 0,
        });
      expect(refinanceRes.status).toBe(200);
      expect(refinanceRes.body).toHaveProperty('id');

      const newLoanId = refinanceRes.body.id;

      // Verify new loan fields (mirrors test_refinance_loan assertions)
      const newLoan = await request(server)
        .get(`/api/loan/${newLoanId}`)
        .set(adminAuth());
      expect(newLoan.status).toBe(200);
      expect(newLoan.body.loan.value).toBe(200);
      expect(newLoan.body.loan.timelimit).toBe(12);
      expect(newLoan.body.loan.payment).toBe(2); // REFINANCE
      expect(newLoan.body.loan.fee).toBe(0);
      expect(newLoan.body.loan.state).toBe(0); // WAITING_APPROVAL
      expect(parseFloat(newLoan.body.loan.rate)).toBeCloseTo(0.020, 3);
      expect(newLoan.body.loan.comments).toContain(`Refinanciación del crédito #${loanId}`);
      expect(newLoan.body.loan.comments).toContain('Suite test');
      expect(newLoan.body.loan.disbursement_date).toBe('9 dic. 2017');
    });
  });

  // ─── Unknown app endpoint ────────────────────────────────────────────────────

  describe('POST /api/loan/:id/:app — unknown app', () => {
    it('returns 404 for unknown app', async () => {
      const res = await request(server)
        .post('/api/loan/1/notFound')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /api/loan (bulk update) ──────────────────────────────────────────

  describe('PATCH /api/loan (bulk update)', () => {
    it('returns 403 for president (only admin/treasurer)', async () => {
      const res = await request(server)
        .patch('/api/loan')
        .set(presidentAuth());
      expect(res.status).toBe(403);
    });

    it('returns 400 when no file uploaded', async () => {
      const res = await request(server)
        .patch('/api/loan')
        .set(adminAuth());
      expect(res.status).toBe(400);
    });

    it('processes a TSV bulk update file', async () => {
      // First create 2 approved loans we can reference
      const createAndApprove = async () => {
        const c = await request(server)
          .post('/api/loan')
          .set(adminAuth())
          .send({ value: 50, timelimit: 5, disbursement_date: '2000-01-01', payment: 0, fee: 0, comments: '', disbursement_value: 50 });
        expect(c.status).toBe(201);
        const id = c.body.id;
        const a = await request(server)
          .patch(`/api/loan/${id}`)
          .set(adminAuth())
          .send({ state: 1 });
        expect(a.status).toBe(200);
        return id;
      };

      const id1 = await createAndApprove();
      const id2 = await createAndApprove();

      const tsv = `${id1}\t1234\t5678\t1/1/2018\t13\t24\t2/2/2018\r\n${id2}\t4321\t8765\t2/1/2018\t45\t56\t3/3/2018\r\n`;

      const res = await request(server)
        .patch('/api/loan')
        .set(adminAuth())
        .attach('file', Buffer.from(tsv), 'loans.tsv');
      expect(res.status).toBe(200);

      // Verify updated loan detail via GET
      const get1 = await request(server)
        .get(`/api/loan/${id1}`)
        .set(adminAuth());
      expect(get1.body.loan_detail.total_payment).toBe(1234);
      expect(get1.body.loan_detail.minimum_payment).toBe(5678);
      expect(get1.body.loan_detail.interests).toBe(13);
      expect(get1.body.loan_detail.capital_balance).toBe(24);
    });
  });

  // ─── Role enforcement ────────────────────────────────────────────────────────

  describe('Role enforcement', () => {
    it('returns 401 without auth on GET /api/loan', async () => {
      const res = await request(server).get('/api/loan');
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth on POST /api/loan', async () => {
      const res = await request(server).post('/api/loan').send(LOAN_5_MONTHLY);
      expect(res.status).toBe(401);
    });

    it('uses DB dump paid-out loan for stable GET test', async () => {
      const res = await request(server)
        .get(`/api/loan/${FIXTURES.loans.paidOut.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.loan.id).toBe(FIXTURES.loans.paidOut.id);
    });
  });
});
