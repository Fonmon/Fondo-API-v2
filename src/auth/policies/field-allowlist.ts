import { DrfException } from '../../common/http/drf.exception';

/**
 * A field-level authorisation primitive.
 *
 * A route-level role matrix answers "may this caller call this endpoint at all". §5 D1 needs
 * a second, finer answer — "may this caller write *this field* of *this row*" — which is why
 * it could not be expressed in `list_permissions` and why v1 has the escalation hole
 * (`services/user.py:232` writes `user.role` from the request body for any caller).
 *
 * The allowlist is deliberately **positive**: a field nobody thought about is rejected, in
 * the same spirit as {@link isRoleAllowed}'s default deny. Denials raise DRF's generic
 * `PermissionDenied` (403) with no field name in the body, so a rejected write cannot be
 * used to enumerate which fields exist.
 */
export class FieldAllowlist {
  private readonly allowed: ReadonlySet<string>;

  private constructor(allowed: Iterable<string>) {
    this.allowed = new Set(allowed);
  }

  static of(...fields: readonly string[]): FieldAllowlist {
    return new FieldAllowlist(fields);
  }

  static from(fields: Iterable<string>): FieldAllowlist {
    return new FieldAllowlist(fields);
  }

  /** Nothing may be written. Used for a section the caller has no rights over at all. */
  static none(): FieldAllowlist {
    return new FieldAllowlist([]);
  }

  permits(field: string): boolean {
    return this.allowed.has(field);
  }

  /** The subset of `fields` this allowlist rejects, in the order given. */
  rejected(fields: Iterable<string>): string[] {
    return [...fields].filter((field) => !this.allowed.has(field));
  }

  /** True when the caller may write nothing at all in this section. */
  isEmpty(): boolean {
    return this.allowed.size === 0;
  }

  /**
   * Throws `403` if any field is not permitted, **or if this allowlist is empty**.
   *
   * ⚠️ Reject, never silently drop. A write the caller is not entitled to make must fail
   * loudly — §5 D1 states this explicitly for the `finance` section, and the same reasoning
   * applies to `role`: a silent no-op tells an attacker nothing and tells an honest client
   * that its update succeeded when it did not.
   *
   * ⚠️ **Empty means deny, including for an empty field set** (review finding S5). Before
   * this, `FieldAllowlist.none().assert([])` passed, because `rejected([])` is `[]` — so a
   * MEMBER submitting a `finance` section whose values happened to be unchanged got the
   * silent no-op D1 explicitly forbids. Under the decided `changedFields` reading that is
   * the *common* case, not an edge case: v1's client posts `personal` and `finance` in every
   * body, so an ordinary profile save yields no changed finance fields at all.
   *
   * An empty allowlist is only ever produced for a section the caller has no rights over
   * (`FieldAllowlist.none()`), so failing closed here cannot refuse a legitimate write.
   * A *non*-empty allowlist still accepts an empty field set — a PATCH that changes nothing
   * inside a section the caller may write is a no-op, not a violation.
   *
   * This is defence in depth, not the primary control: §7 "C8 resolved" puts the section
   * gate first, so `assertUserPatchAllowed` refuses at the `body.type` level before any
   * field comparison happens.
   */
  assert(fields: Iterable<string>): void {
    if (this.isEmpty() || this.rejected(fields).length > 0) {
      throw DrfException.permissionDenied();
    }
  }

  /** For diagnostics and tests; sorted so assertions are stable. */
  toArray(): string[] {
    return [...this.allowed].sort();
  }
}
