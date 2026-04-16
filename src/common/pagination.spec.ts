import { paginate, unpaginate } from './pagination';

describe('paginate', () => {
  it('returns list, num_pages, and count', () => {
    const result = paginate(['a', 'b', 'c'], 25, 1, 10);
    expect(result).toEqual({ list: ['a', 'b', 'c'], num_pages: 3, count: 25 });
  });

  it('calculates num_pages correctly for exact multiple', () => {
    expect(paginate([], 20, 1, 10).num_pages).toBe(2);
  });

  it('rounds num_pages up for partial last page', () => {
    expect(paginate([], 21, 1, 10).num_pages).toBe(3);
  });

  it('returns num_pages 1 for fewer items than perPage', () => {
    expect(paginate(['a'], 3, 1, 10).num_pages).toBe(1);
  });

  it('returns count equal to total, not list length', () => {
    expect(paginate(['a', 'b'], 50, 3, 10).count).toBe(50);
  });
});

describe('unpaginate', () => {
  it('returns list only', () => {
    const result = unpaginate([1, 2, 3]);
    expect(result).toEqual({ list: [1, 2, 3] });
    expect(result).not.toHaveProperty('num_pages');
    expect(result).not.toHaveProperty('count');
  });

  it('returns empty list', () => {
    expect(unpaginate([])).toEqual({ list: [] });
  });
});
