import type { Response } from 'express';
import { DjangoStack, type DjangoDepth } from './django-middleware-depth';

/** A callback that may still mutate response headers. */
export type BeforeHeadersHook = (response: Response) => void;

const HOOKS = Symbol('djangoBeforeHeadersHooks');

interface HookRegistration {
  readonly depth: DjangoDepth;
  readonly hook: BeforeHeadersHook;
  /** Registration index — the tiebreak for two hooks at the same depth. */
  readonly sequence: number;
}

interface HookState {
  readonly hooks: HookRegistration[];
  ran: boolean;
  /**
   * The deepest position whose hooks still run. `Infinity` until someone short-circuits;
   * see {@link skipBeforeHeadersHooks}.
   */
  floor: number;
  sequence: number;
}

/**
 * Registers `hook` to run on the last possible tick before the status line and headers are
 * flushed, at `depth` in v1's {@link DjangoStack}.
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
 * ## Ordering — condition **C21**
 *
 * Hooks run in **descending depth**: the view first, then slot 8, 7, … 1, then the transport
 * fixups. That is Django's response phase, and it is the *reverse* of the order `AppModule`
 * registers the middlewares in, because registration order is the order their **request**
 * phases run.
 *
 * ⚠️ This used to run FIFO, with a comment asserting that registration order already *was*
 * the response order. It is not — `DjangoCorsMiddleware` is registered fourth of six and its
 * response phase runs first of all the middlewares. Nothing observable depended on it (the
 * hooks that existed touched disjoint headers), which is precisely why it needed pinning
 * before Phase 3 makes slots 2 and 4 live. Ties keep registration order, via an explicit
 * sequence number rather than a reliance on `Array.prototype.sort` stability.
 */
export function onBeforeHeaders(
  response: Response,
  depth: DjangoDepth,
  hook: BeforeHeadersHook,
): void {
  const state = ensureState(response);
  state.hooks.push({ depth, hook, sequence: state.sequence });
  state.sequence += 1;
}

/**
 * Suppresses the response phases **below** `belowDepth` for this response. Hooks at
 * `belowDepth` and above it still run.
 *
 * ## The two v1 short-circuits this models
 *
 * * **`CommonMiddleware`'s `APPEND_SLASH` 301** is *returned* from `process_request`, so
 *   `MiddlewareMixin.__call__` still runs slot 3's own `process_response` (which is where
 *   `Content-Length` comes from) and then slots 2 and 1 — but nothing below slot 3. Verified
 *   on the live v1: the 301 carries neither `Vary` nor `X-Frame-Options` nor any
 *   `Access-Control-*`, while every other response carries at least `Vary: Origin`. Caller
 *   passes {@link DjangoStack.COMMON}.
 * * **`DisallowedHost`** (condition C19) is *raised*, so it is caught by the
 *   `convert_exception_to_response` wrapper around slot 3 and slot 3's own response phase is
 *   skipped too — which is why v1's 400 has **no** `Content-Length` where the 301 has one.
 *   Caller passes {@link DjangoStack.SESSION}.
 *
 * ⚠️ Before condition **C21** this took no argument and suppressed **every** hook. That was
 * the same set only because nothing above slot 3 registered one; adding `SessionMiddleware`
 * at slot 2 would have silently made "all" mean more than "below me".
 *
 * Calling this before any hook is registered is fine and is the normal case: the floor is
 * recorded on the response, so a hook registered later is filtered by it too.
 */
export function skipBeforeHeadersHooks(response: Response, belowDepth: DjangoDepth): void {
  const state = ensureState(response);
  state.floor = Math.min(state.floor, belowDepth);
}

/** Creates the hook state and patches `writeHead` exactly once per response. */
function ensureState(response: Response): HookState {
  const carrier = response as unknown as Record<symbol, unknown>;
  const existing = carrier[HOOKS] as HookState | undefined;
  if (existing !== undefined) {
    return existing;
  }

  const state: HookState = {
    hooks: [],
    ran: false,
    floor: Number.POSITIVE_INFINITY,
    sequence: 0,
  };
  carrier[HOOKS] = state;

  const originalWriteHead = response.writeHead.bind(response);
  response.writeHead = function patchedWriteHead(
    this: Response,
    ...args: Parameters<Response['writeHead']>
  ): Response {
    if (!state.ran) {
      state.ran = true;
      for (const registration of orderedHooks(state)) {
        registration.hook(response);
      }
    }
    return originalWriteHead(...args);
  } as Response['writeHead'];

  return state;
}

/** Django's response phase: deepest first, registration order within a depth. */
function orderedHooks(state: HookState): readonly HookRegistration[] {
  return state.hooks
    .filter((registration) => registration.depth <= state.floor)
    .sort((left, right) => right.depth - left.depth || left.sequence - right.sequence);
}

// Re-exported so a middleware only has to import from one place to register a hook.
export { DjangoStack, type DjangoDepth };
