export class ApiError extends Error {
  constructor (status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }

  static badRequest (message, details) {
    return new ApiError(400, 'bad_request', message, details)
  }

  static notFound (message, details) {
    return new ApiError(404, 'not_found', message, details)
  }

  static upstream (message, details) {
    return new ApiError(502, 'upstream_error', message, details)
  }

  static timeout (message, details) {
    return new ApiError(504, 'upstream_timeout', message, details)
  }
}
