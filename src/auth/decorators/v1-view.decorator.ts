import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import { PERMISSION_MATRIX, type V1ViewName } from '../permissions/permission-matrix';

export const V1_VIEW_KEY = 'fondo:v1View';

/**
 * Binds a controller to its v1 view class, which is the key
 * `fondo_api/permissions.py:list_permissions` is indexed by.
 *
 * v1 authorises on `view.__class__.__name__`; keeping that name explicit (rather than
 * inferring it from the Nest controller's class name) means the permission matrix stays a
 * literal transcription of v1's dict, and renaming a v2 controller cannot silently change
 * who may call it.
 *
 * `V1ViewName` is a literal union of the 14 names, so a typo is a **compile** error. The
 * runtime check below is the belt to that braces: it fires for a cast or a JavaScript
 * caller, at class-decoration time — i.e. at import, before the app can boot — so a bad name
 * can never degrade into a silently-denied route that looks like a runtime bug.
 */
export function V1View(viewName: V1ViewName): CustomDecorator<string> {
  if (!(viewName in PERMISSION_MATRIX)) {
    throw new Error(
      `@V1View('${viewName}') does not match any entry in fondo_api/permissions.py:list_permissions. ` +
        `Known views: ${Object.keys(PERMISSION_MATRIX).join(', ')}`,
    );
  }
  return SetMetadata(V1_VIEW_KEY, viewName);
}
