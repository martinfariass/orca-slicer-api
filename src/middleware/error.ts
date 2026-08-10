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

/**
 * Should a handled error be written to the console?
 *
 * Not under test. The suites assert dozens of 4xx and a handful of 5xx on
 * purpose, and logging each one turned a green run into a wall of red text
 * that read like failures. Nothing is lost: every one of those tests asserts
 * on the response, and when one *does* fail supertest prints the body --
 * which carries the same `message` and `details` the log line would have.
 *
 * `LOG_ERRORS=1` forces them back on for when you are debugging a suite and
 * want the server's side of the story inline.
 */
function shouldLogErrors(): boolean {
  if (process.env.LOG_ERRORS === "1") return true;
  return process.env.NODE_ENV !== "test";
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

  const status = typeof err.status === "number" ? err.status : 500;

  // Log volume in proportion to what the error means. A 4xx is the service
  // working -- a caller sent something wrong and was told so -- and a stack
  // trace for one says nothing the message doesn't, while burying the 5xx
  // that matter. The test suite asserts dozens of 4xx deliberately, so a
  // twenty-line trace each turned a green run into a wall of red text.
  const where = `${req.method} ${req.originalUrl}`;
  const cause = err.causeMessage ? ` Cause: ${err.causeMessage}` : "";

  if (shouldLogErrors()) {
    if (status >= 500) {
      // The original error's stack, not `err`'s: for a translated MulterError
      // the AppError above was constructed here, so its stack would point at
      // this file rather than at the upload that failed.
      console.error(
        `[${new Date().toISOString()}] Error: ${err.message}
    at ${where} with ${rawErr.stack ?? "no stack trace"}
   ${cause}`
      );
    } else {
      // A 4xx is the service working: a caller sent something wrong and was
      // told so. One line, no stack -- the trace says nothing the message
      // doesn't and buries the 5xx that matter.
      console.warn(
        `[${new Date().toISOString()}] ${status} ${where} -- ${err.message}`
      );
    }
  }

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
