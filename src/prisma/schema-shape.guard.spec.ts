import {
  assertSchemaShape,
  REQUIRED_HSTORE_COLUMN_TYPE,
  SchemaShapeError,
  STEP6_COLUMNS,
} from './schema-shape.guard';

/**
 * Fail-closed cells for the Phase 9 boot guard (review finding **M7**, condition **C93**).
 *
 * The guard's job is to refuse. So the cells that matter are the ones where a careless
 * implementation would *accept*: an empty result (`rows.every(...)` is vacuously true), a
 * partial result, and two rows that are not the two expected columns.
 */
describe('assertSchemaShape', () => {
  const hstore = [
    { table_name: 'fondo_api_notificationsubscriptions', udt_name: 'hstore' },
    { table_name: 'fondo_api_schedulertask', udt_name: 'hstore' },
  ];
  const jsonb = hstore.map((r) => ({ ...r, udt_name: 'jsonb' }));

  it('accepts exactly the two expected columns at the required type', () => {
    expect(() => assertSchemaShape(hstore, 'hstore')).not.toThrow();
    expect(() => assertSchemaShape(jsonb, 'jsonb')).not.toThrow();
  });

  it('this build requires hstore — it is the pre-cutover Release A', () => {
    expect(REQUIRED_HSTORE_COLUMN_TYPE).toBe('hstore');
    expect(STEP6_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual([
      'fondo_api_notificationsubscriptions.subscription',
      'fondo_api_schedulertask.payload',
    ]);
  });

  it('refuses a converted schema, and says which release to deploy instead', () => {
    expect(() => assertSchemaShape(jsonb, 'hstore')).toThrow(SchemaShapeError);
    expect(() => assertSchemaShape(jsonb, 'hstore')).toThrow(/deploy Release B instead/);
    expect(() => assertSchemaShape(jsonb, 'hstore')).toThrow(/fondo_api_schedulertask=jsonb/);
  });

  it('refuses an un-migrated schema when the required type is jsonb (the Release B half)', () => {
    expect(() => assertSchemaShape(hstore, 'jsonb')).toThrow(/has NOT had the Phase 9 step-6/);
  });

  // --- the shapes a vacuous `every(...)` would accept -----------------------

  it('refuses ZERO rows — the shape `rows.every(...)` passes on', () => {
    expect(() => assertSchemaShape([], 'hstore')).toThrow(SchemaShapeError);
    expect(() => assertSchemaShape([], 'hstore')).toThrow(/found none/);
  });

  it('refuses ONE row, even when that row is correct', () => {
    expect(() => assertSchemaShape([hstore[0]], 'hstore')).toThrow(
      /expected to find exactly the two step-6 columns/,
    );
  });

  it('refuses TWO rows that are both the same table', () => {
    expect(() => assertSchemaShape([hstore[0], hstore[0]], 'hstore')).toThrow(
      /expected to find exactly the two step-6 columns/,
    );
  });

  it('refuses a third, unexpected row', () => {
    const extra = [...hstore, { table_name: 'fondo_api_loan', udt_name: 'hstore' }];
    expect(() => assertSchemaShape(extra, 'hstore')).toThrow(
      /expected to find exactly the two step-6 columns/,
    );
  });

  // --- mixed and unexpected types ------------------------------------------

  it('refuses a MIXED schema — half converted is the worst state of all', () => {
    const mixed = [
      { table_name: 'fondo_api_notificationsubscriptions', udt_name: 'jsonb' },
      { table_name: 'fondo_api_schedulertask', udt_name: 'hstore' },
    ];
    expect(() => assertSchemaShape(mixed, 'hstore')).toThrow(SchemaShapeError);
    expect(() => assertSchemaShape(mixed, 'hstore')).toThrow(
      /fondo_api_notificationsubscriptions=jsonb, fondo_api_schedulertask=hstore/,
    );
  });

  it('refuses a type that is neither hstore nor jsonb', () => {
    const text = hstore.map((r) => ({ ...r, udt_name: 'text' }));
    expect(() => assertSchemaShape(text, 'hstore')).toThrow(/found .*=text/);
  });
});
