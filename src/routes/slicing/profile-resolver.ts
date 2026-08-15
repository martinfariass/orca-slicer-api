import { promises as fs } from "fs";
import * as path from "path";
import { AppError } from "../../middleware/error";

export type ProfileCategory = "machine" | "process" | "filament";

export type ProfileJson = Record<string, unknown> & {
  type?: string;
  name?: string;
  inherits?: string;
};

export interface ResolveOptions {
  bundledProfilesPath: string;
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 16;

// Bundled presets may keep a setting in a companion file named
// `<preset name> template <setting key>.json` instead of inline. Nothing in
// the preset itself points at them — the GUI finds them by this name — so a
// resolver that only walks `inherits` never sees them.
//
// It is not a corner case. Every one of the 56 instantiable BBL machine
// presets omits `machine_start_gcode` from its own file and from every
// ancestor bar `fdm_machine_common`, whose value is a 577-character generic
// stub. 29 of them ship the real block — 6.5 KB to 21 KB, per model — in a
// companion; the remaining 27 are the 0.2/0.6/0.8 nozzle variants, which
// inherit from their 0.4 sibling and so pick the companion up through the
// walk below. The same layout carries machine_end_gcode,
// change_filament_gcode, layer_change_gcode and time_lapse_gcode.
//
// Losing machine_start_gcode is not cosmetic: it holds the `M620` AMS load
// macros and the `M1002 gcode_claim_action` calls, so a print sliced without
// it heats the bed, moves the toolhead and extrudes nothing while reporting
// no preparation stage (bambuddy#2838).
const TEMPLATE_MARKER = " template ";

// Copied from a companion only when the preset does not define the key
// itself, so these identity fields never leak across. `name` would rename
// the preset to "… template machine_start_gcode" and `instantiation: false`
// would mark it unusable — both are the companion's own bookkeeping, not
// settings it contributes.
const TEMPLATE_IDENTITY_KEYS = new Set([
  "name",
  "inherits",
  "instantiation",
  "type",
  "from",
]);

type TemplateIndex = Map<string, string[]>;

// `--load-settings` does not run the GUI's preset-registry resolver.
// Required fields like layer_change_gcode live on parent templates
// (fdm_machine_common etc.) that the CLI will NOT pull in implicitly.
// The resolver therefore walks the chain fully — to the root — and emits
// a flat profile with everything baked in. Dangling inherits values that
// don't map to a bundled file are dropped silently (matches how upstream
// fixtures with stale `fdm_process_bbl_0.20` inherits work today).
export async function resolveProfile(
  profile: ProfileJson,
  category: ProfileCategory,
  options: ResolveOptions,
): Promise<ProfileJson> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  let current: ProfileJson = { ...profile };
  stripUserSentinels(current);
  let depth = 0;

  // One listing for the whole walk rather than a probe per ancestor per
  // candidate key — and it discovers the keys instead of hardcoding today's
  // five, so a companion for a new setting in a future bundle is picked up.
  const templates = await readTemplateIndex(
    path.join(options.bundledProfilesPath, category),
  );

