/**
 * **Captured from the running v1 stack**, not derived from v2's implementation.
 *
 * Produced by re-executing `fondo_api/services/loan.py::__generate_table` verbatim inside the
 * v1 container (`Django==2.2.27` / CPython 3.9 / `Babel==2.9.1` / `python-dateutil==2.7.5`,
 * `LANGUAGE_LOCALE='es'`) over the 16 loans below and dumping the result as JSON. The
 * generator lived in the scratchpad and its cases are reproduced in the `input` of each entry,
 * so a reviewer can regenerate the file and diff it.
 *
 * The two cases marked `v1-suite` are additionally asserted **character for character** by
 * `fondo_api/tests/test_loan_views.py:420` and `:469`, which is the independent check that the
 * generator itself is faithful.
 *
 * ⚠️ **Do not edit these strings to make a test pass.** They are the specification. If v2
 * disagrees with one, v2 is wrong — that is the whole reason the fixture is captured rather
 * than written.
 *
 * Coverage chosen for the edges the plan calls out (§3 Phase 4 "Risks"):
 * month-end and leap-day disbursement, year rollover, the 30/31 `days360` rule, a single
 * `UNIQUE` instalment, a 36-row table at the top of the rate band, real fund-scale money
 * (25 871 634 and 30 000 000 — fund-scale, chosen to bracket the live range: the largest
 * `fondo_api_loan.value` today is 30 027 501 and the largest `loandetail.capital_balance` is
 * 23 863 634. They are *not* live rows and must not be described as "the two largest"), a
 * 1-row loan, a 5-peso loan
 * whose instalments land on exact halves, and `timelimit = 0` on a `UNIQUE` loan (the one
 * shape D4's `DivisionByZero` does **not** reach).
 */
export interface AmortizationFixture {
  readonly input: {
    readonly value: number;
    readonly timelimit: number;
    readonly fee: number;
    readonly rate: string;
    readonly disbursement_date: string;
  };
  readonly table: string;
  readonly summary: {
    readonly payday_limit: string;
    readonly minimum_payment: number;
    readonly total_payment: number;
    readonly interests: number;
  };
}

