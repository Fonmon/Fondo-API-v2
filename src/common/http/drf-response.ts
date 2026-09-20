import type { Response } from 'express';
import { markDrfRendered } from './drf-finalize-response';

/**
 * Sends a handler's return value the way DRF's `JSONRenderer` does — **including when it is
 * not an object**.
 *
 * ## Why this exists (found by a Phase 4 e2e cell, not by reading code)
 *
 * Nest's `ExpressAdapter.reply` branches on `isObject(body)`:
 *
 * ```js
 * if (isNil(body)) return response.send();
 * return isObject(body) ? response.json(body) : response.send(String(body));
 * ```
 *
 * so a handler returning the **empty string** produces a zero-byte body. DRF does not:
 *
 * ```python
 * >>> JSONRenderer().render('')     # measured in the v1 container
 * b'""'
 * >>> JSONRenderer().render(None)
 * b''
 * ```
 *
 * Only `None` renders as zero bytes; every other value is `json.dumps`ed. `LoanDetailView.patch`
 * returns `Response(msg, status=200)` with `msg = ''` for a denial and for a payout
 * (`views/loan.py:67`), so v1 answers those with the **two bytes `""`** and v2 was answering
 * with none — a real, client-visible difference on the two most common loan writes.
 *
 * The same shape returns in Phase 8: `FileDetailView.get` does `Response(url, status=200)`
 * with a plain string (`views/file.py:36`), which DRF renders as a quoted JSON string.
 *
 * ## Why `res.json` and not a manual `JSON.stringify`
 *
 * Express 5 applies `app.get('json replacer')` inside `res.json()`, and that replacer is how
 * every `BigInt` money field becomes a bare JSON number (plan rule 5b,
 * {@link JsonBigIntSetup}). Stringifying by hand here would bypass it and throw on the first
 * money column. `DjangoResponseHeadersMiddleware` then normalises the `Content-Type` to
 * DRF's `application/json` with no charset.
 *
 * {@link markDrfRendered} is called because this *is* a rendered DRF `Response`, so
 * `finalize_response`'s `Allow` / `Vary: Accept` headers belong on it (finding **F1**).
 *
 * ⚠️ A handler using this must inject `@Res()` **without** `passthrough`, or Nest will try to
 * send a second response.
 */
export function sendDrfBody(response: Response, status: number, data: unknown): void {
  markDrfRendered(response);
  if (data === undefined || data === null) {
    // `Response(status=...)` / `Response(None, ...)` — DRF renders zero bytes and
    // `DjangoResponseHeadersMiddleware` then removes the `Content-Type` entirely.
    response.status(status).type('application/json').send('');
    return;
  }
  response.status(status).json(data);
}
