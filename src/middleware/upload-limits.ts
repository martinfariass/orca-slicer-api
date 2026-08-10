/**
 * Upload size ceilings, in one place with no imports.
 *
 * They live apart from `upload.ts` because `error.ts` needs them to explain a
 * rejection and `upload.ts` needs `AppError` from `error.ts` — importing the
 * limits from `upload.ts` would close that loop. A leaf module keeps the
 * dependency graph acyclic and the load order irrelevant.
 */

export const MODEL_FIELD = "file";

/**
 * Read a size cap from the environment, in megabytes.
 *
 * Every cap here used to be a compile-time constant, so an operator whose
 * models exceeded one had no way to raise it: the only lever was rebuilding
 * the image. Unparseable values warn and fall back rather than throwing — a
 * typo in an env var must not stop the container from starting.
 */
function envMegabytes(name: string, fallbackMb: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallbackMb * 1024 * 1024;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Silent under test, where a suite feeds it garbage on purpose to prove
    // the fallback holds. Everywhere else an operator needs to know their
    // setting was ignored.
    if (process.env.NODE_ENV !== "test" || process.env.LOG_ERRORS === "1") {
      console.warn(
        `[upload] Ignoring ${name}="${raw}": expected a positive number of megabytes. Using ${fallbackMb} MB.`
      );
    }
    return fallbackMb * 1024 * 1024;
  }
  return Math.floor(parsed * 1024 * 1024);
}

/**
 * Model upload ceiling.
 *
 * This was a hardcoded 100 MB, which real multi-colour MakerWorld projects
 * exceed — and because multer reports the rejection as a `MulterError` rather
 * than an `AppError`, the caller saw a bare HTTP 500 "File too large" with
 * nothing actionable in it (bambuddy#2802). `errorHandler` now maps that to a
 * 413 naming this number, and the number itself is an operator decision.
 */
export const MAX_MODEL_UPLOAD_BYTES = envMegabytes("MAX_MODEL_UPLOAD_MB", 512);
export const MAX_BUNDLE_UPLOAD_BYTES = envMegabytes("MAX_BUNDLE_UPLOAD_MB", 50);
export const MAX_JSON_UPLOAD_BYTES = envMegabytes("MAX_JSON_UPLOAD_MB", 4);

export function formatUploadLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
