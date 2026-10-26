/** Error that maps one-to-one onto the API error envelope (see docs/SPEC.md, section 7). */
export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Missing or invalid token.') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'This token lacks the required scope.') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);
export const conflict = (message, details) => new ApiError(409, 'conflict', message, details);
export const validationFailed = (message, details) => new ApiError(422, 'validation_failed', message, details);
export const renderFailed = (message, details) => new ApiError(422, 'render_failed', message, details);
