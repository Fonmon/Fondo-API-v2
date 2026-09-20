import { ExecuterFactory } from './executer.factory';
import type { NotificationExecuter } from './notification.executer';
import type { SavingAccountCloseExecuter } from './saving-account-close.executer';

/**
 * `fondo_api/scheduler/executers/factory.py`.
 *
 * v1 ships **no** test for this file — no test for anything under `fondo_api/scheduler/`, in
 * fact — so every cell here is new coverage rather than a port. The plan calls this subsystem
 * *"the highest ratio of consequence to coverage in the migration"*; these are the cheapest
 * possible cells against the branches `get_executer` actually has.
 *
 * ⚠️ **Phase 6 added a branch.** D12's CAP auto-close is `type = 1`, which v1's factory does
 * not know: `TASK_TYPES` (`models.py:100-102`) declares only `(0, 'NOTIFICATIONS')`. So `1`
 * moved out of the "unknown type" table below and into a cell of its own, and the table kept
 * a positive control on both sides of it.
 */
describe('ExecuterFactory (get_executer)', () => {
  const notificationExecuter = { run: jest.fn() } as unknown as NotificationExecuter;
  const savingAccountCloseExecuter = { run: jest.fn() } as unknown as SavingAccountCloseExecuter;
  const factory = new ExecuterFactory(notificationExecuter, savingAccountCloseExecuter);

  it('resolves type 0 to the notification executer', () => {
    expect(factory.get(0)).toBe(notificationExecuter);
  });

  /** Phase 6 / **D12** — the second task type, and the first one v1 has no counterpart for. */
  it('resolves type 1 to the CAP close executer (D12)', () => {
    expect(factory.get(1)).toBe(savingAccountCloseExecuter);
  });

  it('keeps the two types distinct', () => {
    expect(factory.get(0)).not.toBe(factory.get(1));
  });

  it.each([2, 3, -1, 99])('raises v1’s exact message for unknown type %i', (type) => {
    // v1: raise Exception("Executer type {} does not exist.".format(type))
    // The text is observable: it is interpolated into the runner's
    // `Error processing task with id: {id}, exception: {ex}` log line.
    expect(() => factory.get(type)).toThrow(`Executer type ${type} does not exist.`);
  });
});
