import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { AppError } from "../../middleware/error";
import type {
  SlicingSettings,
  SliceResult,
  SliceMetaData,
  UploadedProfiles,
} from "./models";
import { Open } from "unzipper";
import {
  getDefaultBundledProfilesPath,
  resolveProfile,
  type ProfileCategory,
  type ProfileJson,
} from "./profile-resolver";

export async function sliceModel(
  file: Buffer,
  filename: string,
  settings: SlicingSettings,
  tempProfiles?: UploadedProfiles,
): Promise<SliceResult> {
  let workdir: string;
  let inPath: string;
  let inputDir: string;
  let outputDir: string;
  try {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "slice-"));
    inputDir = path.join(workdir, "input");
    outputDir = path.join(workdir, "output");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    inPath = path.join(inputDir, filename);
    await fs.writeFile(inPath, file);
  } catch (error) {
    throw new AppError(
      500,
      "Failed to prepare slicing",
      error instanceof Error ? error.message : String(error),
    );
  }

  const basePath = process.env.DATA_PATH || path.join(process.cwd(), "data");
  const bundledProfilesPath = getDefaultBundledProfilesPath();

  let printerPath: string | undefined;
  let presetPath: string | undefined;
  let filamentPath: string | undefined;

  try {
    printerPath = await materializeProfile({
      inputDir,
      filename: "printer.json",
      category: "machine",
      uploaded: tempProfiles?.printer,
      diskName: settings.printer,
      diskBase: basePath,
      diskCategoryDir: "printers",
      bundledProfilesPath,
    });
    presetPath = await materializeProfile({
      inputDir,
      filename: "preset.json",
      category: "process",
      uploaded: tempProfiles?.preset,
      diskName: settings.preset,
      diskBase: basePath,
      diskCategoryDir: "presets",
      bundledProfilesPath,
    });
    filamentPath = await materializeProfile({
      inputDir,
      filename: "filament.json",
      category: "filament",
      uploaded: tempProfiles?.filament,
      diskName: settings.filament,
      diskBase: basePath,
      diskCategoryDir: "filaments",
      bundledProfilesPath,
    });
  } catch (error) {
    await fs.rm(workdir, { recursive: true, force: true });
    throw error;
  }

  const args: string[] = [];

  if (settings.exportType === "3mf") {
    args.push("--export-3mf", "result.3mf");
  }

  const sliceArg = settings.plate === undefined ? "1" : settings.plate;
  args.push("--slice", sliceArg);

  if (settings.arrange !== undefined) {
    args.push("--arrange", settings.arrange ? "1" : "0");
  }

  if (settings.orient !== undefined) {
    args.push("--orient", settings.orient ? "1" : "0");
  }

  if (printerPath && presetPath) {
    args.push("--load-settings", `${printerPath};${presetPath}`);
  }

  if (filamentPath) {
    args.push("--load-filaments", filamentPath);
  }

  if (settings.bedType) {
    args.push("--curr-bed-type", settings.bedType);
  }

  if (settings.multicolorOnePlate) {
    args.push("--allow-multicolor-oneplate");
  }

  args.push("--allow-newer-file");
  args.push("--outputdir", outputDir);

  args.push(inPath);

  if (!process.env.ORCASLICER_PATH) {
    throw new AppError(
      500,
      "Slicing is not configured properly on the server",
      "ORCASLICER_PATH environment variable is not defined",
    );
  }

  // Capture stdout + stderr so failure diagnostics survive the spawn-error
  // wrapper. `execFile`'s default `(error) => ...` callback only carries the
  // spawn-error message ("Command failed: <cmd>"), which is useless when the
  // slicer rejected the input — the *reason* is in stderr (range checks,
  // missing fields, profile compat failures all print there). The wider
  // signature `(error, stdout, stderr)` keeps both around so we can include
  // them in the AppError that propagates to Bambuddy.
  let cliStdout = "";
  let cliStderr = "";
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.env.ORCASLICER_PATH as string,
        args,
        {
          encoding: "utf-8",
          // Default 1MB is plenty for slicer error output but tiny if the
          // slicer happens to dump a lot on success — bump to 16MB.
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          cliStdout = stdout ?? "";
          cliStderr = stderr ?? "";
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  } catch (err) {
    const resultJsonPath = path.join(outputDir, "result.json");
    let json;
    try {
      const content = await fs.readFile(resultJsonPath, "utf-8");
      json = JSON.parse(content);
    } catch {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new AppError(
        500,
        "Failed to slice the model",
        formatCliFailure(err, cliStdout, cliStderr),
      );
    }

    if (json?.error_string) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new AppError(
        500,
        `Slicing failed with error from slicer: ${json.error_string}`,
        formatCliFailure(err, cliStdout, cliStderr),
      );
    }

    await fs.rm(workdir, { recursive: true, force: true });
    throw new AppError(
      500,
      "Failed to slice the model",
      formatCliFailure(err, cliStdout, cliStderr),
    );
  }

  const files = await fs.readdir(outputDir);
  let resultFiles: string[];

  if (settings.exportType === "3mf") {
    resultFiles = files
      .filter((f) => f.toLowerCase().endsWith(".3mf"))
      .map((f) => path.join(outputDir, f));
  } else {
    resultFiles = files
      .filter((f) => f.toLowerCase().endsWith(".gcode"))
      .map((f) => path.join(outputDir, f));
  }

  return { gcodes: resultFiles, workdir };
}

