import { ExecuterFactory } from './executer.factory';
import type { NotificationExecuter } from './notification.executer';

/**
 * `fondo_api/scheduler/executers/factory.py`.
 *
 * v1 ships **no** test for this file — no test for anything under `fondo_api/scheduler/`, in
 * fact — so every cell here is new coverage rather than a port. The plan calls this subsystem
 * *"the highest ratio of consequence to coverage in the migration"*; these are the cheapest
 * possible cells against the two branches `get_executer` actually has.
 */
describe('ExecuterFactory (get_executer)', () => {
  const notificationExecuter = { run: jest.fn() } as unknown as NotificationExecuter;
  const factory = new ExecuterFactory(notificationExecuter);

  it('resolves type 0 to the notification executer', () => {
    expect(factory.get(0)).toBe(notificationExecuter);
  });

  it.each([1, 2, -1, 99])('raises v1’s exact message for unknown type %i', (type) => {
    // v1: raise Exception("Executer type {} does not exist.".format(type))
    // The text is observable: it is interpolated into the runner's
    // `Error processing task with id: {id}, exception: {ex}` log line.
    expect(() => factory.get(type)).toThrow(`Executer type ${type} does not exist.`);
  });
});
