/** Thrown by the store when an update targets a row that does not exist. */
export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`not_found: ${what} ${id}`);
    this.name = "NotFoundError";
  }
}
