import { toHstoreLiteral, parseHstore } from './hstore.util';

describe('toHstoreLiteral', () => {
  it('serializes a simple object', () => {
    expect(toHstoreLiteral({ a: '1', b: 'hello' })).toBe('"a"=>"1","b"=>"hello"');
  });

  it('escapes double quotes in values', () => {
    expect(toHstoreLiteral({ key: 'say "hi"' })).toBe('"key"=>"say \\"hi\\""');
  });

  it('handles empty object', () => {
    expect(toHstoreLiteral({})).toBe('');
  });

  it('handles single entry', () => {
    expect(toHstoreLiteral({ endpoint: 'https://example.com' })).toBe('"endpoint"=>"https://example.com"');
  });
});

describe('parseHstore', () => {
  it('parses a simple hstore string', () => {
    expect(parseHstore('"a"=>"1","b"=>"hello"')).toEqual({ a: '1', b: 'hello' });
  });

  it('returns empty object for empty input', () => {
    expect(parseHstore('')).toEqual({});
  });

  it('unescapes double quotes in values', () => {
    expect(parseHstore('"key"=>"say \\"hi\\""')).toEqual({ key: 'say "hi"' });
  });

  it('parses multiple keys including nested JSON-like value', () => {
    const raw = '"endpoint"=>"https://push.example.com","keys"=>"{\\"auth\\":\\"abc\\"}"';
    const result = parseHstore(raw);
    expect(result.endpoint).toBe('https://push.example.com');
    expect(result.keys).toBe('{"auth":"abc"}');
  });

  it('round-trips through serialize and parse', () => {
    const original = { owner_id: '42', type: 'loan_reminder', user_ids: '[1,2,3]' };
    expect(parseHstore(toHstoreLiteral(original))).toEqual(original);
  });
});
