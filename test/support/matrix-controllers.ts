import { All, Controller, type Type } from '@nestjs/common';
import { V1View } from '../../src/auth/decorators/v1-view.decorator';
import { V1_VIEW_NAMES, type V1ViewName } from '../../src/auth/permissions/permission-matrix';

/**
 * Stand-in controllers for the 14 v1 view classes, used only by `role-matrix.e2e-spec.ts`.
 *
 * Phase 1 ships one real route (`POST /api-token-auth`); the domain endpoints arrive in
 * Phases 3–8. The parity criterion nevertheless demands proof that **every cell** of
 * `list_permissions` behaves identically today — a guard bug found in Phase 6 is a guard bug
 * that shipped. These controllers are the exact mirror of what was done on the v1 side to
 * capture the ground truth: a bare `APIView` per view-class name, five methods, no business
 * logic, running the real permission stack.
 *
 * Each is mounted at `/__matrix/<ViewName>` and carries `@V1View('<ViewName>')`, so the
 * global `TokenAuthGuard` + `RolesGuard` pair decides the outcome exactly as it will for the
 * real controllers.
 */
function matrixController(
  viewName: string,
  path: string,
  register: V1ViewName | false,
): Type<unknown> {
  class MatrixController {
    handle(): { ok: true } {
      return { ok: true };
    }
  }

  const descriptor = Object.getOwnPropertyDescriptor(MatrixController.prototype, 'handle');
  /* istanbul ignore next -- the property is declared immediately above */
  if (descriptor === undefined) {
    throw new Error('handle() went missing');
  }
  All()(MatrixController.prototype, 'handle', descriptor);
  Controller(path)(MatrixController);
  if (register !== false) {
    V1View(register)(MatrixController);
  }
  Object.defineProperty(MatrixController, 'name', { value: `${viewName}MatrixController` });
  return MatrixController;
}

/** One controller per entry in `fondo_api/permissions.py:list_permissions`. */
export const MATRIX_CONTROLLERS: readonly Type<unknown>[] = V1_VIEW_NAMES.map((viewName) =>
  matrixController(viewName, `__matrix/${viewName}`, viewName),
);

/**
 * A controller with **no** `@V1View(...)` at all — the "route with no explicit rule" the
 * Phase 1 parity criteria require to fail closed.
 */
export const UNREGISTERED_CONTROLLER: Type<unknown> = matrixController(
  'Unregistered',
  '__matrix/UnregisteredView',
  false,
);

export const MATRIX_BASE_PATH = '/__matrix';
