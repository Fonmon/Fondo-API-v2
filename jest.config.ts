import type { Config } from 'jest';

/**
 * ⚠️ **The harness host zone is pinned, and it is deliberately NOT `America/Bogota`.**
 *
 * v2 must read Bogota explicitly everywhere a calendar date is decided
 * (`src/common/utils/timezone.util.ts`), never inherit it from the host — v1 gets Bogota for
 * free because Django's `Settings.__init__` sets `os.environ['TZ']` from
 * `TIME_ZONE = 'America/Bogota'`, and v2 has no such global. A `new Date().getFullYear()` is
 * therefore a bug (review C28), and on a developer laptop already at −05:00 it is an
 * *invisible* bug: the test that should catch it passes by coincidence.
 *
 * Pinning here rather than in each spec because `process.env.TZ = ...` **inside** a test is a
 * measured no-op — jest's vm context does not propagate the change to V8's cached zone, so a
 * spec that pins its own zone silently tests nothing. This assignment runs in the jest parent
 * process before any worker is forked, and workers inherit it.
 */
process.env.TZ = 'UTC';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!**/index.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/$1',
  },
};

export default config;
