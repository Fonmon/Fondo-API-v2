import {
  BigIntPrecisionError,
  JsonBigIntSetup,
  MAX_SAFE_BIGINT,
  bigIntJsonReplacer,
  bigIntToJsonNumber,
  stringifyWithBigInt,
} from './json-bigint';
import type { HttpAdapterHost } from '@nestjs/core';

/**
 * Reviewer finding S2 / plan §4 rule 5b.
 *
 * The contract under test is a **parity** contract, not a taste one: v1 renders every
 * `BigIntegerField` through DRF's `IntegerField.to_representation` (`int(value)`), i.e. a
 * bare JSON number. `"1000"` would be a response-shape change.
 */
describe('BigInt -> JSON (v1 renders BigIntegerField as a bare number)', () => {
  describe('bigIntToJsonNumber', () => {
    it('converts a bigint to a number', () => {
      expect(bigIntToJsonNumber(1000n)).toBe(1000);
      expect(bigIntToJsonNumber(0n)).toBe(0);
      expect(bigIntToJsonNumber(-250n)).toBe(-250);
    });

    it('accepts the boundaries of the exactly-representable range', () => {
      expect(bigIntToJsonNumber(MAX_SAFE_BIGINT)).toBe(Number.MAX_SAFE_INTEGER);
      expect(bigIntToJsonNumber(-MAX_SAFE_BIGINT)).toBe(-Number.MAX_SAFE_INTEGER);
    });

    it('throws rather than silently losing a cent above 2^53', () => {
      expect(() => bigIntToJsonNumber(MAX_SAFE_BIGINT + 1n)).toThrow(BigIntPrecisionError);
      expect(() => bigIntToJsonNumber(-(MAX_SAFE_BIGINT + 2n))).toThrow(BigIntPrecisionError);
    });
  });

  describe('stringifyWithBigInt', () => {
    it('renders a bare bigint as a number, not a string', () => {
      expect(stringifyWithBigInt(1000n)).toBe('1000');
      expect(stringifyWithBigInt(1000n)).not.toBe('"1000"');
    });

    it('renders a money-shaped user finance block the way DRF does', () => {
      // Field set from `UserFinanceSerializer` (serializers.py:20-33).
      const finance = {
        contributions: 1_000_000n,
        balance_contributions: 250_000n,
        total_quota: 3_000_000n,
        utilized_quota: 1_000_000n,
        available_quota: 2_000_000n,
      };
      expect(stringifyWithBigInt(finance)).toBe(
        '{"contributions":1000000,"balance_contributions":250000,"total_quota":3000000,' +
          '"utilized_quota":1000000,"available_quota":2000000}',
      );
    });

    it('reaches a bigint nested inside the {list, num_pages, count} envelope', () => {
      const page = {
        list: [
          { id: 1, value: 500n },
          { id: 2, value: 0n },
        ],
        num_pages: 1,
        count: 2,
      };
      expect(stringifyWithBigInt(page)).toBe(
        '{"list":[{"id":1,"value":500},{"id":2,"value":0}],"num_pages":1,"count":2}',
      );
    });

    it('reaches a bigint inside a class instance without cloning it', () => {
      class UserFinanceDto {
        constructor(readonly total_quota: bigint) {}
      }
      expect(stringifyWithBigInt(new UserFinanceDto(7n))).toBe('{"total_quota":7}');
    });

    it('leaves every other type alone', () => {
      expect(stringifyWithBigInt({ a: 'x', b: 1, c: true, d: null, e: [1, 'y'] })).toBe(
        '{"a":"x","b":1,"c":true,"d":null,"e":[1,"y"]}',
      );
    });

    it('propagates the precision error out of a nested structure', () => {
      expect(() => stringifyWithBigInt({ list: [{ value: MAX_SAFE_BIGINT + 1n }] })).toThrow(
        BigIntPrecisionError,
      );
    });
  });

  describe('bigIntJsonReplacer', () => {
    it('is a plain (key, value) replacer', () => {
      expect(bigIntJsonReplacer('total_quota', 5n)).toBe(5);
      expect(bigIntJsonReplacer('name', 'Ana')).toBe('Ana');
    });
  });

  describe('JsonBigIntSetup', () => {
    it('installs the replacer on the Express instance', () => {
      const set = jest.fn();
      const host = {
        httpAdapter: { getInstance: (): unknown => ({ set }) },
      } as unknown as HttpAdapterHost;

      new JsonBigIntSetup(host).onModuleInit();

      expect(set).toHaveBeenCalledWith('json replacer', bigIntJsonReplacer);
    });

    it('is a no-op when there is no HTTP adapter (unit TestingModule)', () => {
      const host = { httpAdapter: undefined } as unknown as HttpAdapterHost;
      expect(() => new JsonBigIntSetup(host).onModuleInit()).not.toThrow();
    });
  });
});
