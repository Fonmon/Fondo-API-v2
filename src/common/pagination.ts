export interface PaginatedResult<T> {
  list: T[];
  num_pages: number;
  count: number;
}

export interface UnpaginatedResult<T> {
  list: T[];
}

export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  perPage: number,
): PaginatedResult<T> {
  return {
    list: items,
    num_pages: Math.ceil(total / perPage),
    count: total,
  };
}

export function unpaginate<T>(items: T[]): UnpaginatedResult<T> {
  return { list: items };
}
