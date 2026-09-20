import {
  buildPageEnvelope,
  isPageBeyondLast,
  numPages,
  pageOffset,
  paginateArray,
  unpaginatedEnvelope,
} from './pagination';

/** v1 paginates loans and saving accounts 10 per page, users 10 per page. */
const PER_PAGE = 10;

describe('numPages (django.core.paginator.Paginator.num_pages)', () => {
  it.each([
    [0, 10, 1],
    [1, 10, 1],
    [9, 10, 1],
    [10, 10, 1],
    [11, 10, 2],
    [20, 10, 2],
    [21, 10, 3],
    [95, 10, 10],
    [1, 1, 1],
    [3, 2, 2],
  ])('numPages(count=%i, perPage=%i) === %i', (count, perPage, expected) => {
    expect(numPages(count, perPage)).toBe(expected);
  });

  it('reports 1 page for an empty result set, never 0', () => {
    // Django: hits = max(1, count - orphans) => ceil(1/10) = 1
    expect(numPages(0, PER_PAGE)).toBe(1);
  });

  it('rejects nonsensical arguments instead of returning Infinity or NaN', () => {
    expect(() => numPages(10, 0)).toThrow(RangeError);
    expect(() => numPages(10, -1)).toThrow(RangeError);
    expect(() => numPages(-1, 10)).toThrow(RangeError);
    expect(() => numPages(1.5, 10)).toThrow(RangeError);
  });
});

describe('isPageBeyondLast', () => {
  it.each([
    [1, 0, false],
    [2, 0, true],
    [1, 10, false],
    [2, 10, true],
    [2, 11, false],
    [3, 11, true],
    [100, 95, true],
    [10, 95, false],
  ])('isPageBeyondLast(page=%i, count=%i) === %s', (page, count, expected) => {
    expect(isPageBeyondLast(page, count, PER_PAGE)).toBe(expected);
  });

  it('page 1 of an empty collection is NOT beyond the last page', () => {
    expect(isPageBeyondLast(1, 0, PER_PAGE)).toBe(false);
  });
});

describe('pageOffset', () => {
  it.each([
    [1, 0],
    [2, 10],
    [3, 20],
    [10, 90],
  ])('pageOffset(%i) === %i', (page, expected) => {
    expect(pageOffset(page, PER_PAGE)).toBe(expected);
  });
});

describe('buildPageEnvelope', () => {
  it('always emits exactly list, num_pages and count, in that order', () => {
    const envelope = buildPageEnvelope([{ id: 1 }], 1, PER_PAGE);
    expect(Object.keys(envelope)).toEqual(['list', 'num_pages', 'count']);
  });

  it('copies the input so callers cannot mutate the response through it', () => {
    const items = [{ id: 1 }];
    const envelope = buildPageEnvelope(items, 1, PER_PAGE);
    items.push({ id: 2 });
    expect(envelope.list).toHaveLength(1);
  });
});

describe('paginateArray', () => {
  const items = Array.from({ length: 25 }, (_, index) => index + 1);

  it('returns the requested slice with the full count', () => {
    expect(paginateArray(items, 1, PER_PAGE)).toEqual({
      list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      num_pages: 3,
      count: 25,
    });
    expect(paginateArray(items, 3, PER_PAGE)).toEqual({
      list: [21, 22, 23, 24, 25],
      num_pages: 3,
      count: 25,
    });
  });

  it('returns an empty list with the SAME envelope for a page past the last one', () => {
    // v1 returns HTTP 200 here, not 404 - see LoanService.get_loans.
    expect(paginateArray(items, 4, PER_PAGE)).toEqual({
      list: [],
      num_pages: 3,
      count: 25,
    });
    expect(paginateArray(items, 999, PER_PAGE)).toEqual({
      list: [],
      num_pages: 3,
      count: 25,
    });
  });

  it('handles an empty collection: empty list, num_pages 1, count 0', () => {
    expect(paginateArray([], 1, PER_PAGE)).toEqual({ list: [], num_pages: 1, count: 0 });
    expect(paginateArray([], 2, PER_PAGE)).toEqual({ list: [], num_pages: 1, count: 0 });
  });

  it('fills the last page exactly when the count is a multiple of perPage', () => {
    const twenty = items.slice(0, 20);
    expect(paginateArray(twenty, 2, PER_PAGE).list).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(paginateArray(twenty, 2, PER_PAGE).num_pages).toBe(2);
    expect(paginateArray(twenty, 3, PER_PAGE).list).toEqual([]);
  });
});

describe('unpaginatedEnvelope', () => {
  it('omits num_pages and count entirely, as v1 does when paginate=false', () => {
    const envelope = unpaginatedEnvelope([1, 2, 3]);
    expect(envelope).toEqual({ list: [1, 2, 3] });
    expect(Object.keys(envelope)).toEqual(['list']);
    expect('num_pages' in envelope).toBe(false);
    expect('count' in envelope).toBe(false);
  });
});
