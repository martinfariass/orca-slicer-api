import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { AppError } from "../../middleware/error";

const WORKSPACE_PREFIX = "slice-";
const WORKSPACE_MARKER = ".pfm-slice-workspace.json";
const LEGACY_BAMBU_ROOT = "bamboo_model";
const DEFAULT_MIN_FREE_MIB = 128;
const DEFAULT_SPACE_FACTOR = 3;

const activeWorkspaces = new Set<string>();
let lastCleanupFailure: string | null = null;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function slicerTempRoot(): string {
  return path.resolve(process.env.SLICER_TEMP_ROOT || os.tmpdir());
}

function assertStrictChild(root: string, candidate: string): string {
  if (!candidate || candidate.includes("\0")) {
    throw new Error("Refusing an empty or malformed slicer workspace path");
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a path outside the slicer temp root: ${candidate}`);
  }
  return resolvedTarget;
}

async function assertSafeDirectory(root: string, candidate: string): Promise<string | null> {
  const target = assertStrictChild(root, candidate);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to recursively remove a non-directory slicer workspace: ${target}`);
  }
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  assertStrictChild(realRoot, realTarget);
  return target;
}

function recordCleanupFailure(operation: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  lastCleanupFailure = `${new Date().toISOString()} ${operation}: ${detail}`;
  console.warn(`Slicer temporary-workspace cleanup warning (${operation}): ${detail}`);
}

export async function assertTempCapacity(modelBytes: number): Promise<void> {
  const root = slicerTempRoot();
  await fs.mkdir(root, { recursive: true });
  const stats = await fs.statfs(root);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const minimumBytes = positiveNumber(process.env.SLICER_MIN_TEMP_FREE_MB, DEFAULT_MIN_FREE_MIB) * 1024 * 1024;
  const factorBytes = Math.max(0, modelBytes) * positiveNumber(
    process.env.SLICER_TEMP_SPACE_FACTOR,
    DEFAULT_SPACE_FACTOR,
  );
  const requiredBytes = Math.max(minimumBytes, factorBytes);
  if (freeBytes < requiredBytes) {
    throw new AppError(
      507,
      "Insufficient temporary storage for slicing",
      `Slicer temp has ${Math.floor(freeBytes / 1048576)} MiB free; this job requires at least ${Math.ceil(requiredBytes / 1048576)} MiB.`,
    );
  }
}

export async function createSliceWorkspace(jobId?: string): Promise<string> {
  const root = slicerTempRoot();
  await fs.mkdir(root, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(root, WORKSPACE_PREFIX));
  activeWorkspaces.add(workspace);
  try {
    await fs.writeFile(
      path.join(workspace, WORKSPACE_MARKER),
      `${JSON.stringify({ job_id: jobId || null, created_at: new Date().toISOString() })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (error) {
    activeWorkspaces.delete(workspace);
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  }
  return workspace;
}

export async function cleanupSliceWorkspace(candidate: string): Promise<boolean> {
  const root = slicerTempRoot();
  const resolved = path.resolve(candidate);
  try {
    const target = await assertSafeDirectory(root, candidate);
    if (target === null) {
      activeWorkspaces.delete(resolved);
      return true;
    }
    if (!path.basename(target).startsWith(WORKSPACE_PREFIX)) {
      throw new Error(`Refusing to remove an unrecognized slicer workspace: ${target}`);
    }
    let marker;
    try {
      marker = await fs.lstat(path.join(target, WORKSPACE_MARKER));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Refusing to remove an unowned slicer workspace: ${target}`);
      }
      throw error;
    }
    if (marker.isSymbolicLink() || !marker.isFile()) {
      throw new Error(`Refusing to remove an unowned slicer workspace: ${target}`);
    }
    await fs.rm(target, { recursive: true, force: true });
    activeWorkspaces.delete(resolved);
    return true;
  } catch (error) {
    activeWorkspaces.delete(resolved);
    recordCleanupFailure(`workspace ${candidate}`, error);
    return false;
  }
}

async function cleanupLegacyBambuRoot(root: string): Promise<void> {
  const legacy = path.join(root, LEGACY_BAMBU_ROOT);
  try {
    const target = await assertSafeDirectory(root, legacy);
    if (target !== null) await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    recordCleanupFailure(`legacy workspace ${legacy}`, error);
  }
}

export async function recoverStaleSliceWorkspaces(): Promise<void> {
  const root = slicerTempRoot();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(WORKSPACE_PREFIX)) continue;
    const candidate = path.join(root, entry.name);
    if (activeWorkspaces.has(candidate)) continue;
    await cleanupSliceWorkspace(candidate);
  }
  // Images before the PFM cleanup patch wrote Bambu Studio's private tree as
  // a sibling of slice-* workspaces. Startup runs before the HTTP listener,
  // so no CLI can be active while this exact legacy path is removed.
  await cleanupLegacyBambuRoot(root);
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += await directoryBytes(candidate);
    else total += stat.size;
  }
  return total;
}

export async function sliceTempStatus(): Promise<Record<string, unknown>> {
  const root = slicerTempRoot();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const stale = entries.filter((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKSPACE_PREFIX)) return false;
    return !activeWorkspaces.has(path.join(root, entry.name));
  });
  const legacyExists = entries.some((entry) => entry.isDirectory() && entry.name === LEGACY_BAMBU_ROOT);
  const stats = await fs.statfs(root);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  let jobBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(WORKSPACE_PREFIX) && entry.name !== LEGACY_BAMBU_ROOT) continue;
    jobBytes += await directoryBytes(path.join(root, entry.name));
  }
  return {
    active_slice_workspaces: activeWorkspaces.size,
    active_workspace_ids: Array.from(activeWorkspaces, (workspace) => path.basename(workspace)).sort(),
    stale_slice_workspaces: stale.length + (legacyExists ? 1 : 0),
    temp_bytes_used: jobBytes,
    temp_filesystem_bytes_total: totalBytes,
    temp_filesystem_bytes_free: freeBytes,
    last_cleanup_failure: lastCleanupFailure,
  };
}

export function resetSliceTempStateForTests(): void {
  activeWorkspaces.clear();
  lastCleanupFailure = null;
}
