import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import { AppError } from "../../src/middleware/error";
import { configureApp } from "../../src/index";
import { sliceModel } from "../../src/routes/slicing/slicing.service";
import {
  cleanupSliceWorkspace,
  resetSliceTempStateForTests,
  sliceTempStatus,
} from "../../src/routes/slicing/temp-workspaces";

let testRoot: string;
let fakeSlicer: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pfm-slice-lifecycle-"));
  fakeSlicer = path.join(testRoot, "fake-slicer.sh");
  await fs.writeFile(
    fakeSlicer,
    `#!/bin/sh
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outputdir" ]; then output="$2"; shift 2; continue; fi
  shift
done
job="$TMPDIR/bamboo_model/day/internal-job"
mkdir -p "$job/Metadata" "$job/Auxiliaries" "$job/3D/Objects"
printf '1\\n' > "$job/lock.txt"
printf 'temporary config\\n' > "$job/_temp_1.config"
case "\${FAKE_SLICER_MODE:-success}" in
  fail) exit 42 ;;
  stall) trap 'exit 143' TERM INT; while :; do sleep 1; done ;;
esac
printf '; total estimated time: 1m 2s\\n; total filament length [mm] : 12.3\\n; total filament weight [g] : 0.04\\n' > "$output/plate_1.gcode"
`,
    { mode: 0o700 },
  );
  process.env.ORCASLICER_PATH = fakeSlicer;
  process.env.SLICER_TEMP_ROOT = testRoot;
  process.env.SLICER_MIN_TEMP_FREE_MB = "1";
  process.env.SLICER_TEMP_SPACE_FACTOR = "1";
  delete process.env.FAKE_SLICER_MODE;
  resetSliceTempStateForTests();
});

afterEach(async () => {
  resetSliceTempStateForTests();
  delete process.env.ORCASLICER_PATH;
  delete process.env.SLICER_TEMP_ROOT;
  delete process.env.SLICER_MIN_TEMP_FREE_MB;
  delete process.env.SLICER_TEMP_SPACE_FACTOR;
  delete process.env.FAKE_SLICER_MODE;
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe("slice lifecycle cleanup", () => {
  it("contains CLI temp state in the job and preserves output until the caller cleans up", async () => {
    const result = await sliceModel(Buffer.from("solid cube\nendsolid cube\n"), "cube.stl", {});
    const privateTree = path.join(result.workdir, "runtime", "bamboo_model", "day", "internal-job");

    expect((await fs.stat(path.join(result.workdir, "runtime"))).mode & 0o777).toBe(0o700);

    expect(await fs.readFile(path.join(privateTree, "lock.txt"), "utf-8")).toBe("1\n");
    expect(await fs.readFile(path.join(privateTree, "_temp_1.config"), "utf-8")).toContain("temporary");
    expect(await fs.readFile(result.gcodes[0], "utf-8")).toContain("total estimated time");
    expect((await sliceTempStatus()).active_slice_workspaces).toBe(1);

    expect(await cleanupSliceWorkspace(result.workdir)).toBe(true);
    await expect(fs.stat(result.workdir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await sliceTempStatus()).temp_bytes_used).toBe(0);
  });

  it("sends the completed output before route cleanup removes the entire workspace", async () => {
    const response = await supertest(configureApp())
      .post("/slice")
      .attach("file", Buffer.from("solid cube\nendsolid cube\n"), {
        filename: "cube.stl",
        contentType: "model/stl",
      })
      .expect(200);

    expect(Buffer.from(response.body).toString("utf-8")).toContain("total estimated time");
    const status = await sliceTempStatus();
    expect(status.active_slice_workspaces).toBe(0);
    expect(status.stale_slice_workspaces).toBe(0);
    expect(status.temp_bytes_used).toBe(0);
  });

  it("cleans the complete workspace after a slicer subprocess failure", async () => {
    process.env.FAKE_SLICER_MODE = "fail";
    await expect(sliceModel(Buffer.from("bad"), "bad.stl", {})).rejects.toBeInstanceOf(AppError);
    const status = await sliceTempStatus();
    expect(status.active_slice_workspaces).toBe(0);
    expect(status.stale_slice_workspaces).toBe(0);
    expect(status.temp_bytes_used).toBe(0);
  });

  it("cleans after profile-resolution exceptions", async () => {
    await expect(
      sliceModel(Buffer.from("model"), "model.stl", {}, { printer: Buffer.from("not-json") }),
    ).rejects.toBeInstanceOf(AppError);
    expect((await sliceTempStatus()).temp_bytes_used).toBe(0);
  });

  it("terminates a stalled subprocess and cleans after watchdog cancellation", async () => {
    process.env.FAKE_SLICER_MODE = "stall";
    const controller = new AbortController();
    const pending = sliceModel(Buffer.from("model"), "model.stl", {}, undefined, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(pending).rejects.toMatchObject({ status: 499, message: "Slicing cancelled" });
    const status = await sliceTempStatus();
    expect(status.active_slice_workspaces).toBe(0);
    expect(status.stale_slice_workspaces).toBe(0);
    expect(status.temp_bytes_used).toBe(0);
  });

  it("does not launch and leaves no workspace when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      sliceModel(Buffer.from("model"), "model.stl", {}, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ status: 499, message: "Slicing cancelled" });

    const status = await sliceTempStatus();
    expect(status.active_slice_workspaces).toBe(0);
    expect(status.stale_slice_workspaces).toBe(0);
    expect(status.temp_bytes_used).toBe(0);
  });
});