  while (
    typeof current.inherits === "string" &&
    current.inherits.length > 0
  ) {
    if (depth >= maxDepth) {
      throw new AppError(
        500,
        "Profile inheritance chain exceeded maximum depth",
        `category=${category} depth=${depth} stopped at inherits=${current.inherits}`,
      );
    }

    const parentName = current.inherits;
    const parentPath = path.join(
      options.bundledProfilesPath,
      category,
      `${parentName}.json`,
    );

    let parentRaw: string;
    try {
      parentRaw = await fs.readFile(parentPath, "utf-8");
    } catch {
      delete current.inherits;
      break;
    }

    let parent: ProfileJson;
    try {
      parent = JSON.parse(parentRaw) as ProfileJson;
    } catch (err) {
      throw new AppError(
        500,
        `Bundled profile is not valid JSON: "${parentName}"`,
        `category=${category} path=${parentPath} ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fold the companions into the ancestor *before* merging, so they carry
    // that ancestor's precedence: below anything a descendant or the user's
    // own delta already set, above whatever the ancestor's own parents
    // provide. That ordering is what makes the generic
    // `fdm_machine_common` value lose to the model's real block, and what
    // lets a 0.6 nozzle preset inherit its 0.4 sibling's companion.
    await applyCompanionTemplates(parent, parentName, category, options, templates);

    current = mergeProfiles(parent, current);
    depth += 1;
  }

  // After full flattening the output is functionally a system preset, so
  // mark it as one (see normalizeFromField for the casing rationale).
  // materializeProfile also calls this unconditionally so System-tier
  // exports with `inherits: ""` — which never reach this code path — get
  // the same treatment.
  normalizeFromField(current);

  // OrcaSlicer's GUI prefixes user clones of system presets with "# "
  // (e.g. "# Bambu Lab X1 Carbon 0.4 nozzle"). The CLI's compatibility
  // check matches the printer's `name` literally against each profile's
  // `compatible_printers` list, which contains the un-prefixed system
  // names. Strip the prefix so a clone-and-export workflow lines up
  // with the bundled compat lists.
  if (typeof current.name === "string" && current.name.startsWith("# ")) {
    current.name = current.name.slice(2);
  }

  return current;
}

/**
 * Index the companion files in a bundled category by the preset they belong to.
 *
 * `Bambu Lab X2D 0.4 nozzle template machine_start_gcode.json` is indexed
 * under `Bambu Lab X2D 0.4 nozzle`. A missing directory yields an empty
 * index: a category with no bundled tree simply has no companions, which is
 * the same outcome the inherits walk already produces for it.
 */
async function readTemplateIndex(dir: string): Promise<TemplateIndex> {
  const index: TemplateIndex = new Map();

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return index;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const base = entry.slice(0, -".json".length);
    // Last occurrence, so the owner keeps every earlier word: the marker is
    // a separator before the setting key, not a token that can appear only
    // once. Index 0 would mean a file named " template x.json" with no owner.
    const marker = base.lastIndexOf(TEMPLATE_MARKER);
    if (marker <= 0) {
      continue;
    }
    const owner = base.slice(0, marker);
    const existing = index.get(owner);
    if (existing) {
      existing.push(base);
    } else {
      index.set(owner, [base]);
    }
  }

  return index;
}

/**
 * Merge `name`'s companion files into `profile`, in place.
 *
 * A companion only fills a key the preset's own file leaves unset. No preset
 * in the bundle both defines one of these settings inline and ships a
 * companion for it, so the rule is unobservable there — it is chosen so that
 * an explicit value in the preset itself is never silently overwritten by a
 * file it does not reference.
 */
async function applyCompanionTemplates(
  profile: ProfileJson,
  name: string,
  category: ProfileCategory,
  options: ResolveOptions,
  index: TemplateIndex,
): Promise<void> {
  for (const companionName of index.get(name) ?? []) {
    const companionPath = path.join(
      options.bundledProfilesPath,
      category,
      `${companionName}.json`,
    );

    let raw: string;
    try {
      raw = await fs.readFile(companionPath, "utf-8");
    } catch {
      // Listed a moment ago, so this is a race or a permission problem
      // rather than a missing companion. Skipping matches how the walk
      // treats an unreadable ancestor.
      continue;
    }

    let companion: ProfileJson;
    try {
      companion = JSON.parse(raw) as ProfileJson;
    } catch (err) {
      // Loud, like the parent path: swallowing this would put us back to
      // slicing with a silently generic start gcode, which is the failure
      // this whole mechanism exists to prevent.
      throw new AppError(
        500,
        `Bundled profile template is not valid JSON: "${companionName}"`,
        `category=${category} path=${companionPath} ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const [key, value] of Object.entries(companion)) {
      if (TEMPLATE_IDENTITY_KEYS.has(key) || key in profile) {
        continue;
      }
      profile[key] = value;
    }
  }
}

/**
 * Strip "auto" sentinel values from a user-exported delta in place.
 *
 * OrcaSlicer's GUI lets users leave many numeric fields set to `-1`
 * (or array equivalents) meaning "use the slicer's default". The CLI's
 * range validation rejects these literally — e.g.
 * `prime_tower_brim_width: "-1" not in range [0, ∞]`. By dropping the
 * field from the user's delta, the merged profile picks up whatever
 * value its bundled ancestor sets, or the CLI's compiled-in default.
 *
 * Empty strings get the same treatment because the GUI emits them for
 * fields the user hasn't customized; the CLI rejects them where a
 * concrete value is expected.
 */
function stripUserSentinels(profile: ProfileJson): void {
  for (const k of Object.keys(profile)) {
    const v = profile[k];
    if (v === "-1" || v === "") {
      delete profile[k];
    } else if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => x === "-1" || x === "")
    ) {
      delete profile[k];
    }
  }
}

// BambuStudio's "Export Preset Bundle" omits `type:` on System-tier presets
// (the GUI infers it from the directory the file lived in) and emits
// `inherits: ""` for them, so resolveProfile's inherits walk never runs and
// can't pick up `type` from a parent. The CLI's --load-settings/--load-filaments
// parser then sees a type-less file, logs `operator(): unknown config type
// ... in load-settings`, writes `error_string: "The input preset file is
// invalid and can not be parsed.", return_code: -5` to result.json, and
// exits 0. Stamp the category we already know.
export function ensureProfileType(
  profile: ProfileJson,
  category: ProfileCategory,
): ProfileJson {
  if (typeof profile.type !== "string" || profile.type.length === 0) {
    profile.type = category;
  }
  return profile;
}

// The CLI's compatibility check accepts `from: "system"` (lowercase) as the
// canonical system-tier marker and rejects everything else with
// `from <value> unsupported` (return_code -5, surfaced as the same
// "input preset file is invalid and can not be parsed." rejection).
//
// Two casings appear in real exports:
//   - "User"   — user-cloned presets out of the OrcaSlicer/BambuStudio GUI.
//                After resolveProfile flattens the inherits chain, the
//                output is functionally a system preset and should be
//                marked as such.
//   - "System" — BambuStudio's "Export Preset Bundle" for a System-tier
//                root preset (printer / built-in filament) writes this
//                literally. The GUI accepts it because the GUI's own
//                check is case-insensitive; the CLI's is not.
//
// "Default" and other values are NOT remapped — those are distinct tiers
// the CLI handles, and silently rewriting them would mask a real
// mis-tagged file.
export function normalizeFromField(profile: ProfileJson): ProfileJson {
  if (profile.from === "User" || profile.from === "System") {
    profile.from = "system";
  }
  return profile;
}

export function mergeProfiles(
  parent: ProfileJson,
  child: ProfileJson,
): ProfileJson {
  const merged: ProfileJson = { ...parent, ...child };
  if (typeof parent.inherits === "string" && parent.inherits.length > 0) {
    merged.inherits = parent.inherits;
  } else {
    delete merged.inherits;
  }
  return merged;
}

export function getDefaultBundledProfilesPath(): string | undefined {
  const orcaPath = process.env.BUNDLED_PROFILES_PATH;
  if (orcaPath && orcaPath.length > 0) {
    return orcaPath;
  }
  if (process.env.ORCASLICER_PATH) {
    return path.join(
      path.dirname(process.env.ORCASLICER_PATH),
      "resources",
      "profiles",
      "BBL",
    );
  }
  return undefined;
}
