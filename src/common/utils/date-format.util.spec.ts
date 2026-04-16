import { formatDateEs } from './date-format.util';

describe('formatDateEs', () => {
  it.each([
    [new Date(2017, 10,  9), '9 nov. 2017'],
    [new Date(2017, 11,  9), '9 dic. 2017'],
    [new Date(2018,  8,  9), '9 sept. 2018'],
    [new Date(2018,  0,  1), '1 ene. 2018'],
    [new Date(2019,  5, 15), '15 jun. 2019'],
  ])('formats %s as "%s"', (date, expected) => {
    expect(formatDateEs(date)).toBe(expected);
  });

  it('accepts a string date', () => {
    expect(formatDateEs('2017-11-09')).toBe('9 nov. 2017');
  });
});
