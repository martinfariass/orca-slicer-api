import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { uploadJson, uploadBundle } from "../../middleware/upload";
import type { Category } from "../slicing/models";
import {
  saveSetting,
  listSettings,
  getSetting,
  deleteSetting,
} from "./settings.service";
import {
  importBundle,
  listBundles,
  readBundleSummary,
  deleteBundle,
} from "./bundle.service";
import { AppError } from "../../middleware/error";
import {
  getDefaultBundledProfilesPath,
  resolveProfile,
  type ProfileCategory,
  type ProfileJson,
} from "../slicing/profile-resolver";

const router = Router();

// In-process cache for the bundled-profiles index. The bundle is read from the
// slicer's read-only `resources/profiles/BBL/` tree, which only changes when
// the container image is rebuilt — a long TTL is safe and avoids re-reading
// hundreds of JSON files on every Slice modal open. `null` = "not yet built".
export type BundledEntry = {
  name: string;
  base_id: string | null;
};
export type BundledCompatEntry = BundledEntry & {
  // Printer-preset names this profile declares itself usable on. Bambuddy
  // filters its process / filament dropdowns by the selected printer, and
  // this list is the only truthful source for that: several Bambu printers
  // ship NO profiles under their own name and rely entirely on being named
  // here by another model's profile. The P1S is the clearest case -- all ten
  // of its process presets are named `@BBL X1C` and list
  // "Bambu Lab P1S 0.4 nozzle" in `compatible_printers`. A consumer left to
  // infer the printer from the profile NAME reads every one of them as
  // belonging to an X1 Carbon, which is how a P1S ended up being offered an
  // A1 process (Bambuddy #2982). Same for the X1, the X1E and the H2D Pro.
  compatible_printers: string[] | null;
};
export type BundledFilament = BundledCompatEntry & {
  // Filament-only metadata, used by Bambuddy to pre-pick a profile per plate
  // slot in the SliceModal multi-color flow.
  //
  // `filament_type` is resolved through the `inherits` chain, NOT read off
  // the leaf: in the shipped BBL bundle it sits one to four hops up
  // (`Bambu ABS @BBL A1` -> `Bambu ABS @base` -> `fdm_filament_abs`) and
  // exactly zero of the 1156 instantiable leaves carry it themselves. Reading
  // only the leaf returned null for every profile, which cost the consumer
  // its entire material-matching signal and let a PETG preset be auto-picked
  // for a PLA plate (#2982).
  //
  // `filament_colour` is resolved the same way but is genuinely absent from
  // the whole bundle -- no BBL filament profile carries a colour at any depth,
  // because colour is a runtime spool attribute rather than a profile one. It
  // stays in the response for third-party bundles that do set it.
  filament_type: string | null;
  filament_colour: string | null;
};
type BundledIndex = {
  printer: BundledEntry[];
  process: BundledCompatEntry[];
  filament: BundledFilament[];
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
    printer: await readBundledDir(path.join(bundledPath, "machine"), "printer"),
    process: (await readBundledDir(
      path.join(bundledPath, "process"),
      "process",
    )) as BundledCompatEntry[],
    filament: (await readBundledDir(
      path.join(bundledPath, "filament"),
      "filament",
    )) as BundledFilament[],
  };
  bundledIndexCache = result;
  bundledIndexCachedAt = now;
  res.status(200).json(result);
});

/**
 * Index one category directory of a bundled-profile tree.
 *
 * Exported for unit tests: the inherited-field resolution below is the only
 * reason a P1S sees any process preset at all, and it is worth pinning against
 * a fixture tree rather than only against whichever slicer build the image
 * happens to carry.
 */
export async function readBundledDir(
  dir: string,
  kind: "printer" | "process" | "filament",
): Promise<BundledEntry[]> {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }

  // Read the whole directory up front, abstract bases included. The bases are
  // never offered to the user, but they are where the inherited fields
  // actually live, so the walk below needs them in hand.
  const byName = new Map<string, BundledProfile>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.promises.readFile(path.join(dir, entry), "utf8");
      const json = JSON.parse(raw) as BundledProfile;
      if (typeof json.name === "string" && json.name.length > 0) {
        byName.set(json.name, json);
      }
    } catch {
      // Corrupted / unreadable individual file — skip without breaking the
      // rest of the listing.
      continue;
    }
  }

  const out: BundledEntry[] = [];
  for (const json of byName.values()) {
    // Bundled profiles ship a mix of concrete presets and abstract bases
    // (e.g. `fdm_filament_pla`). Skip the latter so the slicer modal only
    // offers things a user can actually pick. `instantiation:"true"` is the
    // BBL convention for "this is a leaf preset".
    if (json.instantiation && json.instantiation !== "true") continue;
    if (!json.name) continue;
    const base: BundledEntry = { name: json.name, base_id: json.inherits ?? null };
    if (kind === "printer") {
      out.push(base);
      continue;
    }
    const compat: BundledCompatEntry = {
      ...base,
      compatible_printers: stringList(
        inheritedField(byName, json, "compatible_printers"),
      ),
    };
    if (kind === "process") {
      out.push(compat);
      continue;
    }
    const filament: BundledFilament = {
      ...compat,
      filament_type: firstScalar(
        inheritedField(byName, json, "filament_type") as
          | string
          | string[]
          | undefined,
      ),
      filament_colour: firstScalar(
        inheritedField(byName, json, "filament_colour") as
          | string
          | string[]
          | undefined,
      ),
    };
    out.push(filament);
  }
  // Stable alphabetical order by name so the dropdown is predictable.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export type BundledProfile = Record<string, unknown> & {
  name?: string;
  inherits?: string;
  instantiation?: string;
};

