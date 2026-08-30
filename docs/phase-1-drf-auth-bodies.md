# Phase 1 — the DRF 401/403/400/405 response bodies, derived

`MIGRATION_PLAN.md` Phase 1 flags this as an open item:

> ⚠️ **Pin the auth-failure body before this phase closes.** DRF's 401/403 responses are
> `{"detail": …}`, **not** the `{"message": …}` shape used everywhere else — and v1 has
> **zero** tests asserting them, so the exact strings are unknown.

This document closes it. Nothing below was written from memory.

---

## How it was derived

Two independent methods, and they agree.

### 1. Reading the pinned source

`~/Projects/Fondo-API/requirements.txt` pins `djangorestframework==3.11.2` and
`Django==2.2.27`. The 3.11.2 sdist was downloaded from PyPI
(`files.pythonhosted.org/packages/source/d/djangorestframework/djangorestframework-3.11.2.tar.gz`)
and read directly. The relevant chain:

| File | What it decides |
|---|---|
| `rest_framework/views.py:exception_handler` | `if isinstance(exc.detail, (list, dict)): data = exc.detail` else `data = {'detail': exc.detail}`; attaches `WWW-Authenticate` from `exc.auth_header` |
| `rest_framework/views.py:APIView.handle_exception` | For `NotAuthenticated` / `AuthenticationFailed`: **if the first authenticator returns an `authenticate_header()`, the status stays 401; otherwise it is coerced to 403** |
| `rest_framework/views.py:APIView.permission_denied` | `NotAuthenticated` when no authenticator succeeded, `PermissionDenied` otherwise |
| `rest_framework/views.py:APIView.initial` | `perform_authentication()` runs **before** `check_permissions()` |
| `rest_framework/authentication.py:TokenAuthentication` | the four `AuthenticationFailed` messages, and `authenticate_header()` returning the literal `Token` |
| `rest_framework/exceptions.py` | `default_detail` for each exception class |
| `rest_framework/authtoken/serializers.py` | the login validation messages |

**The 401-vs-403 question the plan called out:** `TokenAuthentication.authenticate_header()`
returns `self.keyword`, i.e. the truthy string `'Token'`. So the `else` branch that would
coerce a 401 into a 403 is **never taken in this project**. Every authentication failure is a
**401 with `WWW-Authenticate: Token`**; only `APIRolePermission` denials are 403.

### 2. Running the pinned stack

A minimal Django project was built in a `python:3.9-slim` container with exactly
`Django==2.2.27` + `djangorestframework==3.11.2`, configured with v1's `REST_FRAMEWORK`
block copied verbatim from `api/settings/base.py`:

```python
'DEFAULT_PERMISSION_CLASSES': (
    'rest_framework.permissions.IsAuthenticated',
    'fondo_api.permissions.APIRolePermission',
),
'DEFAULT_AUTHENTICATION_CLASSES': (
    'rest_framework.authentication.TokenAuthentication',
),
```

with `fondo_api/permissions.py` imported **unmodified** from the frozen v1 repo and
`fondo_api/models.py:UserProfile` reproduced as a real multi-table-inheritance model so
`request.user.userprofile.role` resolves the way it does in production. One bare `APIView`
per view-class name in `list_permissions`, five methods each. v1 itself was never modified
and never run against (plan §1: v1 is frozen).

---

## Authentication failures — all 401, all with `WWW-Authenticate: Token`

| Case | Status | Body | DRF source |
|---|---|---|---|
| No `Authorization` header | 401 | `{"detail":"Authentication credentials were not provided."}` | `NotAuthenticated.default_detail` |
| `Authorization: Bearer <key>` (wrong scheme) | 401 | *same as above* | `authenticate()` returns `None`, `IsAuthenticated` then fails |
| `Authorization:` (empty value) | 401 | *same as above* | `bytes.split()` → `[]` |
| `Authorization: Token` (keyword only) | 401 | `{"detail":"Invalid token header. No credentials provided."}` | `len(auth) == 1` |
| `Authorization: Token a b` | 401 | `{"detail":"Invalid token header. Token string should not contain spaces."}` | `len(auth) > 2` |
| Token not in `authtoken_token` | 401 | `{"detail":"Invalid token."}` | `model.DoesNotExist` |
| Token whose user has `is_active = false` | 401 | `{"detail":"User inactive or deleted."}` | `if not token.user.is_active` |
| Token bytes that are not valid UTF-8 | 401 | `{"detail":"Invalid token header. Token string should not contain invalid characters."}` | `auth[1].decode()` raising `UnicodeError` |

