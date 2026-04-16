import { pbkdf2, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const pbkdf2Async = promisify(pbkdf2);

/**
 * Verify a PBKDF2-SHA256 password hash.
 * Hash format: pbkdf2_sha256$<iterations>$<salt>$<base64hash>
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;

  const iterations = parseInt(parts[1], 10);
  const salt = parts[2];
  const storedKey = Buffer.from(parts[3], 'base64');

  const derivedKey = await pbkdf2Async(
    password,
    salt,
    iterations,
    storedKey.length,
    'sha256',
  );

  return timingSafeEqual(derivedKey, storedKey);
}

/**
 * Hash a plain-text password using PBKDF2-SHA256.
 * Produces the pbkdf2_sha256$<iter>$<salt>$<hash> format.
 */
export async function hashPassword(password: string): Promise<string> {
  const iterations = 600000;
  const chars =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const salt = Array.from(randomBytes(12))
    .map((b) => chars[b % chars.length])
    .join('');
  const derivedKey = await pbkdf2Async(password, salt, iterations, 32, 'sha256');
  return `pbkdf2_sha256$${iterations}$${salt}$${derivedKey.toString('base64')}`;
}
