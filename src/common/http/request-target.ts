/**
 * The request target, split the way WSGI splits it into `PATH_INFO` and `QUERY_STRING`.
 *
 * `request.originalUrl` rather than `request.url`: Nest mounts middleware with `app.use(path,
 * ...)`, and for any mount path other than `/` Express *trims the matched prefix* from
 * `req.url` for the duration of the middleware. `originalUrl` is the untouched target.
 */
export function splitQuery(target: string): [path: string, query: string] {
  const index = target.indexOf('?');
  return index === -1 ? [target, ''] : [target.slice(0, index), target.slice(index + 1)];
}
