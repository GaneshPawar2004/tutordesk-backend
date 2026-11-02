/** Error with an HTTP status and a stable machine-readable code. */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) =>
  new ApiError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = 'Please sign in again') =>
  new ApiError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You do not have access to this', code = 'FORBIDDEN') =>
  new ApiError(403, code, message);
const notFound = (what = 'Resource') =>
  new ApiError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (message, code = 'CONFLICT') => new ApiError(409, code, message);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict };
