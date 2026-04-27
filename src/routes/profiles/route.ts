import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { uploadJson } from "../../middleware/upload";
import type { Category } from "../slicing/models";
import {
  saveSetting,
  listSettings,
  getSetting,
  deleteSetting,
} from "./settings.service";
import { AppError } from "../../middleware/error";
import { getDefaultBundledProfilesPath } from "../slicing/profile-resolver";

const router = Router();

// In-process cache for the bundled-profiles index. The bundle is read from the
// slicer's read-only `resources/profiles/BBL/` tree, which only changes when
// the container image is rebuilt — a long TTL is safe and avoids re-reading
// hundreds of JSON files on every Slice modal open. `null` = "not yet built".
type BundledIndex = {
  printer: { name: string; base_id: string | null }[];
  process: { name: string; base_id: string | null }[];
  filament: { name: string; base_id: string | null }[];
};
let bundledIndexCache: BundledIndex | null = null;
let bundledIndexCachedAt = 0;
const BUNDLED_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

router.get("/bundled", async (_req, res) => {
  // Bambuddy SliceModal calls this to populate the "Standard" tier of profile
  // dropdowns. Empty arrays are returned (200, not 503) when the bundled tree
  // can't be located — callers degrade to "no standard tier" without surfacing
  // a confusing error.
  const bundledPath = getDefaultBundledProfilesPath();
  if (!bundledPath) {
    res.status(200).json({ printer: [], process: [], filament: [] });
    return;
  }

  const now = Date.now();
  if (bundledIndexCache && now - bundledIndexCachedAt < BUNDLED_CACHE_TTL_MS) {
    res.status(200).json(bundledIndexCache);
    return;
  }

  const result: BundledIndex = {
    printer: await readBundledDir(path.join(bundledPath, "machine")),
    process: await readBundledDir(path.join(bundledPath, "process")),
    filament: await readBundledDir(path.join(bundledPath, "filament")),
  };
  bundledIndexCache = result;
  bundledIndexCachedAt = now;
  res.status(200).json(result);
});

async function readBundledDir(
  dir: string,
): Promise<{ name: string; base_id: string | null }[]> {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: { name: string; base_id: string | null }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const json = JSON.parse(raw) as {
        name?: string;
        inherits?: string;
        instantiation?: string;
      };
      // Bundled profiles ship a mix of concrete presets and abstract bases
      // (e.g. `fdm_filament_pla`). Skip the latter so the slicer modal only
      // offers things a user can actually pick. `instantiation:"true"` is the
      // BBL convention for "this is a leaf preset".
      if (json.instantiation && json.instantiation !== "true") continue;
      if (!json.name) continue;
      out.push({ name: json.name, base_id: json.inherits ?? null });
    } catch {
      // Corrupted / unreadable individual file — skip without breaking the
      // rest of the listing.
      continue;
    }
  }
  // Stable alphabetical order by name so the dropdown is predictable.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

router.post("/:category", uploadJson.single("file"), async (req, res) => {
  const name = req.body.name;

  validateName(name);

  if (!req.file) {
    throw new AppError(400, "File is required");
  }

  validateCategory(req.params.category as string);

  const content = JSON.parse(req.file.buffer.toString("utf8"));
  await saveSetting(req.params.category as Category, name, content);
  res.status(201).json({ name });
});

router.get("/:category", async (req, res) => {
  validateCategory(req.params.category);

  const settings = await listSettings(req.params.category as Category);
  res.status(200).json(settings);
});

router.get("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  const setting = await getSetting(
    req.params.category as Category,
    req.params.name,
  );
  res.status(200).json(setting);
});

router.delete("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  await deleteSetting(req.params.category as Category, req.params.name);
  res.status(204).send();
});

function validateCategory(category: string) {
  if (!category || !["printers", "presets", "filaments"].includes(category)) {
    throw new AppError(400, "Invalid or missing category");
  }
}

function validateName(name: string) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new AppError(400, "Name cannot be empty");
  }
  if (!/^[a-zA-Z0-9]+$/.test(name)) {
    throw new AppError(400, "Name must only contain letters and numbers");
  }
}

export default router;
