/**
 * Errors the tavern raises that are the CALLER's problem, not the server's.
 *
 * The REST handler's catch-all used to map every throw to `500 服务器内部错误`
 * with the real text buried in the log, so ordinary validation failures
 * ("这条回复还没有可切换的尝试", "角色正在输出中") reached the browser as an
 * opaque server error. Anything thrown as a {@link TavernUserError} carries the
 * status the client should see and a message that is safe to display.
 */

/** One caller-facing failure with an HTTP status attached. */
export class TavernUserError extends Error {
  /** HTTP status the REST layer should answer with. */
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'TavernUserError'
    this.status = status
  }
}

/** 404: the addressed record does not exist. */
export function notFound(message: string): TavernUserError {
  return new TavernUserError(message, 404)
}

/** 409: the request conflicts with work already in flight. */
export function conflict(message: string): TavernUserError {
  return new TavernUserError(message, 409)
}

/** 400: the request itself is malformed or references missing data. */
export function badRequest(message: string): TavernUserError {
  return new TavernUserError(message, 400)
}
