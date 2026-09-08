import type { SavingAccountService } from '../../saving-accounts/saving-account.service';
import type { HstoreMap } from '../../common/utils/hstore.codec';
import { SavingAccountCloseExecuter } from './saving-account-close.executer';

/**
 * **Phase 6 / D12** — the CAP auto-close executer.
 *
 * ⚠️ **Nothing here is a port.** v1 never built this: `services/saving_account.py` carries a
 * literal `# TODO: schedule task for closing CAP` and `scheduler/executers/factory.py` knows
 * only `type == 0`. The cells are written from the operator answers (**Q20**, **Q22**,
 * **Q38**, **Q39**) and from conditions **C74**, **C77** and **C78**.
 */
function payload(overrides: Partial<HstoreMap> = {}): HstoreMap {
  // Every hstore value is text — `HStoreField.get_prep_value` calls `str()` on the way in.
  return { type: 'saving_account_close', saving_account_id: '3', ...overrides };
}

describe('SavingAccountCloseExecuter (D12)', () => {
  let accounts: { closeAccount: jest.Mock };
  let executer: SavingAccountCloseExecuter;

  beforeEach(() => {
    accounts = { closeAccount: jest.fn().mockResolvedValue('closed') };
    executer = new SavingAccountCloseExecuter(accounts as unknown as SavingAccountService);
  });

  describe('the happy path', () => {
    it('closes the CAP the payload names', async () => {
      await expect(executer.run(payload())).resolves.toEqual({ ok: true, detail: 'closed' });

      expect(accounts.closeAccount).toHaveBeenCalledWith(3);
    });

    /** The id is stored as text, and `int()` is the coercion v1 would have used. */
    it('reads the id through CPython int(), so it arrives as a number', async () => {
      await executer.run(payload({ saving_account_id: '  4210  ' }));

      expect(accounts.closeAccount).toHaveBeenCalledWith(4210);
      expect(typeof (accounts.closeAccount.mock.calls[0] as [number])[0]).toBe('number');
    });

    /**
     * ⚠️ **The idempotent rerun is a success, not a failure.** The runner claims the row
     * *before* running it (**P7-D2**), so a pass that died after the claim leaves a row that
     * a later manual release will re-run against an already-closed CAP. Treating that as a
     * failure would make the retry path unusable.
     */
    it('reports success when the CAP was already closed', async () => {
      accounts.closeAccount.mockResolvedValue('already-closed');

      await expect(executer.run(payload())).resolves.toEqual({
        ok: true,
        detail: 'already-closed',
      });
    });

    /** **Q22** — a close notifies nobody. The executer has no notification dependency at all. */
    it('has no notification dependency to reach for (Q22)', () => {
      expect(Object.keys(executer)).toEqual(['accounts']);
    });
  });

  // ==========================================================================
  // C74 / C77 — the failure channel
  // ==========================================================================
  describe('the failure channel (C74, C77)', () => {
    /**
     * ⚠️ **This executer must `throw`, never return `ok: false`.**
     *
     * `ok: false` marks the row `processed`, logs one `WARN` and is **never retried** — for a
     * CAP that is "task processed, CAP still open, one WARN", a financial-state divergence no
     * later pass repairs. A `throw` releases the claim, so the next 10:00/14:00 pass tries
     * again.
     *
     * The compile-time half of this guarantee is the narrowed return type
     * `Promise<{ ok: true; detail: string }>`, which makes `ok: false` a **type error in the
     * implementation file**. This cell is the runtime half: whatever the service does, the
     * outcome is never a false `ok`.
     */
    it('propagates a close failure as a throw, not as ok: false', async () => {
      accounts.closeAccount.mockRejectedValue(new Error('deadlock detected'));

      await expect(executer.run(payload())).rejects.toThrow('deadlock detected');
    });

    it('never returns ok: false, on any reachable path', async () => {
      for (const result of ['closed', 'already-closed']) {
        accounts.closeAccount.mockResolvedValue(result);
        const outcome = await executer.run(payload());
        expect(outcome.ok).toBe(true);
      }
    });

    /** A CAP that vanished under its own task is loud, not silently "done". */
    it('propagates the missing-account error', async () => {
      accounts.closeAccount.mockRejectedValue(new Error('Saving account 3 does not exist;'));

      await expect(executer.run(payload())).rejects.toThrow(/does not exist/);
    });
  });

  // ==========================================================================
  // Payload decoding — fail closed (C23)
  // ==========================================================================
  describe('payload decoding', () => {
    /**
     * A decoder that failed *open* on an absent key would report success having closed
     * nothing — the one outcome this whole design exists to prevent (condition **C23**).
     */
    it('throws KeyError for an absent saving_account_id, and closes nothing', async () => {
      const { saving_account_id: _omitted, ...without } = payload();

      await expect(executer.run(without)).rejects.toThrow("KeyError: 'saving_account_id'");
      expect(accounts.closeAccount).not.toHaveBeenCalled();
    });

    it('refuses a SQL NULL value rather than coercing it', async () => {
      await expect(executer.run(payload({ saving_account_id: null }))).rejects.toThrow(/is NULL/);
      expect(accounts.closeAccount).not.toHaveBeenCalled();
    });

    it.each(['', 'abc', '3.5', '3,5'])(
      'raises CPython’s ValueError for a non-integer id %p',
      async (value) => {
        await expect(executer.run(payload({ saving_account_id: value }))).rejects.toThrow(
          /invalid literal for int/,
        );
        expect(accounts.closeAccount).not.toHaveBeenCalled();
      },
    );
  });
});
