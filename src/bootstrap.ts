import type { NestApplicationOptions } from '@nestjs/common';

/**
 * The options **every** way of building the app must use — `main.ts` and every e2e suite.
 *
 * `bodyParser: false` is not a preference. Nest's built-in body parser throws from middleware,
 * i.e. before any guard runs, which puts a malformed-JSON 400 *ahead* of authentication. DRF
 * parses lazily inside the handler, so v1 answers 401 for a bad token even when the body is
 * also broken. `DrfRequestParsingMiddleware` + `DrfParserInterceptor` reproduce DRF's order,
 * and they can only do that if they own the parsing.
 *
 * Exported as a constant rather than written out twice so a test app cannot silently diverge
 * from the production one — a divergence that would make the e2e suite prove nothing about
 * the wiring it is meant to protect.
 */
export const NEST_APPLICATION_OPTIONS: NestApplicationOptions = {
  bodyParser: false,
};
