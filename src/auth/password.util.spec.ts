import { verifyPassword, hashPassword } from './password.util';

describe('verifyPassword', () => {
  it('returns true for a correct password against a freshly hashed value', async () => {
    const hash = await hashPassword('mypassword');
    const result = await verifyPassword('mypassword', hash);
    expect(result).toBe(true);
  });

  it('returns false for a wrong password', async () => {
    const hash = await hashPassword('correctpassword');
    const result = await verifyPassword('wrongpassword', hash);
    expect(result).toBe(false);
  });

  it('returns false for an empty string password against a real hash', async () => {
    const hash = await hashPassword('somepassword');
    const result = await verifyPassword('', hash);
    expect(result).toBe(false);
  });

  it('returns false for an invalid hash format (too few parts)', async () => {
    const result = await verifyPassword('pass', 'invalid$hash');
    expect(result).toBe(false);
  });

  it('returns false for an unsupported algorithm prefix', async () => {
    const result = await verifyPassword(
      'pass',
      'bcrypt$12$somesalt$somehash',
    );
    expect(result).toBe(false);
  });

  it('verifies against a known PBKDF2-SHA256 hash computed independently', async () => {
    const { pbkdf2: nodePbkdf2 } = await import('crypto');
    const { promisify } = await import('util');
    const pbkdf2Async = promisify(nodePbkdf2);

    const iterations = 260000;
    const salt = 'testsalt';
    const password = 'hunter2';
    const dk = await pbkdf2Async(password, salt, iterations, 32, 'sha256');
    const hash = `pbkdf2_sha256$${iterations}$${salt}$${dk.toString('base64')}`;

    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('wrongpass', hash)).toBe(false);
  });
});

describe('hashPassword', () => {
  it('produces a string in pbkdf2_sha256$<iter>$<salt>$<hash> format', async () => {
    const hash = await hashPassword('password123');
    const parts = hash.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2_sha256');
    expect(Number(parts[1])).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it('uses 600000 iterations', async () => {
    const hash = await hashPassword('pass');
    expect(hash.split('$')[1]).toBe('600000');
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});
