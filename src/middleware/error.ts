import type { NextFunction, Response, Request } from "express";
import { MulterError } from "multer";
import {
  MAX_MODEL_UPLOAD_BYTES,
  MODEL_FIELD,
  formatUploadLimit,
} from "./upload-limits";

export class AppError extends Error {
  status: number = 500;
  causeMessage?: string;

  constructor(status: number, message: string, causeMessage?: string) {
    super(message);
    this.status = status;
    this.causeMessage = causeMessage;
  }
}

/**
 * Translate a multer rejection into an `AppError`.
 *
 * `MulterError` carries a `code`, not a `status`, so before this every upload
 * rejection fell through to the default 500 with a bare message — a 120 MB
 * model produced `HTTP 500 {"message":"File too large"}` and nothing else, and
 * callers reasonably concluded the slicer had crashed. bambuddy#2802 was spent
 * chasing body-size settings on a reverse proxy that was never involved,
 * because a 500 gives no reason to suspect an upload cap.
 *
 * The size case is the one worth spelling out: it names the ceiling and where
 * it lives, so nobody goes looking for it in the wrong layer again.
 */
function fromMulterError(err: MulterError): AppError {
  switch (err.code) {
    case "LIMIT_FILE_SIZE": {
      const limit = formatUploadLimit(MAX_MODEL_UPLOAD_BYTES);
      const what =
        err.field === MODEL_FIELD || err.field === undefined
          ? "The model file"
          : `The '${err.field}' upload`;
      return new AppError(
        413,
        `${what} exceeds this slicer's ${limit} upload limit.`,
        `The limit is enforced by the slicer service itself, not by any proxy in front of it. ` +
          `Raise it by setting MAX_MODEL_UPLOAD_MB on the slicer container and restarting it.`
      );
    }
    case "LIMIT_FILE_COUNT":
    case "LIMIT_PART_COUNT":
    case "LIMIT_FIELD_COUNT":
      return new AppError(413, `Too many parts in the upload (${err.code}).`);
    case "LIMIT_UNEXPECTED_FILE":
      return new AppError(
        400,
        `Unexpected file field '${err.field}' in the upload.`
      );
    default:
      return new AppError(400, `Upload rejected: ${err.message}`);
  }
}

/* eslint-disable @typescript-eslint/no-unused-vars */
export function errorHandler(
  rawErr: AppError | MulterError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const err =
    rawErr instanceof MulterError ? fromMulterError(rawErr) : (rawErr as AppError);

  // Log the original error's stack: for a translated MulterError the
  // AppError above was constructed here, so its stack points at this file
  // rather than at the upload that failed.
  console.error(
    `[${new Date().toISOString()}] Error: ${err.message}
    at ${req.method} ${req.originalUrl} with ${rawErr.stack ?? "no stack trace"}
    ${err.causeMessage ? `Cause: ${err.causeMessage}` : ""}`
  );

  const status = typeof err.status === "number" ? err.status : 500;

  // Include `causeMessage` (the underlying CLI stderr / wrapped error) as
  // `details` in the response. Bambuddy reads this field to surface the
  // actual slice-rejection reason in its own log instead of the generic
  // top-level `Failed to slice the model`. Without it, every CLI failure
  // looks the same on the calling side and the embedded-settings fallback
  // hides the real cause.
  const body: { message: string; details?: string } = { message: err.message };
  if (err.causeMessage) {
    body.details = err.causeMessage;
  }
  res.status(status).json(body);
}
