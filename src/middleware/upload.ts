import multer from "multer";
import fs from "fs";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { AppError } from "./error";
import {
  MAX_BUNDLE_UPLOAD_BYTES,
  MAX_JSON_UPLOAD_BYTES,
  MAX_MODEL_UPLOAD_BYTES,
  MODEL_FIELD,
  formatUploadLimit,
} from "./upload-limits";

const storage = multer.memoryStorage();

/**
 * Storage that streams the model part to a temp file and keeps the small
 * JSON profile parts in memory.
 *
 * Stock `memoryStorage` buffers every part in full. That was tolerable under
 * a 100 MB cap; at 512 MB it means one slice can pin half a gigabyte of RSS
 * per concurrent request on exactly the hosts that don't have it spare (Pi,
 * NAS) — and `sliceModel` writes the model straight back out to its workdir
 * anyway, so the buffer only ever existed in order to be copied. Profiles
 * stay in memory: a few KB each, and every consumer wants them as Buffers.
 *
 * `_removeFile` carries more weight than it looks. multer invokes it for the
 * part that tripped `LIMIT_FILE_SIZE` as well as for parts already stored
 * (make-middleware pushes the aborting file onto `uploadedFiles` before
 * `removeUploadedFiles` runs), so a rejected oversize upload does not strand
 * its partial bytes in TMPDIR.
 */
const modelStorage: multer.StorageEngine = {
  _handleFile(_req, file, cb) {
    if (file.fieldname !== MODEL_FIELD) {
      // multer applies one `limits.fileSize` to every part of a request, so
      // without this the profile parts would inherit the model's ceiling and
      // a single mislabelled upload could buffer half a gigabyte of "JSON"
      // into the heap. Profiles get their own, much smaller bound.
      const chunks: Buffer[] = [];
      let total = 0;
      let rejected = false;
      file.stream.on("data", (chunk: Buffer) => {
        if (rejected) return;
        total += chunk.length;
        if (total > MAX_JSON_UPLOAD_BYTES) {
          rejected = true;
          cb(
            new AppError(
              413,
              `${file.fieldname} exceeds the ${formatUploadLimit(
                MAX_JSON_UPLOAD_BYTES
              )} profile upload limit.`
            )
          );
          return;
        }
        chunks.push(chunk);
      });
      file.stream.on("error", cb);
      file.stream.on("end", () => {
        if (rejected) return;
        const buffer = Buffer.concat(chunks);
        cb(null, { buffer, size: buffer.length });
      });
      return;
    }

    const tmpPath = path.join(os.tmpdir(), `upload-${randomUUID()}`);
    const out = fs.createWriteStream(tmpPath);

    // Both the source stream and the sink can fail, and an oversize upload
    // ends the source normally (busboy truncates at the limit and emits
    // `end`). Guard the callback so whichever fires first wins and the
    // others are no-ops.
    let settled = false;
    const finish = (
      err: Error | null,
      info?: Partial<Express.Multer.File>
    ): void => {
      if (settled) return;
      settled = true;
      cb(err, info);
    };

    out.on("error", finish);
    out.on("finish", () =>
      finish(null, { path: tmpPath, size: out.bytesWritten })
    );
    file.stream.on("error", (err: Error) => {
      // multer never learns about this file, so its own cleanup won't cover
      // it — drop the partial write here or it leaks into TMPDIR.
      out.destroy();
      void fsp.rm(tmpPath, { force: true }).finally(() => finish(err));
    });

    file.stream.pipe(out);
  },

  _removeFile(_req, file, cb) {
    if (!file.path) {
      cb(null);
      return;
    }
    fsp.rm(file.path, { force: true }).then(() => cb(null), cb);
  },
};

const allowedModelMimeTypes = [
  "model/stl",
  "application/step",
  "model/step",
  "model/3mf",
];
const allowedModelExts = [".stl", ".step", ".stp", ".3mf"];

export const uploadJson = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype !== "application/json" || ext !== ".json") {
      return cb(
        new AppError(400, "Invalid file type. Only JSON files are allowed.")
      );
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_JSON_UPLOAD_BYTES },
});

// BambuStudio's "Export Preset Bundle" emits files with a `.bbscfg`
// extension but standard zip content. Browsers/clients vary on the MIME
// type they send: zip-aware ones use application/zip, others fall through
// to application/octet-stream. The two real bundles we tested against were
// 38KB and 32KB, so the default cap has enormous headroom.
const allowedBundleMimeTypes = [
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
];
const allowedBundleExts = [".bbscfg", ".zip"];

export const uploadBundle = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (
      !allowedBundleMimeTypes.includes(file.mimetype) ||
      !allowedBundleExts.includes(ext)
    ) {
      return cb(
        new AppError(
          400,
          "Invalid file type. Only .bbscfg printer-preset-bundle archives are accepted."
        )
      );
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_BUNDLE_UPLOAD_BYTES },
});

export const uploadModel = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (
      !allowedModelMimeTypes.includes(file.mimetype) ||
      !allowedModelExts.includes(ext)
    ) {
      return cb(
        new AppError(
          400,
          "Invalid file type. Only STL, STEP, and 3MF files are allowed."
        )
      );
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_MODEL_UPLOAD_BYTES },
});

export const uploadFullPrint = multer({
  storage: modelStorage,
  fileFilter: (req, file, cb) => {
    const profileFields = [
      "printerProfile",
      "presetProfile",
      "filamentProfile",
    ];

    const ext = path.extname(file.originalname).toLowerCase();

    if (file.fieldname === MODEL_FIELD) {
      if (
        !allowedModelMimeTypes.includes(file.mimetype) ||
        !allowedModelExts.includes(ext)
      ) {
        return cb(
          new AppError(
            400,
            "Invalid file type. Only STL, STEP, and 3MF files are allowed."
          )
        );
      }

      return cb(null, true);
    }

    if (profileFields.includes(file.fieldname)) {
      if (file.mimetype !== "application/json" || ext !== ".json") {
        return cb(
          new AppError(
            400,
            `Invalid file type for ${file.fieldname}. Only JSON files are allowed.`
          )
        );
      }

      return cb(null, true);
    }

    return cb(new AppError(400, "Unexpected file field received."));
  },
  limits: { fileSize: MAX_MODEL_UPLOAD_BYTES },
});
