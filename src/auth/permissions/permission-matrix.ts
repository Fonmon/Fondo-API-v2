import { Role } from './roles';

/**
 * A single rule from `fondo_api/permissions.py:list_permissions`.
 *
 * ```python
 * allowed_roles = list_permissions[view_name][method]
 * if isinstance(allowed_roles, list):
 *     return request.user.userprofile.role in allowed_roles
 * return request.user.userprofile.role <= allowed_roles
 * ```
 *
 * An `number` is a **ceiling** (`role <= N`); an array is an **exact membership set**.
 */
export type PermissionRule = number | readonly Role[];

/** The HTTP methods v1's `list_permissions` ever keys on. */
export type PermissionMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * **The single source of truth for route authorisation.** A verbatim port of
 * `fondo_api/permissions.py:list_permissions`, keyed by v1 view-class name so the two files
 * can be diffed line by line. Controllers bind to an entry with `@V1View('LoanView')`.
 *
 * Rules for maintainers:
 *  * ⚠️ **Adding a route without adding its entry here denies it.** That is v1's behavior
 *    (`except: return False`) and `RolesGuard` reproduces it deliberately — a route is
 *    unreachable, never open, until it appears below.
 *  * Do not "tidy" `3` into `[0,1,2,3]`. They are equivalent today only because 3 is the
 *    highest role; the ceiling form is what v1 wrote and what a new role would inherit.
 *  * A method absent from a view's entry is denied for **every** role, including ADMIN.
 *    `LoanView` has no `DELETE`, so `DELETE /api/loan` is 403 for role 0 — verified against
 *    the running v1 stack.
 *
 * `AlexaView`, `AuthView` (Alexa account-linking) and `UserActivateView` never appear in
 * v1's dict either: the first two are retired (plan §1) and the third clears its permission
 * classes entirely (`permission_classes = []`), which v2 expresses with `@Public()`. Those,
 * plus the four `django.contrib.auth` password-reset pages and `ObtainAuthToken`, are typed
 * as `UnguardedV1View` in `common/http/django-url-conf.ts`, so the URL table can name them
 * without them becoming permission keys.
 *
 * ⚠️ Condition **C20**: the key `RolesGuard` looks up here is the view **the URL table
 * resolved**, not the `@V1View(...)` of whichever Nest route Express matched. Adding an entry
 * below therefore also means adding (or already having) the corresponding pattern in
 * `DJANGO_URL_CONF` with the same name — the two are linked at compile time through
 * {@link V1ViewName}.
 */
export const PERMISSION_MATRIX = Object.freeze({
  LoanView: {
    GET: Role.MEMBER,
    POST: Role.MEMBER,
    PATCH: [Role.ADMIN, Role.TREASURER],
  },
  LoanDetailView: {
    GET: Role.MEMBER,
    PATCH: [Role.ADMIN, Role.TREASURER],
  },
  UserDetailView: {
    GET: Role.MEMBER,
    PATCH: Role.MEMBER,
    DELETE: Role.ADMIN,
  },
  UserView: {
    POST: Role.ADMIN,
    GET: Role.MEMBER,
    PATCH: [Role.ADMIN, Role.TREASURER],
  },
  ActivityYearView: {
    GET: Role.MEMBER,
    POST: Role.PRESIDENT,
  },
  ActivityYearDetailView: {
    GET: Role.MEMBER,
    POST: Role.PRESIDENT,
  },
  ActivityDetailView: {
    GET: Role.MEMBER,
    PATCH: Role.PRESIDENT,
    DELETE: Role.PRESIDENT,
  },
  LoanAppsView: {
    POST: Role.MEMBER,
  },
  NotificationView: {
    POST: Role.MEMBER,
  },
  FileView: {
    POST: Role.ADMIN,
    GET: Role.MEMBER,
  },
  FileDetailView: {
    GET: Role.MEMBER,
  },
  UserAppsView: {
    POST: Role.MEMBER,
  },
  AdminView: {
    GET: Role.ADMIN,
  },
  SavingAccountView: {
    GET: Role.MEMBER,
    POST: Role.MEMBER,
    PUT: [Role.ADMIN, Role.TREASURER],
  },
} satisfies Record<string, Partial<Record<PermissionMethod, PermissionRule>>>);

/**
 * The 14 view-class names, as a literal union — so `@V1View('LoanViw')` is a **compile**
 * error, not just a runtime one.
 */
export type V1ViewName = keyof typeof PERMISSION_MATRIX;

/** The 14 view names v1's `list_permissions` declares, in declaration order. */
export const V1_VIEW_NAMES: readonly V1ViewName[] = Object.freeze(
  Object.keys(PERMISSION_MATRIX) as V1ViewName[],
);

/** Index-friendly view of the matrix for lookups by an arbitrary (untrusted) string. */
const MATRIX_BY_NAME: Readonly<
  Record<string, Readonly<Partial<Record<PermissionMethod, PermissionRule>>>>
> = PERMISSION_MATRIX;

/**
 * `APIRolePermission.has_permission`, faithful down to the failure mode.
 *
 * v1's body is wrapped in a bare `try/except: return False`, so **every** miss — unknown
 * view, unknown method, missing `userprofile` relation, a `role` of `None` — denies. This
 * function is total and never throws for the same reason.
 */
export function isRoleAllowed(
  viewName: string | undefined,
  method: string,
  role: number | null | undefined,
): boolean {
  if (viewName === undefined) {
    // No `@V1View(...)` on the controller: v1's `list_permissions[view_name]` KeyError.
    return false;
  }
  const view = MATRIX_BY_NAME[viewName];
  if (view === undefined) {
    return false;
  }
  const rule = view[method as PermissionMethod];
  if (rule === undefined) {
    // `list_permissions[view_name][method]` KeyError -> `except: return False`.
    return false;
  }
  if (role === null || role === undefined || !Number.isInteger(role)) {
    // `request.user.userprofile` raising RelatedObjectDoesNotExist -> `except: return False`.
    return false;
  }
  if (Array.isArray(rule)) {
    return (rule as readonly Role[]).includes(role);
  }
  return role <= (rule as number);
}