/**
 * Extract metadata (print time, filament used) from a G-code or 3MF file.
 * @param filePath The path to the file.
 * @returns The extracted metadata.
 */
export async function getMetaDataFromFile(
  filePath: string,
): Promise<SliceMetaData> {
  let data = {
    printTime: 0,
    filamentUsedG: 0,
    filamentUsedMm: 0,
  };

  if (filePath.endsWith(".gcode")) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      data = parseMetaDataFromString(content);
    } catch (error) {
      console.error(
        "Failed to read G-code file for metadata extraction:",
        error,
      );
    }
  } else if (filePath.endsWith(".3mf")) {
    try {
      const dir = await Open.file(filePath);
      for (const file of dir.files.filter((f) => f.path.endsWith(".gcode"))) {
        const content = (await file.buffer()).toString("utf-8");
        const metaData = parseMetaDataFromString(content);
        data.printTime += metaData.printTime;
        data.filamentUsedG += metaData.filamentUsedG;
        data.filamentUsedMm += metaData.filamentUsedMm;
      }
    } catch (error) {
      console.error("Failed to read 3MF file for metadata extraction:", error);
    }
  }

  return data;
}

/**
 * Build a useful `causeMessage` for an AppError when the slicer CLI exited
 * non-zero. The default `execFile` error message is just
 * `Command failed: <full cmdline>` — useless for diagnosing why the slicer
 * rejected the input. Slicer CLIs print actual reasons (range checks,
 * profile compat failures, missing keys) to **stderr**, occasionally with
 * additional context on stdout. Combine them, prefer stderr (where the
 * meaningful diagnostic lives), and trim aggressively so massive G-code
 * dumps from successful-but-late failures don't blow out the response.
 */
