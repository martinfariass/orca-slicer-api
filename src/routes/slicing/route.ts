import { Router } from "express";
import { uploadFullPrint } from "../../middleware/upload";
import { AppError } from "../../middleware/error";
import type {
  SliceMetaData,
  SlicingSettings,
  UploadedProfiles,
} from "./models";
import { getMetaDataFromFile, sliceModel } from "./slicing.service";
import { progressStore } from "./progress-store";
import { createReadStream, createWriteStream, promises as fs } from "fs";
import path from "path";
import archiver from "archiver";
import { once } from "events";
import { finished, pipeline } from "stream/promises";
import {
  discardUpload,
  generateMetaDataHeaders,
  modelSourceFromUpload,
} from "./helpers";
import {
  cleanupSliceWorkspace,
  sliceTempStatus,
} from "./temp-workspaces";

const router = Router();

async function sendAndReleaseWorkspace(
  res: import("express").Response,
  filePath: string,
  downloadName: string,
  workdir: string,
): Promise<boolean> {
  const stat = await fs.stat(filePath);
  const source = createReadStream(filePath);
  const open = once(source, "open");
  source.on("error", () => undefined);
  await open;

  res.attachment(downloadName);
  res.set("Content-Length", String(stat.size));

  // On Unix the already-open file descriptor stays readable after unlink.
  // Removing the workspace before piping the response ensures a caller never
  // observes a terminal slice while its lock/config tree still exists.
  const cleaned = await cleanupSliceWorkspace(workdir);
  await pipeline(source, res);
  return cleaned;
}

router.get("/status", async (_req, res) => {
  res.json(await sliceTempStatus());
});

// Live progress endpoint. Bambuddy generates a request_id when it submits
// to POST /slice and polls this in parallel (the POST holds the
// connection open for the duration of the slice — multi-second to
// multi-minute on complex models — so the only way to surface progress
// to the user is a side-channel like this one). Returns 404 once the
// slice has completed and the entry's grace window has elapsed.
router.get("/progress/:requestId", (req, res) => {
  const id = req.params.requestId;
  const snapshot = progressStore.get(id);
  if (!snapshot) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    stage: snapshot.stage,
    total_percent: snapshot.totalPercent,
    plate_percent: snapshot.platePercent,
    plate_index: snapshot.plateIndex,
    plate_count: snapshot.plateCount,
    updated_at: snapshot.updatedAt,
  });
});

router.post(
  "/",
  uploadFullPrint.fields([
    { name: "file", maxCount: 1 },
    { name: "printerProfile", maxCount: 1 },
    { name: "presetProfile", maxCount: 1 },
    // Bambu Lab supports up to 16 AMS slots (4 AMS units of 4 trays each).
    // Accepting that many filament profiles covers every realistic input.
    { name: "filamentProfile", maxCount: 16 },
  ]),
  async (req, res) => {
    if (!req.files || Array.isArray(req.files)) {
      throw new AppError(
        400,
        "Invalid file upload format: files must be uploaded as named fields",
      );
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    if (!files["file"]) {
      throw new AppError(400, "Model file is required for slicing");
    }

    const modelFile = files["file"][0];
    const abortController = new AbortController();
    const abortSlice = () => {
      if (!res.writableFinished) abortController.abort();
    };
    req.once("aborted", abortSlice);
    res.once("close", abortSlice);

    let workdir: string | undefined;
    try {
      let sliced;
      try {
        sliced = await sliceModel(
          modelSourceFromUpload(modelFile),
          modelFile.originalname,
          req.body as SlicingSettings,
          {
            printer: files["printerProfile"]?.[0]?.buffer,
            preset: files["presetProfile"]?.[0]?.buffer,
            filaments: files["filamentProfile"]?.map((f) => f.buffer) ?? [],
          } as UploadedProfiles,
          { signal: abortController.signal },
        );
      } finally {
        // No-op once sliceModel has moved the upload into its workdir; the
        // safety net is for a failure before that point.
        await discardUpload(modelFile);
      }
      const { gcodes } = sliced;
      workdir = sliced.workdir;

      if (gcodes.length === 1) {
        const metadata = await getMetaDataFromFile(gcodes[0]);
        res.set(generateMetaDataHeaders(metadata));
        const cleaned = await sendAndReleaseWorkspace(
          res,
          gcodes[0],
          path.basename(gcodes[0]),
          workdir,
        );
        if (cleaned) workdir = undefined;
      } else {
        const metadata: SliceMetaData = {
          printTime: 0,
          filamentUsedG: 0,
          filamentUsedMm: 0,
        };

        for (const filePath of gcodes) {
          if (!filePath.endsWith(".gcode")) continue;

          const fileMetadata = await getMetaDataFromFile(filePath);
          metadata.printTime += fileMetadata.printTime;
          metadata.filamentUsedG += fileMetadata.filamentUsedG;
          metadata.filamentUsedMm += fileMetadata.filamentUsedMm;
        }

        res.set(generateMetaDataHeaders(metadata));
        const archivePath = path.join(workdir, "result.zip");
        const archive = archiver("zip", { zlib: { level: 9 } });
        const archiveOutput = createWriteStream(archivePath, { mode: 0o600 });
        archive.pipe(archiveOutput);
        gcodes.forEach((filePath) => {
          archive.file(filePath, { name: path.basename(filePath) });
        });
        await archive.finalize();
        await finished(archiveOutput);
        const cleaned = await sendAndReleaseWorkspace(res, archivePath, "result.zip", workdir);
        if (cleaned) workdir = undefined;
      }
    } finally {
      req.off("aborted", abortSlice);
      res.off("close", abortSlice);
      if (workdir) await cleanupSliceWorkspace(workdir);
    }
  },
);

export default router;
