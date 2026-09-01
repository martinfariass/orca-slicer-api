import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertTempCapacity,
  cleanupSliceWorkspace,
  createSliceWorkspace,
  recoverStaleSliceWorkspaces,
  resetSliceTempStateForTests,
  sliceTempStatus,
} from "../../src/routes/slicing/temp-workspaces";

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pfm-temp-workspaces-"));
  process.env.SLICER_TEMP_ROOT = testRoot;
  process.env.SLICER_MIN_TEMP_FREE_MB = "1";
  process.env.SLICER_TEMP_SPACE_FACTOR = "3";
  resetSliceTempStateForTests();
});

afterEach(async () => {
  resetSliceTempStateForTests();
  delete process.env.SLICER_TEMP_ROOT;
  delete process.env.SLICER_MIN_TEMP_FREE_MB;
  delete process.env.SLICER_TEMP_SPACE_FACTOR;
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe("slicer temporary workspaces", () => {
  it("removes lock, config, nested files, and the empty workspace idempotently", async () => {
    const workspace = await createSliceWorkspace("job-1");
    const bambuTree = path.join(workspace, "bamboo_model", "day", "job", "Metadata");
    await fs.mkdir(bambuTree, { recursive: true });
    await fs.writeFile(path.join(workspace, "bamboo_model", "day", "job", "lock.txt"), "1\n");
    await fs.writeFile(path.join(workspace, "bamboo_model", "day", "job", "_temp_1.config"), "config");

    expect(await cleanupSliceWorkspace(workspace)).toBe(true);
    await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cleanupSliceWorkspace(workspace)).toBe(true);

    const status = await sliceTempStatus();
    expect(status.active_slice_workspaces).toBe(0);
    expect(status.stale_slice_workspaces).toBe(0);
    expect(status.temp_bytes_used).toBe(0);
  });

  it("removes only the requested job and protects another active workspace", async () => {
    const first = await createSliceWorkspace("first");
    const second = await createSliceWorkspace("second");
    await fs.writeFile(path.join(second, "still-active"), "keep");

    expect(await cleanupSliceWorkspace(first)).toBe(true);
    expect(await fs.readFile(path.join(second, "still-active"), "utf-8")).toBe("keep");
    const status = await sliceTempStatus();
    expect(status.active_slice_workspaces).toBe(1);

    expect(await cleanupSliceWorkspace(second)).toBe(true);
  });

  it("refuses root, traversal, outside, symlink, and unrecognized deletion targets", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pfm-outside-"));
    const symlink = path.join(testRoot, "slice-link");
    await fs.symlink(outside, symlink);
    const unrecognized = path.join(testRoot, "not-a-slice");
    await fs.mkdir(unrecognized);

    expect(await cleanupSliceWorkspace(testRoot)).toBe(false);
    expect(await cleanupSliceWorkspace(path.join(testRoot, "..", path.basename(outside)))).toBe(false);
    expect(await cleanupSliceWorkspace(outside)).toBe(false);
    expect(await cleanupSliceWorkspace(symlink)).toBe(false);
    expect(await cleanupSliceWorkspace(unrecognized)).toBe(false);
    expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true);
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
    expect((await sliceTempStatus()).last_cleanup_failure).toContain("Refusing");

    await fs.rm(outside, { recursive: true, force: true });
  });

  it("cleans stale and legacy trees on startup but preserves active work", async () => {
    const active = await createSliceWorkspace("active");
    const stale = path.join(testRoot, "slice-stale");
    await fs.mkdir(stale);
    await fs.writeFile(
      path.join(stale, ".pfm-slice-workspace.json"),
      '{"job_id":"stale"}\n',
    );
    const legacy = path.join(testRoot, "bamboo_model", "day", "old-job");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "lock.txt"), "1\n");

    await recoverStaleSliceWorkspaces();

    expect((await fs.stat(active)).isDirectory()).toBe(true);
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(testRoot, "bamboo_model"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cleanupSliceWorkspace(active)).toBe(true);
  });

  it("preserves an unmarked slice-like directory during startup recovery", async () => {
    const unowned = path.join(testRoot, "slice-unowned");
    await fs.mkdir(unowned);
    await fs.writeFile(path.join(unowned, "do-not-delete"), "unowned");

    await recoverStaleSliceWorkspaces();

    expect(await fs.readFile(path.join(unowned, "do-not-delete"), "utf-8")).toBe("unowned");
    expect((await sliceTempStatus()).last_cleanup_failure).toContain("unowned");
  });

  it("rejects a slice when the configured capacity requirement exceeds free temp space", async () => {
    process.env.SLICER_TEMP_SPACE_FACTOR = "1000000000000";
    await expect(assertTempCapacity(1024 * 1024)).rejects.toMatchObject({
      status: 507,
      message: "Insufficient temporary storage for slicing",
    });
  });
});