function formatCliFailure(
  err: unknown,
  stdout: string,
  stderr: string,
): string {
  const head = err instanceof Error ? err.message : String(err);
  const stderrTrim = stderr.trim();
  const stdoutTrim = stdout.trim();
  const parts: string[] = [head];
  if (stderrTrim) parts.push(`stderr: ${truncate(stderrTrim, 4096)}`);
  if (stdoutTrim) parts.push(`stdout: ${truncate(stdoutTrim, 4096)}`);
  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

function parseMetaDataFromString(content: string): SliceMetaData {
  const data: SliceMetaData = {
    printTime: 0,
    filamentUsedG: 0,
    filamentUsedMm: 0,
  };

  try {
    // Extract print time
    const timeIndex = content.indexOf("total estimated time");
    if (timeIndex !== -1) {
      const timeSlice = content.slice(timeIndex, timeIndex + 80);
      const timeMatch = timeSlice.match(
        /total estimated time:\s*((?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?)/i,
      );
      if (timeMatch) {
        const days = parseInt(timeMatch[2] || "0");
        const hours = parseInt(timeMatch[3] || "0");
        const minutes = parseInt(timeMatch[4] || "0");
        const seconds = parseInt(timeMatch[5] || "0");
        data.printTime = days * 86400 + hours * 3600 + minutes * 60 + seconds;
      }
    }

    if (timeIndex === -1) {
      const altTimeIndex = content.indexOf(
        "; estimated printing time (normal mode)",
      );
      if (altTimeIndex !== -1) {
        const timeSlice = content.slice(altTimeIndex, altTimeIndex + 100);
        const timeMatch = timeSlice.match(
          /; estimated printing time \(normal mode\) = \s*((?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?)/i,
        );
        if (timeMatch) {
          const days = parseInt(timeMatch[2] || "0");
          const hours = parseInt(timeMatch[3] || "0");
          const minutes = parseInt(timeMatch[4] || "0");
          const seconds = parseInt(timeMatch[5] || "0");
          data.printTime = days * 86400 + hours * 3600 + minutes * 60 + seconds;
        }
      }
    }

    // Extract filament used [mm]
    const filamentMmIndex = content.indexOf("; filament used [mm]");
    if (filamentMmIndex !== -1) {
      const filamentMmSlice = content.slice(
        filamentMmIndex,
        filamentMmIndex + 50,
      );
      const mmMatch = filamentMmSlice.match(
        /; filament used \[mm\] = \s*(\d+(\.\d+)?)/,
      );
      if (mmMatch) {
        data.filamentUsedMm = parseFloat(mmMatch[1]);
      }
    }

    // Extract filament used [g]
    const filamentGIndex = content.indexOf("; filament used [g]");
    if (filamentGIndex !== -1) {
      const filamentGSlice = content.slice(filamentGIndex, filamentGIndex + 50);
      const gMatch = filamentGSlice.match(
        /; filament used \[g\] = \s*(\d+(\.\d+)?)/,
      );
      if (gMatch) {
        data.filamentUsedG = parseFloat(gMatch[1]);
      }
    }
  } catch (err) {
    console.error("Failed to parse metadata from string:", err);
  }

  return data;
}

interface MaterializeProfileArgs {
  inputDir: string;
  filename: string;
  category: ProfileCategory;
  uploaded: Buffer | undefined;
  diskName: string | undefined;
  diskBase: string;
  diskCategoryDir: string;
  bundledProfilesPath: string | undefined;
}

async function materializeProfile(
  args: MaterializeProfileArgs,
): Promise<string | undefined> {
  let raw: string;
  let isUserUpload: boolean;

  if (args.uploaded && args.uploaded.length > 0) {
    raw = args.uploaded.toString("utf-8");
    isUserUpload = true;
  } else if (args.diskName) {
    const diskPath = path.join(
      args.diskBase,
      args.diskCategoryDir,
      `${args.diskName}.json`,
    );
    try {
      raw = await fs.readFile(diskPath, "utf-8");
    } catch (err) {
      throw new AppError(
        500,
        `Failed to read stored ${args.category} profile "${args.diskName}"`,
        err instanceof Error ? err.message : String(err),
      );
    }
    isUserUpload = false;
  } else {
    return undefined;
  }

  let profile: ProfileJson;
  try {
    profile = JSON.parse(raw) as ProfileJson;
  } catch (err) {
    const status = isUserUpload ? 400 : 500;
    const sourceLabel = isUserUpload ? "uploaded" : "stored";
    throw new AppError(
      status,
      `Invalid JSON in ${sourceLabel} ${args.category} profile`,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (typeof profile.inherits === "string" && profile.inherits.length > 0) {
    if (!args.bundledProfilesPath) {
      throw new AppError(
        500,
        `Profile resolution required but bundled profiles path is not configured (category=${args.category} inherits="${profile.inherits}")`,
        "Set BUNDLED_PROFILES_PATH or ORCASLICER_PATH so the resolver can locate resources/profiles/BBL.",
      );
    }
    profile = await resolveProfile(profile, args.category, {
      bundledProfilesPath: args.bundledProfilesPath,
    });
  }

  const outPath = path.join(args.inputDir, args.filename);
  try {
    await fs.writeFile(outPath, JSON.stringify(profile));
  } catch (err) {
    throw new AppError(
      500,
      `Failed to write resolved ${args.category} profile`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return outPath;
}
