import { DrfException } from './drf.exception';
import type { ResolvedViewName } from './django-url-conf';

/**
 * `rest_framework.metadata.SimpleMetadata.determine_metadata` — the document `APIView.options`
 * answers `OPTIONS` with (`rest_framework/views.py:510-517`):
 *
 * ```python
 * def options(self, request, *args, **kwargs):
 *     if self.metadata_class is None:
 *         return self.http_method_not_allowed(request, *args, **kwargs)
 *     data = self.metadata_class().determine_metadata(request, self)
 *     return Response(data, status=status.HTTP_200_OK)
 * ```
 *
 * ```python
 * metadata['name']        = view.get_view_name()
 * metadata['description'] = view.get_view_description()
 * metadata['renders']     = [r.media_type for r in view.renderer_classes]
 * metadata['parses']      = [p.media_type for p in view.parser_classes]
 * if hasattr(view, 'get_serializer'):        # neither of ours does — see below
 *     ...
 * ```
 *
 * ## Why only two views appear here
 *
 * `OPTIONS` is a method like any other to `APIRolePermission`, and
 * `list_permissions[view][method]` has **no `OPTIONS` key for any view**, so its bare `except`
 * denies it: every guarded route answers **403** before `options()` could run, for every role
 * including ADMIN. Only the two views that clear `permission_classes` ever reach the metadata
 * handler:
 *
 * | view | v1 | bytes |
 * |---|---|---|
 * | `UserActivateView` (`permission_classes = []`) | 200 + this document | 172 |
 * | `ObtainAuthToken` (`permission_classes = ()`) | 200 + this document | 164 |
 *
 * Both captured from the live v1 (`api.settings.production`, gunicorn) and reproduced verbatim
 * below. `AuthView` would be a third, but Alexa is not migrated (plan §1) and v2 has no route
 * behind `/api/authorize`. A future public view must add its entry here; a guarded one must
 * not, because it would never be reachable.
 *
 * ## Why there is no `actions` key
 *
 * `determine_actions` runs only `if hasattr(view, 'get_serializer')`. `UserActivateView` is a
 * bare `APIView`. `ObtainAuthToken` in DRF **3.11.2** declares `serializer_class` but no
 * `get_serializer` (that arrives in a later release), so the branch is skipped there too —
 * confirmed by reading `rest_framework/authtoken/views.py` in the pinned container *and* by
 * the captured 164-byte body, which has no `actions`.
 *
 * Registered deviation **P1-D2** used to cover the gap (v2 answered `405`); this replaces it.
 * The residual is the browsable API, which v2 does not ship: with `Accept: text/html` v1
 * renders an HTML page here — as it does for *every* DRF response, including the 405s v2
 * already answers as JSON — and v2 always answers JSON. That is D13's species and is
 * registered as **P3-D8**, not specific to `OPTIONS`.
 */
export interface DrfSimpleMetadata {
  /** `view.get_view_name()` — the class name, camel-case split, `View`/`ViewSet` stripped. */
  readonly name: string;
  /** `view.get_view_description()` — the class docstring; both of ours have none. */
  readonly description: string;
  /** `renderer_classes`, in declaration order. */
  readonly renders: readonly string[];
  /** `parser_classes`, in declaration order. */
  readonly parses: readonly string[];
}

/** `DEFAULT_RENDERER_CLASSES` — v1 leaves it at DRF's default. */
const DEFAULT_RENDERS = ['application/json', 'text/html'] as const;

/** `DEFAULT_PARSER_CLASSES` — likewise. */
const DEFAULT_PARSES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
] as const;

export const DRF_VIEW_METADATA = {
  /** `UserActivateView(APIView)` with `permission_classes = []` — DRF's defaults throughout. */
  UserActivateView: {
    name: 'User Activate',
    description: '',
    renders: DEFAULT_RENDERS,
    parses: DEFAULT_PARSES,
  },
  /**
   * `ObtainAuthToken` overrides both lists, and in this order:
   *
   * ```python
   * parser_classes = (parsers.FormParser, parsers.MultiPartParser, parsers.JSONParser,)
   * renderer_classes = (renderers.JSONRenderer,)
   * ```
   *
   * — which is why this is the one view in the service with no `Vary: Accept`.
   */
  ObtainAuthToken: {
    name: 'Obtain Auth Token',
    description: '',
    renders: ['application/json'],
    parses: ['application/x-www-form-urlencoded', 'multipart/form-data', 'application/json'],
  },
} as const satisfies Partial<Record<ResolvedViewName, DrfSimpleMetadata>>;

export type DrfMetadataViewName = keyof typeof DRF_VIEW_METADATA;

/**
 * `APIView.dispatch`'s handler lookup for a method the view does not implement, with
 * `OPTIONS` split out because `APIView` **does** implement it.
 *
 * Called from the `@All()` fallback of the two views that permit anonymous access. Everywhere
 * else the guard has already answered 403, so this is never reached with `OPTIONS`.
 *
 * @throws `DrfException.methodNotAllowed` for every method except `OPTIONS`.
 */
export function drfOptionsMetadata(
  method: string,
  view: DrfMetadataViewName,
  allow: string,
): DrfSimpleMetadata {
  if (method !== 'OPTIONS') {
    throw DrfException.methodNotAllowed(method, allow);
  }
  return DRF_VIEW_METADATA[view];
}
