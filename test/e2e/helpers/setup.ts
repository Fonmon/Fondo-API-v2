/**
 * E2E test fixtures derived from ~/Downloads/fonmon-dev-20210516.sql dump.
 */

export { acquireApp, releaseApp } from './test-server';

/** Known users from the dump */
export const FIXTURES = {
  users: {
    admin: {
      id: 1,
      email: 'angelitogomeza@hotmail.com',
      identification: 1234,
      role: 0, // ADMIN
      token: '87b7f45a0624abb17df90ad71ba2767b31e0f8e6',
      firstName: 'Miguel Ángel',
      lastName: 'Montañez Gómez',
    },
    president: {
      id: 2,
      email: 'cmiguelmg@gmail.com',
      identification: 234,
      role: 1, // PRESIDENT
      token: '4a7197f0d2e2fd656f6ca1f89e32f0c075da00a1',
      firstName: 'Prueba',
      lastName: 'Prueba',
    },
  },
  loans: {
    // state=0 (WAITING_APPROVAL) — for testing approval flow
    waiting: { id: 47 },
    // state=2 (DENIED)
    denied: { id: 25 },
    // state=3 (PAID_OUT)
    paidOut: { id: 1 },
  },
  activities: {
    year2018: { id: 1, year: 2018 },
    year2019: { id: 20, year: 2019 },
    activity1: { id: 1, name: 'Almuerzo' },
    activity2: { id: 2 },
  },
  files: {
    existing: { id: 1, displayName: 'Acta número 1', type: 0 },
  },
};

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Token ${token}` };
}

export function adminAuth(): Record<string, string> {
  return authHeader(FIXTURES.users.admin.token);
}

export function presidentAuth(): Record<string, string> {
  return authHeader(FIXTURES.users.president.token);
}
