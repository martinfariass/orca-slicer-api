import { promises as fs } from "fs";
import type { SliceMetaData } from "./models";
import type { ModelSource } from "./slicing.service";

/**
 * Adapt a multer upload to what `sliceModel` takes.
 *
 * `/slice` streams the model part to a temp file and keeps the small profile
 * parts in memory, so a model upload carries `path` and no `buffer`. Handling
 * both shapes keeps the routes working whichever storage engine is in use.
 */
export function modelSourceFromUpload(
  file: Express.Multer.File,
): ModelSource {
  return file.path ? { path: file.path } : file.buffer;
}

/**
 * Delete a model upload's temp file if it is still there.
 *
 * `sliceModel` moves the file into its workdir, and the workdir cleanup takes
 * it from there — so on the happy path this finds nothing. It matters when
 * slicing throws before the move (a full disk, a bad filename), where the
 * upload would otherwise sit in TMPDIR until the container restarts.
 */
export async function discardUpload(
  file: Express.Multer.File,
): Promise<void> {
  if (!file.path) return;
  try {
    await fs.rm(file.path, { force: true });
  } catch (error) {
    console.warn(
      `[upload] Could not remove temp upload ${file.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function generateMetaDataHeaders(metadata: SliceMetaData) {
  const headers: Record<string, string> = {};
  headers["X-Print-Time-Seconds"] = metadata.printTime.toString();
  headers["X-Filament-Used-g"] = metadata.filamentUsedG.toString();
  headers["X-Filament-Used-mm"] = metadata.filamentUsedMm.toString();
  return headers;
}
