export type ErrorStatus = 400 | 404 | 409 | 502;

export class HttpError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const notFound = (what: string, id: string) => new HttpError(404, "not_found", `No ${what} with id ${id}`);
export const invalidTransition = (message: string) => new HttpError(409, "invalid_transition", message);
