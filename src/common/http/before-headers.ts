import type { Response } from 'express';

/** A callback that may still mutate response headers. */
export type BeforeHeadersHook = (response: Response) => void;

const HOOKS = Symbol('djangoBeforeHeadersHooks');

interface HookState {
  readonly hooks: BeforeHeadersHook[];
  ran: boolean;
}

/**
 * Runs `hook` on the last possible tick before the status line and headers are flushed.
 *
 * ## Why this exists
 *
 * Django middleware is a **pair** of phases: `process_request` runs top-down before the view,
 * `process_response` runs bottom-up after it. v1's response headers (`Vary: Origin`,
 * `Access-Control-*`, `X-Frame-Options`) are all added in the *response* phase, i.e. after the
 * view has already set its own (`Vary: Accept`, `Allow`, `Content-Type`). Express middleware
 * has no response phase — it only sees the request — so a port that sets those headers on the
 * way in cannot merge with what the handler sets on the way out, and `Vary: Accept, Origin`
 * (v1's actual value) becomes unreachable.
 *
 * Wrapping `writeHead` gives back the missing phase: Node calls it exactly once, implicitly
 * from `res.end()` when a handler never calls it directly, and at that point every header is
 * present but nothing has gone on the wire. `res.on('finish')` is the usual suggestion and is
 * **too late** — the headers are already sent.
 *
 * Hooks run in registration order, which mirrors Django's reverse-`MIDDLEWARE` response order
 * because the middlewares are registered in `AppModule` in the order their response phases run
 * (`CorsMiddleware` is last in v1's `MIDDLEWARE`, so its response phase runs first).
 */
export function onBeforeHeaders(response: Response, hook: BeforeHeadersHook): void {
  const existing = (response as unknown as Record<symbol, unknown>)[HOOKS] as HookState | undefined;
  if (existing !== undefined) {
    existing.hooks.push(hook);
    return;
  }

  const state: HookState = { hooks: [hook], ran: false };
  (response as unknown as Record<symbol, unknown>)[HOOKS] = state;

  const originalWriteHead = response.writeHead.bind(response);
  response.writeHead = function patchedWriteHead(
    this: Response,
    ...args: Parameters<Response['writeHead']>
  ): Response {
    if (!state.ran) {
      state.ran = true;
      for (const each of state.hooks) {
        each(response);
      }
    }
    return originalWriteHead(...args);
  } as Response['writeHead'];
}

/**
 * Suppresses every registered hook for this response.
 *
 * The one v1 response that skips the CORS and clickjacking middlewares entirely is
 * `CommonMiddleware`'s `APPEND_SLASH` redirect: `CommonMiddleware` sits *above* them in
 * `MIDDLEWARE`, so it builds that 301 after their response phases have already run. Verified
 * on the live v1 — the 301 carries neither `Vary` nor `X-Frame-Options` nor any
 * `Access-Control-*`, while every other response carries at least `Vary: Origin`.
 */
export function skipBeforeHeadersHooks(response: Response): void {
  const state = (response as unknown as Record<symbol, unknown>)[HOOKS] as HookState | undefined;
  if (state === undefined) {
    // Nothing registered yet (only possible if the middleware order changes); mark the
    // response so a later registration cannot resurrect the hooks either.
    (response as unknown as Record<symbol, unknown>)[HOOKS] = { hooks: [], ran: true };
    return;
  }
  state.ran = true;
}
