/** 统一错误码：API 与 CLI 共用。 */
export type ErrorCode =
  | "METADATA_CORRUPT"
  | "UNSUPPORTED_FORMAT"
  | "FILE_MISSING"
  | "LENGTH_MISMATCH"
  | "CONTENT_MISMATCH"
  | "PATH_TRAVERSAL"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "TOO_LARGE"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "BAD_REQUEST":
    case "METADATA_CORRUPT":
    case "UNSUPPORTED_FORMAT":
      return 400;
    case "PATH_TRAVERSAL":
      return 403;
    case "TOO_LARGE":
    case "FILE_MISSING":
    case "LENGTH_MISMATCH":
    case "CONTENT_MISMATCH":
      return 422;
    default:
      return 500;
  }
}