export const V1_AMORTIZATION_FIXTURES: Readonly<Record<string, AmortizationFixture>> =
  Object.freeze({
    'monthly-200-10': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$4</td><td>$20</td><td>9 dic. 2017</td><td>$24</td><td>$180</td></tr><tr><td>2</td><td>$180</td><td>9 dic. 2017</td><td>$4</td><td>$20</td><td>9 ene. 2018</td><td>$24</td><td>$160</td></tr><tr><td>3</td><td>$160</td><td>9 ene. 2018</td><td>$3</td><td>$20</td><td>9 feb. 2018</td><td>$23</td><td>$140</td></tr><tr><td>4</td><td>$140</td><td>9 feb. 2018</td><td>$3</td><td>$20</td><td>9 mar. 2018</td><td>$23</td><td>$120</td></tr><tr><td>5</td><td>$120</td><td>9 mar. 2018</td><td>$2</td><td>$20</td><td>9 abr. 2018</td><td>$22</td><td>$100</td></tr><tr><td>6</td><td>$100</td><td>9 abr. 2018</td><td>$2</td><td>$20</td><td>9 may. 2018</td><td>$22</td><td>$80</td></tr><tr><td>7</td><td>$80</td><td>9 may. 2018</td><td>$2</td><td>$20</td><td>9 jun. 2018</td><td>$22</td><td>$60</td></tr><tr><td>8</td><td>$60</td><td>9 jun. 2018</td><td>$1</td><td>$20</td><td>9 jul. 2018</td><td>$21</td><td>$40</td></tr><tr><td>9</td><td>$40</td><td>9 jul. 2018</td><td>$1</td><td>$20</td><td>9 ago. 2018</td><td>$21</td><td>$20</td></tr><tr><td>10</td><td>$20</td><td>9 ago. 2018</td><td>$0</td><td>$20</td><td>9 sept. 2018</td><td>$20</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2017-12-09',
        minimum_payment: 24,
        total_payment: 222,
        interests: 4,
      },
      input: {
        value: 200,
        timelimit: 10,
        fee: 0,
        rate: '0.020',
        disbursement_date: '2017-11-09',
      },
    },
    'unique-200-13': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$57</td><td>$200</td><td>9 dic. 2018</td><td>$257</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2018-12-09',
        minimum_payment: 257,
        total_payment: 257,
        interests: 57,
      },
      input: {
        value: 200,
        timelimit: 13,
        fee: 1,
        rate: '0.022',
        disbursement_date: '2017-11-09',
      },
    },
    'monthly-3000-12': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$3.000</td><td>15 jun. 2020</td><td>$60</td><td>$250</td><td>15 jul. 2020</td><td>$310</td><td>$2.750</td></tr><tr><td>2</td><td>$2.750</td><td>15 jul. 2020</td><td>$55</td><td>$250</td><td>15 ago. 2020</td><td>$305</td><td>$2.500</td></tr><tr><td>3</td><td>$2.500</td><td>15 ago. 2020</td><td>$50</td><td>$250</td><td>15 sept. 2020</td><td>$300</td><td>$2.250</td></tr><tr><td>4</td><td>$2.250</td><td>15 sept. 2020</td><td>$45</td><td>$250</td><td>15 oct. 2020</td><td>$295</td><td>$2.000</td></tr><tr><td>5</td><td>$2.000</td><td>15 oct. 2020</td><td>$40</td><td>$250</td><td>15 nov. 2020</td><td>$290</td><td>$1.750</td></tr><tr><td>6</td><td>$1.750</td><td>15 nov. 2020</td><td>$35</td><td>$250</td><td>15 dic. 2020</td><td>$285</td><td>$1.500</td></tr><tr><td>7</td><td>$1.500</td><td>15 dic. 2020</td><td>$30</td><td>$250</td><td>15 ene. 2021</td><td>$280</td><td>$1.250</td></tr><tr><td>8</td><td>$1.250</td><td>15 ene. 2021</td><td>$25</td><td>$250</td><td>15 feb. 2021</td><td>$275</td><td>$1.000</td></tr><tr><td>9</td><td>$1.000</td><td>15 feb. 2021</td><td>$20</td><td>$250</td><td>15 mar. 2021</td><td>$270</td><td>$750</td></tr><tr><td>10</td><td>$750</td><td>15 mar. 2021</td><td>$15</td><td>$250</td><td>15 abr. 2021</td><td>$265</td><td>$500</td></tr><tr><td>11</td><td>$500</td><td>15 abr. 2021</td><td>$10</td><td>$250</td><td>15 may. 2021</td><td>$260</td><td>$250</td></tr><tr><td>12</td><td>$250</td><td>15 may. 2021</td><td>$5</td><td>$250</td><td>15 jun. 2021</td><td>$255</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2020-07-15',
        minimum_payment: 310,
        total_payment: 3390,
        interests: 60,
      },
      input: {
        value: 3000,
        timelimit: 12,
        fee: 0,
        rate: '0.020',
        disbursement_date: '2020-06-15',
      },
    },
    'monthend-400-4': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$400</td><td>31 ene. 2018</td><td>$6</td><td>$100</td><td>28 feb. 2018</td><td>$106</td><td>$300</td></tr><tr><td>2</td><td>$300</td><td>28 feb. 2018</td><td>$4</td><td>$100</td><td>31 mar. 2018</td><td>$104</td><td>$200</td></tr><tr><td>3</td><td>$200</td><td>31 mar. 2018</td><td>$3</td><td>$100</td><td>30 abr. 2018</td><td>$103</td><td>$100</td></tr><tr><td>4</td><td>$100</td><td>30 abr. 2018</td><td>$1</td><td>$100</td><td>31 may. 2018</td><td>$101</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2018-02-28',
        minimum_payment: 106,
        total_payment: 415,
        interests: 6,
      },
      input: {
        value: 400,
        timelimit: 4,
        fee: 0,
        rate: '0.015',
        disbursement_date: '2018-01-31',
      },
    },
    'yearend-300-3': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$300</td><td>30 nov. 2017</td><td>$4</td><td>$100</td><td>30 dic. 2017</td><td>$104</td><td>$200</td></tr><tr><td>2</td><td>$200</td><td>30 dic. 2017</td><td>$3</td><td>$100</td><td>30 ene. 2018</td><td>$103</td><td>$100</td></tr><tr><td>3</td><td>$100</td><td>30 ene. 2018</td><td>$1</td><td>$100</td><td>28 feb. 2018</td><td>$101</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2017-12-30',
        minimum_payment: 104,
        total_payment: 309,
        interests: 4,
      },
      input: {
        value: 300,
        timelimit: 3,
        fee: 0,
        rate: '0.015',
        disbursement_date: '2017-11-30',
      },
    },
    'leap-1000-13': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$1.000</td><td>31 dic. 2019</td><td>$22</td><td>$77</td><td>31 ene. 2020</td><td>$99</td><td>$923</td></tr><tr><td>2</td><td>$923</td><td>31 ene. 2020</td><td>$20</td><td>$77</td><td>29 feb. 2020</td><td>$97</td><td>$846</td></tr><tr><td>3</td><td>$846</td><td>29 feb. 2020</td><td>$19</td><td>$77</td><td>31 mar. 2020</td><td>$96</td><td>$769</td></tr><tr><td>4</td><td>$769</td><td>31 mar. 2020</td><td>$17</td><td>$77</td><td>30 abr. 2020</td><td>$94</td><td>$692</td></tr><tr><td>5</td><td>$692</td><td>30 abr. 2020</td><td>$15</td><td>$77</td><td>31 may. 2020</td><td>$92</td><td>$615</td></tr><tr><td>6</td><td>$615</td><td>31 may. 2020</td><td>$14</td><td>$77</td><td>30 jun. 2020</td><td>$90</td><td>$538</td></tr><tr><td>7</td><td>$538</td><td>30 jun. 2020</td><td>$12</td><td>$77</td><td>31 jul. 2020</td><td>$89</td><td>$462</td></tr><tr><td>8</td><td>$462</td><td>31 jul. 2020</td><td>$10</td><td>$77</td><td>31 ago. 2020</td><td>$87</td><td>$385</td></tr><tr><td>9</td><td>$385</td><td>31 ago. 2020</td><td>$8</td><td>$77</td><td>30 sept. 2020</td><td>$85</td><td>$308</td></tr><tr><td>10</td><td>$308</td><td>30 sept. 2020</td><td>$7</td><td>$77</td><td>31 oct. 2020</td><td>$84</td><td>$231</td></tr><tr><td>11</td><td>$231</td><td>31 oct. 2020</td><td>$5</td><td>$77</td><td>30 nov. 2020</td><td>$82</td><td>$154</td></tr><tr><td>12</td><td>$154</td><td>30 nov. 2020</td><td>$3</td><td>$77</td><td>31 dic. 2020</td><td>$80</td><td>$77</td></tr><tr><td>13</td><td>$77</td><td>31 dic. 2020</td><td>$2</td><td>$77</td><td>31 ene. 2021</td><td>$79</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2020-01-31',
        minimum_payment: 99,
        total_payment: 1153,
        interests: 22,
      },
      input: {
        value: 1000,
        timelimit: 13,
        fee: 0,
        rate: '0.022',
        disbursement_date: '2019-12-31',
      },
    },
    'big-25871634-36': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$25.871.634</td><td>29 feb. 2024</td><td>$625.231</td><td>$718.656</td><td>29 mar. 2024</td><td>$1.343.888</td><td>$25.152.977</td></tr><tr><td>2</td><td>$25.152.977</td><td>29 mar. 2024</td><td>$628.824</td><td>$718.656</td><td>29 abr. 2024</td><td>$1.347.481</td><td>$24.434.321</td></tr><tr><td>3</td><td>$24.434.321</td><td>29 abr. 2024</td><td>$610.858</td><td>$718.656</td><td>29 may. 2024</td><td>$1.329.515</td><td>$23.715.664</td></tr><tr><td>4</td><td>$23.715.664</td><td>29 may. 2024</td><td>$592.892</td><td>$718.656</td><td>29 jun. 2024</td><td>$1.311.548</td><td>$22.997.008</td></tr><tr><td>5</td><td>$22.997.008</td><td>29 jun. 2024</td><td>$574.925</td><td>$718.656</td><td>29 jul. 2024</td><td>$1.293.582</td><td>$22.278.351</td></tr><tr><td>6</td><td>$22.278.351</td><td>29 jul. 2024</td><td>$556.959</td><td>$718.656</td><td>29 ago. 2024</td><td>$1.275.615</td><td>$21.559.695</td></tr><tr><td>7</td><td>$21.559.695</td><td>29 ago. 2024</td><td>$538.992</td><td>$718.656</td><td>29 sept. 2024</td><td>$1.257.649</td><td>$20.841.038</td></tr><tr><td>8</td><td>$20.841.038</td><td>29 sept. 2024</td><td>$521.026</td><td>$718.656</td><td>29 oct. 2024</td><td>$1.239.682</td><td>$20.122.382</td></tr><tr><td>9</td><td>$20.122.382</td><td>29 oct. 2024</td><td>$503.060</td><td>$718.656</td><td>29 nov. 2024</td><td>$1.221.716</td><td>$19.403.725</td></tr><tr><td>10</td><td>$19.403.725</td><td>29 nov. 2024</td><td>$485.093</td><td>$718.656</td><td>29 dic. 2024</td><td>$1.203.750</td><td>$18.685.069</td></tr><tr><td>11</td><td>$18.685.069</td><td>29 dic. 2024</td><td>$467.127</td><td>$718.656</td><td>29 ene. 2025</td><td>$1.185.783</td><td>$17.966.412</td></tr><tr><td>12</td><td>$17.966.412</td><td>29 ene. 2025</td><td>$434.188</td><td>$718.656</td><td>28 feb. 2025</td><td>$1.152.845</td><td>$17.247.756</td></tr><tr><td>13</td><td>$17.247.756</td><td>28 feb. 2025</td><td>$416.821</td><td>$718.656</td><td>29 mar. 2025</td><td>$1.135.477</td><td>$16.529.099</td></tr><tr><td>14</td><td>$16.529.099</td><td>29 mar. 2025</td><td>$413.227</td><td>$718.656</td><td>29 abr. 2025</td><td>$1.131.884</td><td>$15.810.443</td></tr><tr><td>15</td><td>$15.810.443</td><td>29 abr. 2025</td><td>$395.261</td><td>$718.656</td><td>29 may. 2025</td><td>$1.113.918</td><td>$15.091.786</td></tr><tr><td>16</td><td>$15.091.786</td><td>29 may. 2025</td><td>$377.295</td><td>$718.656</td><td>29 jun. 2025</td><td>$1.095.951</td><td>$14.373.130</td></tr><tr><td>17</td><td>$14.373.130</td><td>29 jun. 2025</td><td>$359.328</td><td>$718.656</td><td>29 jul. 2025</td><td>$1.077.985</td><td>$13.654.473</td></tr><tr><td>18</td><td>$13.654.473</td><td>29 jul. 2025</td><td>$341.362</td><td>$718.656</td><td>29 ago. 2025</td><td>$1.060.018</td><td>$12.935.817</td></tr><tr><td>19</td><td>$12.935.817</td><td>29 ago. 2025</td><td>$323.395</td><td>$718.656</td><td>29 sept. 2025</td><td>$1.042.052</td><td>$12.217.160</td></tr><tr><td>20</td><td>$12.217.160</td><td>29 sept. 2025</td><td>$305.429</td><td>$718.656</td><td>29 oct. 2025</td><td>$1.024.086</td><td>$11.498.504</td></tr><tr><td>21</td><td>$11.498.504</td><td>29 oct. 2025</td><td>$287.463</td><td>$718.656</td><td>29 nov. 2025</td><td>$1.006.119</td><td>$10.779.847</td></tr><tr><td>22</td><td>$10.779.847</td><td>29 nov. 2025</td><td>$269.496</td><td>$718.656</td><td>29 dic. 2025</td><td>$988.153</td><td>$10.061.191</td></tr><tr><td>23</td><td>$10.061.191</td><td>29 dic. 2025</td><td>$251.530</td><td>$718.656</td><td>29 ene. 2026</td><td>$970.186</td><td>$9.342.534</td></tr><tr><td>24</td><td>$9.342.534</td><td>29 ene. 2026</td><td>$225.778</td><td>$718.656</td><td>28 feb. 2026</td><td>$944.434</td><td>$8.623.878</td></tr><tr><td>25</td><td>$8.623.878</td><td>28 feb. 2026</td><td>$208.410</td><td>$718.656</td><td>29 mar. 2026</td><td>$927.067</td><td>$7.905.221</td></tr><tr><td>26</td><td>$7.905.221</td><td>29 mar. 2026</td><td>$197.631</td><td>$718.656</td><td>29 abr. 2026</td><td>$916.287</td><td>$7.186.565</td></tr><tr><td>27</td><td>$7.186.565</td><td>29 abr. 2026</td><td>$179.664</td><td>$718.656</td><td>29 may. 2026</td><td>$898.321</td><td>$6.467.908</td></tr><tr><td>28</td><td>$6.467.908</td><td>29 may. 2026</td><td>$161.698</td><td>$718.656</td><td>29 jun. 2026</td><td>$880.354</td><td>$5.749.252</td></tr><tr><td>29</td><td>$5.749.252</td><td>29 jun. 2026</td><td>$143.731</td><td>$718.656</td><td>29 jul. 2026</td><td>$862.388</td><td>$5.030.595</td></tr><tr><td>30</td><td>$5.030.595</td><td>29 jul. 2026</td><td>$125.765</td><td>$718.656</td><td>29 ago. 2026</td><td>$844.421</td><td>$4.311.939</td></tr><tr><td>31</td><td>$4.311.939</td><td>29 ago. 2026</td><td>$107.798</td><td>$718.656</td><td>29 sept. 2026</td><td>$826.455</td><td>$3.593.282</td></tr><tr><td>32</td><td>$3.593.282</td><td>29 sept. 2026</td><td>$89.832</td><td>$718.656</td><td>29 oct. 2026</td><td>$808.489</td><td>$2.874.626</td></tr><tr><td>33</td><td>$2.874.626</td><td>29 oct. 2026</td><td>$71.866</td><td>$718.656</td><td>29 nov. 2026</td><td>$790.522</td><td>$2.155.969</td></tr><tr><td>34</td><td>$2.155.969</td><td>29 nov. 2026</td><td>$53.899</td><td>$718.656</td><td>29 dic. 2026</td><td>$772.556</td><td>$1.437.313</td></tr><tr><td>35</td><td>$1.437.313</td><td>29 dic. 2026</td><td>$35.933</td><td>$718.656</td><td>29 ene. 2027</td><td>$754.589</td><td>$718.656</td></tr><tr><td>36</td><td>$718.656</td><td>29 ene. 2027</td><td>$17.368</td><td>$718.656</td><td>28 feb. 2027</td><td>$736.024</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2024-03-29',
        minimum_payment: 1343888,
        total_payment: 37770789,
        interests: 625231,
      },
      input: {
        value: 25871634,
        timelimit: 36,
        fee: 0,
        rate: '0.025',
        disbursement_date: '2024-02-29',
      },
    },
    'odd-1000000-7': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$1.000.000</td><td>31 ago. 2021</td><td>$20.000</td><td>$142.857</td><td>30 sept. 2021</td><td>$162.857</td><td>$857.143</td></tr><tr><td>2</td><td>$857.143</td><td>30 sept. 2021</td><td>$17.143</td><td>$142.857</td><td>31 oct. 2021</td><td>$160.000</td><td>$714.286</td></tr><tr><td>3</td><td>$714.286</td><td>31 oct. 2021</td><td>$14.286</td><td>$142.857</td><td>30 nov. 2021</td><td>$157.143</td><td>$571.429</td></tr><tr><td>4</td><td>$571.429</td><td>30 nov. 2021</td><td>$11.429</td><td>$142.857</td><td>31 dic. 2021</td><td>$154.286</td><td>$428.571</td></tr><tr><td>5</td><td>$428.571</td><td>31 dic. 2021</td><td>$8.571</td><td>$142.857</td><td>31 ene. 2022</td><td>$151.429</td><td>$285.714</td></tr><tr><td>6</td><td>$285.714</td><td>31 ene. 2022</td><td>$5.333</td><td>$142.857</td><td>28 feb. 2022</td><td>$148.190</td><td>$142.857</td></tr><tr><td>7</td><td>$142.857</td><td>28 feb. 2022</td><td>$2.857</td><td>$142.857</td><td>31 mar. 2022</td><td>$145.714</td><td>$-0</td></tr></table>',
      summary: {
        payday_limit: '2021-09-30',
        minimum_payment: 162857,
        total_payment: 1079619,
        interests: 20000,
      },
      input: {
        value: 1000000,
        timelimit: 7,
        fee: 0,
        rate: '0.020',
        disbursement_date: '2021-08-31',
      },
    },
    'tiny-5-2': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$5</td><td>1 ene. 2018</td><td>$0</td><td>$2</td><td>1 feb. 2018</td><td>$3</td><td>$2</td></tr><tr><td>2</td><td>$2</td><td>1 feb. 2018</td><td>$0</td><td>$2</td><td>1 mar. 2018</td><td>$3</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2018-02-01',
        minimum_payment: 3,
        total_payment: 5,
        interests: 0,
      },
      input: {
        value: 5,
        timelimit: 2,
        fee: 0,
        rate: '0.015',
        disbursement_date: '2018-01-01',
      },
    },
    'one-100-1': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$100</td><td>31 may. 2019</td><td>$1</td><td>$100</td><td>30 jun. 2019</td><td>$101</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2019-06-30',
        minimum_payment: 102,
        total_payment: 102,
        interests: 2,
      },
      input: {
        value: 100,
        timelimit: 1,
        fee: 0,
        rate: '0.015',
        disbursement_date: '2019-05-31',
      },
    },
    'unique-1234567-36': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$1.234.567</td><td>1 ene. 2022</td><td>$1.111.110</td><td>$1.234.567</td><td>1 ene. 2025</td><td>$2.345.677</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2025-01-01',
        minimum_payment: 2345677,
        total_payment: 2345677,
        interests: 1111110,
      },
      input: {
        value: 1234567,
        timelimit: 36,
        fee: 1,
        rate: '0.025',
        disbursement_date: '2022-01-01',
      },
    },
    'feb29-999-24': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$999</td><td>29 feb. 2020</td><td>$21</td><td>$42</td><td>29 mar. 2020</td><td>$63</td><td>$957</td></tr><tr><td>2</td><td>$957</td><td>29 mar. 2020</td><td>$21</td><td>$42</td><td>29 abr. 2020</td><td>$63</td><td>$916</td></tr><tr><td>3</td><td>$916</td><td>29 abr. 2020</td><td>$20</td><td>$42</td><td>29 may. 2020</td><td>$62</td><td>$874</td></tr><tr><td>4</td><td>$874</td><td>29 may. 2020</td><td>$19</td><td>$42</td><td>29 jun. 2020</td><td>$61</td><td>$832</td></tr><tr><td>5</td><td>$832</td><td>29 jun. 2020</td><td>$18</td><td>$42</td><td>29 jul. 2020</td><td>$60</td><td>$791</td></tr><tr><td>6</td><td>$791</td><td>29 jul. 2020</td><td>$17</td><td>$42</td><td>29 ago. 2020</td><td>$59</td><td>$749</td></tr><tr><td>7</td><td>$749</td><td>29 ago. 2020</td><td>$16</td><td>$42</td><td>29 sept. 2020</td><td>$58</td><td>$708</td></tr><tr><td>8</td><td>$708</td><td>29 sept. 2020</td><td>$16</td><td>$42</td><td>29 oct. 2020</td><td>$57</td><td>$666</td></tr><tr><td>9</td><td>$666</td><td>29 oct. 2020</td><td>$15</td><td>$42</td><td>29 nov. 2020</td><td>$56</td><td>$624</td></tr><tr><td>10</td><td>$624</td><td>29 nov. 2020</td><td>$14</td><td>$42</td><td>29 dic. 2020</td><td>$55</td><td>$583</td></tr><tr><td>11</td><td>$583</td><td>29 dic. 2020</td><td>$13</td><td>$42</td><td>29 ene. 2021</td><td>$54</td><td>$541</td></tr><tr><td>12</td><td>$541</td><td>29 ene. 2021</td><td>$12</td><td>$42</td><td>28 feb. 2021</td><td>$53</td><td>$499</td></tr><tr><td>13</td><td>$499</td><td>28 feb. 2021</td><td>$11</td><td>$42</td><td>29 mar. 2021</td><td>$52</td><td>$458</td></tr><tr><td>14</td><td>$458</td><td>29 mar. 2021</td><td>$10</td><td>$42</td><td>29 abr. 2021</td><td>$52</td><td>$416</td></tr><tr><td>15</td><td>$416</td><td>29 abr. 2021</td><td>$9</td><td>$42</td><td>29 may. 2021</td><td>$51</td><td>$375</td></tr><tr><td>16</td><td>$375</td><td>29 may. 2021</td><td>$8</td><td>$42</td><td>29 jun. 2021</td><td>$50</td><td>$333</td></tr><tr><td>17</td><td>$333</td><td>29 jun. 2021</td><td>$7</td><td>$42</td><td>29 jul. 2021</td><td>$49</td><td>$291</td></tr><tr><td>18</td><td>$291</td><td>29 jul. 2021</td><td>$6</td><td>$42</td><td>29 ago. 2021</td><td>$48</td><td>$250</td></tr><tr><td>19</td><td>$250</td><td>29 ago. 2021</td><td>$5</td><td>$42</td><td>29 sept. 2021</td><td>$47</td><td>$208</td></tr><tr><td>20</td><td>$208</td><td>29 sept. 2021</td><td>$5</td><td>$42</td><td>29 oct. 2021</td><td>$46</td><td>$166</td></tr><tr><td>21</td><td>$166</td><td>29 oct. 2021</td><td>$4</td><td>$42</td><td>29 nov. 2021</td><td>$45</td><td>$125</td></tr><tr><td>22</td><td>$125</td><td>29 nov. 2021</td><td>$3</td><td>$42</td><td>29 dic. 2021</td><td>$44</td><td>$83</td></tr><tr><td>23</td><td>$83</td><td>29 dic. 2021</td><td>$2</td><td>$42</td><td>29 ene. 2022</td><td>$43</td><td>$42</td></tr><tr><td>24</td><td>$42</td><td>29 ene. 2022</td><td>$1</td><td>$42</td><td>28 feb. 2022</td><td>$43</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2020-03-29',
        minimum_payment: 63,
        total_payment: 1272,
        interests: 21,
      },
      input: {
        value: 999,
        timelimit: 24,
        fee: 0,
        rate: '0.022',
        disbursement_date: '2020-02-29',
      },
    },
    'big-30000000-36': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$30.000.000</td><td>15 jul. 2023</td><td>$750.000</td><td>$833.333</td><td>15 ago. 2023</td><td>$1.583.333</td><td>$29.166.667</td></tr><tr><td>2</td><td>$29.166.667</td><td>15 ago. 2023</td><td>$729.167</td><td>$833.333</td><td>15 sept. 2023</td><td>$1.562.500</td><td>$28.333.333</td></tr><tr><td>3</td><td>$28.333.333</td><td>15 sept. 2023</td><td>$708.333</td><td>$833.333</td><td>15 oct. 2023</td><td>$1.541.667</td><td>$27.500.000</td></tr><tr><td>4</td><td>$27.500.000</td><td>15 oct. 2023</td><td>$687.500</td><td>$833.333</td><td>15 nov. 2023</td><td>$1.520.833</td><td>$26.666.667</td></tr><tr><td>5</td><td>$26.666.667</td><td>15 nov. 2023</td><td>$666.667</td><td>$833.333</td><td>15 dic. 2023</td><td>$1.500.000</td><td>$25.833.333</td></tr><tr><td>6</td><td>$25.833.333</td><td>15 dic. 2023</td><td>$645.833</td><td>$833.333</td><td>15 ene. 2024</td><td>$1.479.167</td><td>$25.000.000</td></tr><tr><td>7</td><td>$25.000.000</td><td>15 ene. 2024</td><td>$625.000</td><td>$833.333</td><td>15 feb. 2024</td><td>$1.458.333</td><td>$24.166.667</td></tr><tr><td>8</td><td>$24.166.667</td><td>15 feb. 2024</td><td>$604.167</td><td>$833.333</td><td>15 mar. 2024</td><td>$1.437.500</td><td>$23.333.333</td></tr><tr><td>9</td><td>$23.333.333</td><td>15 mar. 2024</td><td>$583.333</td><td>$833.333</td><td>15 abr. 2024</td><td>$1.416.667</td><td>$22.500.000</td></tr><tr><td>10</td><td>$22.500.000</td><td>15 abr. 2024</td><td>$562.500</td><td>$833.333</td><td>15 may. 2024</td><td>$1.395.833</td><td>$21.666.667</td></tr><tr><td>11</td><td>$21.666.667</td><td>15 may. 2024</td><td>$541.667</td><td>$833.333</td><td>15 jun. 2024</td><td>$1.375.000</td><td>$20.833.333</td></tr><tr><td>12</td><td>$20.833.333</td><td>15 jun. 2024</td><td>$520.833</td><td>$833.333</td><td>15 jul. 2024</td><td>$1.354.167</td><td>$20.000.000</td></tr><tr><td>13</td><td>$20.000.000</td><td>15 jul. 2024</td><td>$500.000</td><td>$833.333</td><td>15 ago. 2024</td><td>$1.333.333</td><td>$19.166.667</td></tr><tr><td>14</td><td>$19.166.667</td><td>15 ago. 2024</td><td>$479.167</td><td>$833.333</td><td>15 sept. 2024</td><td>$1.312.500</td><td>$18.333.333</td></tr><tr><td>15</td><td>$18.333.333</td><td>15 sept. 2024</td><td>$458.333</td><td>$833.333</td><td>15 oct. 2024</td><td>$1.291.667</td><td>$17.500.000</td></tr><tr><td>16</td><td>$17.500.000</td><td>15 oct. 2024</td><td>$437.500</td><td>$833.333</td><td>15 nov. 2024</td><td>$1.270.833</td><td>$16.666.667</td></tr><tr><td>17</td><td>$16.666.667</td><td>15 nov. 2024</td><td>$416.667</td><td>$833.333</td><td>15 dic. 2024</td><td>$1.250.000</td><td>$15.833.333</td></tr><tr><td>18</td><td>$15.833.333</td><td>15 dic. 2024</td><td>$395.833</td><td>$833.333</td><td>15 ene. 2025</td><td>$1.229.167</td><td>$15.000.000</td></tr><tr><td>19</td><td>$15.000.000</td><td>15 ene. 2025</td><td>$375.000</td><td>$833.333</td><td>15 feb. 2025</td><td>$1.208.333</td><td>$14.166.667</td></tr><tr><td>20</td><td>$14.166.667</td><td>15 feb. 2025</td><td>$354.167</td><td>$833.333</td><td>15 mar. 2025</td><td>$1.187.500</td><td>$13.333.333</td></tr><tr><td>21</td><td>$13.333.333</td><td>15 mar. 2025</td><td>$333.333</td><td>$833.333</td><td>15 abr. 2025</td><td>$1.166.667</td><td>$12.500.000</td></tr><tr><td>22</td><td>$12.500.000</td><td>15 abr. 2025</td><td>$312.500</td><td>$833.333</td><td>15 may. 2025</td><td>$1.145.833</td><td>$11.666.667</td></tr><tr><td>23</td><td>$11.666.667</td><td>15 may. 2025</td><td>$291.667</td><td>$833.333</td><td>15 jun. 2025</td><td>$1.125.000</td><td>$10.833.333</td></tr><tr><td>24</td><td>$10.833.333</td><td>15 jun. 2025</td><td>$270.833</td><td>$833.333</td><td>15 jul. 2025</td><td>$1.104.167</td><td>$10.000.000</td></tr><tr><td>25</td><td>$10.000.000</td><td>15 jul. 2025</td><td>$250.000</td><td>$833.333</td><td>15 ago. 2025</td><td>$1.083.333</td><td>$9.166.667</td></tr><tr><td>26</td><td>$9.166.667</td><td>15 ago. 2025</td><td>$229.167</td><td>$833.333</td><td>15 sept. 2025</td><td>$1.062.500</td><td>$8.333.333</td></tr><tr><td>27</td><td>$8.333.333</td><td>15 sept. 2025</td><td>$208.333</td><td>$833.333</td><td>15 oct. 2025</td><td>$1.041.667</td><td>$7.500.000</td></tr><tr><td>28</td><td>$7.500.000</td><td>15 oct. 2025</td><td>$187.500</td><td>$833.333</td><td>15 nov. 2025</td><td>$1.020.833</td><td>$6.666.667</td></tr><tr><td>29</td><td>$6.666.667</td><td>15 nov. 2025</td><td>$166.667</td><td>$833.333</td><td>15 dic. 2025</td><td>$1.000.000</td><td>$5.833.333</td></tr><tr><td>30</td><td>$5.833.333</td><td>15 dic. 2025</td><td>$145.833</td><td>$833.333</td><td>15 ene. 2026</td><td>$979.167</td><td>$5.000.000</td></tr><tr><td>31</td><td>$5.000.000</td><td>15 ene. 2026</td><td>$125.000</td><td>$833.333</td><td>15 feb. 2026</td><td>$958.333</td><td>$4.166.667</td></tr><tr><td>32</td><td>$4.166.667</td><td>15 feb. 2026</td><td>$104.167</td><td>$833.333</td><td>15 mar. 2026</td><td>$937.500</td><td>$3.333.333</td></tr><tr><td>33</td><td>$3.333.333</td><td>15 mar. 2026</td><td>$83.333</td><td>$833.333</td><td>15 abr. 2026</td><td>$916.667</td><td>$2.500.000</td></tr><tr><td>34</td><td>$2.500.000</td><td>15 abr. 2026</td><td>$62.500</td><td>$833.333</td><td>15 may. 2026</td><td>$895.833</td><td>$1.666.667</td></tr><tr><td>35</td><td>$1.666.667</td><td>15 may. 2026</td><td>$41.667</td><td>$833.333</td><td>15 jun. 2026</td><td>$875.000</td><td>$833.333</td></tr><tr><td>36</td><td>$833.333</td><td>15 jun. 2026</td><td>$20.833</td><td>$833.333</td><td>15 jul. 2026</td><td>$854.167</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2023-08-15',
        minimum_payment: 1583333,
        total_payment: 43875000,
        interests: 750000,
      },
      input: {
        value: 30000000,
        timelimit: 36,
        fee: 0,
        rate: '0.025',
        disbursement_date: '2023-07-15',
      },
    },
    'mid-777777-13': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$777.777</td><td>30 mar. 2018</td><td>$17.111</td><td>$59.829</td><td>30 abr. 2018</td><td>$76.940</td><td>$717.948</td></tr><tr><td>2</td><td>$717.948</td><td>30 abr. 2018</td><td>$15.795</td><td>$59.829</td><td>30 may. 2018</td><td>$75.624</td><td>$658.119</td></tr><tr><td>3</td><td>$658.119</td><td>30 may. 2018</td><td>$14.479</td><td>$59.829</td><td>30 jun. 2018</td><td>$74.308</td><td>$598.290</td></tr><tr><td>4</td><td>$598.290</td><td>30 jun. 2018</td><td>$13.162</td><td>$59.829</td><td>30 jul. 2018</td><td>$72.991</td><td>$538.461</td></tr><tr><td>5</td><td>$538.461</td><td>30 jul. 2018</td><td>$11.846</td><td>$59.829</td><td>30 ago. 2018</td><td>$71.675</td><td>$478.632</td></tr><tr><td>6</td><td>$478.632</td><td>30 ago. 2018</td><td>$10.530</td><td>$59.829</td><td>30 sept. 2018</td><td>$70.359</td><td>$418.803</td></tr><tr><td>7</td><td>$418.803</td><td>30 sept. 2018</td><td>$9.214</td><td>$59.829</td><td>30 oct. 2018</td><td>$69.043</td><td>$358.974</td></tr><tr><td>8</td><td>$358.974</td><td>30 oct. 2018</td><td>$7.897</td><td>$59.829</td><td>30 nov. 2018</td><td>$67.726</td><td>$299.145</td></tr><tr><td>9</td><td>$299.145</td><td>30 nov. 2018</td><td>$6.581</td><td>$59.829</td><td>30 dic. 2018</td><td>$66.410</td><td>$239.316</td></tr><tr><td>10</td><td>$239.316</td><td>30 dic. 2018</td><td>$5.265</td><td>$59.829</td><td>30 ene. 2019</td><td>$65.094</td><td>$179.487</td></tr><tr><td>11</td><td>$179.487</td><td>30 ene. 2019</td><td>$3.685</td><td>$59.829</td><td>28 feb. 2019</td><td>$63.514</td><td>$119.658</td></tr><tr><td>12</td><td>$119.658</td><td>28 feb. 2019</td><td>$2.632</td><td>$59.829</td><td>30 mar. 2019</td><td>$62.461</td><td>$59.829</td></tr><tr><td>13</td><td>$59.829</td><td>30 mar. 2019</td><td>$1.316</td><td>$59.829</td><td>30 abr. 2019</td><td>$61.145</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2018-04-30',
        minimum_payment: 76940,
        total_payment: 897291,
        interests: 17111,
      },
      input: {
        value: 777777,
        timelimit: 13,
        fee: 0,
        rate: '0.022',
        disbursement_date: '2018-03-30',
      },
    },
    'mid-500000-6': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$500.000</td><td>31 dic. 2025</td><td>$7.500</td><td>$83.333</td><td>31 ene. 2026</td><td>$90.833</td><td>$416.667</td></tr><tr><td>2</td><td>$416.667</td><td>31 ene. 2026</td><td>$5.833</td><td>$83.333</td><td>28 feb. 2026</td><td>$89.167</td><td>$333.333</td></tr><tr><td>3</td><td>$333.333</td><td>28 feb. 2026</td><td>$5.000</td><td>$83.333</td><td>31 mar. 2026</td><td>$88.333</td><td>$250.000</td></tr><tr><td>4</td><td>$250.000</td><td>31 mar. 2026</td><td>$3.750</td><td>$83.333</td><td>30 abr. 2026</td><td>$87.083</td><td>$166.667</td></tr><tr><td>5</td><td>$166.667</td><td>30 abr. 2026</td><td>$2.500</td><td>$83.333</td><td>31 may. 2026</td><td>$85.833</td><td>$83.333</td></tr><tr><td>6</td><td>$83.333</td><td>31 may. 2026</td><td>$1.250</td><td>$83.333</td><td>30 jun. 2026</td><td>$84.583</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2026-01-31',
        minimum_payment: 90833,
        total_payment: 525833,
        interests: 7500,
      },
      input: {
        value: 500000,
        timelimit: 6,
        fee: 0,
        rate: '0.015',
        disbursement_date: '2025-12-31',
      },
    },
    'unique-0tl-200': {
      table:
        '<table style="width:100%" border="1"><tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th><th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr><tr><td>1</td><td>$200</td><td>1 ene. 2018</td><td>$0</td><td>$200</td><td>1 ene. 2018</td><td>$200</td><td>$0</td></tr></table>',
      summary: {
        payday_limit: '2018-01-01',
        minimum_payment: 200,
        total_payment: 200,
        interests: 0,
      },
      input: {
        value: 200,
        timelimit: 0,
        fee: 1,
        rate: '0.015',
        disbursement_date: '2018-01-01',
      },
    },
  });