Two behaviors worth stating explicitly because they are easy to get backwards:

* **A missing or wrong-scheme header is not an authentication *error*.** `TokenAuthentication`
  returns `None` and the request proceeds as anonymous; the 401 is produced later by
  `IsAuthenticated`, with the *different* `Authentication credentials were not provided.`
  body. Confusing the two produces the right status and the wrong body.
* **The scheme match is case-insensitive** (`auth[0].lower() != self.keyword.lower()`), so
  `authorization: token <key>` authenticates.

## Permission failures — 403, no challenge header

| Case | Status | Body |
|---|---|---|
| Authenticated, role not allowed | 403 | `{"detail":"You do not have permission to perform this action."}` |
| Authenticated, view absent from `list_permissions` | 403 | *same* |
| Authenticated, method absent from the view's entry (e.g. `DELETE /api/loan`, **even as ADMIN**) | 403 | *same* |
| Authenticated, `auth_user` row with no `fondo_api_userprofile` sibling | 403 | *same* |

All four are v1's bare `except: return False`. There is no `WWW-Authenticate` header on a 403.

## `POST /api-token-auth` — login

| Case | Status | Body |
|---|---|---|
| Valid credentials | 200 | `{"token":"<40 hex chars>"}` — the **same** string on every subsequent login (`get_or_create`) |
| Wrong password | 400 | `{"non_field_errors":["Unable to log in with provided credentials."]}` |
| Unknown username | 400 | *same* |
| `is_active = false` user | 400 | *same* |
| Password with surrounding spaces | 400 | *same* (`trim_whitespace=False` on `password`) |
| Both fields missing | 400 | `{"username":["This field is required."],"password":["This field is required."]}` |
| One field missing | 400 | `{"<field>":["This field is required."]}` |
| Blank / whitespace-only username | 400 | `{"username":["This field may not be blank."]}` |
| Blank password | 400 | `{"password":["This field may not be blank."]}` |
| `null` field | 400 | `{"<field>":["This field may not be null."]}` |
| Boolean / array / object field | 400 | `{"<field>":["Not a valid string."]}` |
| Numeric field | **200** if it matches a username — `CharField` coerces with `str()` |
| Username with surrounding spaces | **200** — `username` uses the default `trim_whitespace=True` |
| Non-dict JSON body | 400 | `{"non_field_errors":["Invalid data. Expected a dictionary, but got list."]}` (`list`/`str`/`int`/`float`/`bool`/`NoneType`) |
| Unknown extra fields | 200 | ignored |
| `GET`/`PUT`/`PATCH`/`DELETE` | 405 | `{"detail":"Method \"GET\" not allowed."}`, header `Allow: POST, OPTIONS` |

Key order in the multi-field 400 follows the serializer's field declaration order:
**`username` then `password`**. DRF renders JSON with compact separators (`SHORT_SEPARATORS`),
which `JSON.stringify` matches.

## Ordering: authentication before everything

`APIView.dispatch` calls `initial()` (authentication, then permissions) **before** it
dispatches to a handler or to `http_method_not_allowed`. Consequences, all confirmed by
running the stack:

* `GET /api-token-auth` with a bad token → **401**, not 405.
* `POST /api-token-auth` with a bad token → **401**, not a login attempt. `permission_classes
  = []` clears permissions, never authenticators — so this holds for every `@Public()` route,
  including `POST /api/user/activate/<id>` in Phase 3.
* `OPTIONS` on a guarded view is authenticated and permission-checked like any other method.