// A profile that inherits from a missing parent ends the walk with whatever it
// has. 32 of the shipped BBL filament profiles do exactly that -- their
// `inherits` names a file the bundle does not contain -- so this has to be a
// silent stop, the same way the slicing resolver treats a dangling `inherits`.
const MAX_INHERITS_DEPTH = 12;

/**
 * First definition of ``key`` at or above ``profile`` in its ``inherits``
 * chain, or ``undefined`` when no ancestor defines it.
 *
 * A child's own value wins, which is what makes this a resolution rather than
 * a lookup: `Bambu PLA Basic @BBL A1` overriding a base's `compatible_printers`
 * must not be answered with the base's list. The visited set guards against a
 * cycle in a hand-edited bundle -- the shipped ones have none, but this runs
 * over whatever tree the image happens to carry.
 */
export function inheritedField(
  byName: Map<string, BundledProfile>,
  profile: BundledProfile,
  key: string,
): unknown {
  let current: BundledProfile | undefined = profile;
  const seen = new Set<string>();
  for (let depth = 0; current && depth <= MAX_INHERITS_DEPTH; depth += 1) {
    if (key in current) return current[key];
    const parent = current.inherits;
    if (typeof parent !== "string" || parent.length === 0 || seen.has(parent)) {
      return undefined;
    }
    seen.add(parent);
    current = byName.get(parent);
  }
  return undefined;
}

function stringList(value: unknown): string[] | null {
  // A single-printer profile may store a bare string where the convention is
  // a list. Anything that isn't usable returns null rather than an empty
  // array: the consumer distinguishes "declares no printers" (never true in
  // practice) from "said nothing", and only the latter may fall back to
  // guessing the printer from the profile name.
  const raw = typeof value === "string" ? [value] : value;
  if (!Array.isArray(raw)) return null;
  const names = raw
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : null;
}

function firstScalar(value: string | string[] | undefined): string | null {
  // OrcaSlicer stores per-extruder fields like `filament_type` as arrays
  // (e.g. `["PLA"]` for single-extruder, `["PLA", "PETG"]` for bi-material).
  // For pre-pick matching the first slot is what matters; the caller already
  // knows which slot it's matching to and a per-slot value isn't meaningful
  // on a bundled profile that hasn't been bound to a specific extruder yet.
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.length > 0 ? first : null;
  }
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

// Bundle routes are defined before /:category so the literal "bundle" /
// "bundles" path segments don't get matched as a category by the more
// generic handlers below (validateCategory would reject them).
//
// POST /profiles/bundle
//   Upload a BambuStudio "Printer Preset Bundle" (.bbscfg). Idempotent —
//   re-uploading the same file yields the same bundle id and re-uses the
//   existing extracted directory.
router.post("/bundle", uploadBundle.single("file"), async (req, res) => {
  if (!req.file) {
    throw new AppError(400, "Bundle file is required");
  }
  const summary = await importBundle(req.file.buffer);
  res.status(201).json(summary);
});

// GET /profiles/bundles
//   List every bundle stored in DATA_PATH/bundles. Each summary names the
//   inner printer / process / filament presets a slice request can pick
//   from, so the consumer doesn't need a second round-trip per bundle to
//   build a Slice modal.
router.get("/bundles", async (_req, res) => {
  const bundles = await listBundles();
  res.status(200).json(bundles);
});

// GET /profiles/bundles/:id
//   Single-bundle summary (same shape as the list entry). Useful when a
//   client persists the id and wants to re-confirm the bundle still exists
//   and which presets it contains before showing slice options.
router.get("/bundles/:id", async (req, res) => {
  const summary = await readBundleSummary(req.params.id);
  res.status(200).json(summary);
});

// DELETE /profiles/bundles/:id
//   Remove a bundle and its extracted preset files. Slicing requests
//   referencing this id will fail with 404 afterwards.
router.delete("/bundles/:id", async (req, res) => {
  await deleteBundle(req.params.id);
  res.status(204).send();
});

const RESOLVER_CATEGORIES: ProfileCategory[] = ["machine", "process", "filament"];

// Flatten a profile's `inherits:` chain and return the effective values.
//
// Registered before the "/:category" routes below, or Express matches
// "resolve" as a category name.
//
// This is the same resolver `/slice` runs, against the same bundled profiles,
// which is the whole point: a caller that wants to show a user what a preset
// actually sets must not re-implement the walk against a different profile
// tree and quietly disagree with what gets sliced.
//
// The body carries the profile rather than a name so all three shapes work
// through one path: a `{inherits: "<system preset>"}` stub, a user's delta
// with an inherits chain, and an already-flat profile (returned unchanged).
router.post("/resolve", async (req, res) => {
  const category = req.body?.category;
  const profile = req.body?.profile;

  // Not `validateCategory`: that guards the *storage* names
  // (printers / presets / filaments) used by the CRUD routes below. The
  // resolver keys off the bundled-profile directory names instead.
  if (!RESOLVER_CATEGORIES.includes(category)) {
    throw new AppError(
      400,
      "Invalid or missing category",
      `Expected one of ${RESOLVER_CATEGORIES.join(", ")}`,
    );
  }

  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new AppError(400, "A `profile` object is required");
  }

  const bundledProfilesPath = getDefaultBundledProfilesPath();
  if (!bundledProfilesPath) {
    throw new AppError(
      500,
      "Bundled profiles path is not configured",
      "Set BUNDLED_PROFILES_PATH or ORCASLICER_PATH so the resolver can locate resources/profiles.",
    );
  }

  const resolved = await resolveProfile(
    profile as ProfileJson,
    category as ProfileCategory,
    { bundledProfilesPath },
  );

  res.status(200).json({ profile: resolved });
});

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
