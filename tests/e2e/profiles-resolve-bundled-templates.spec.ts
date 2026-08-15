import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { request } from "./setup";
import { getDefaultBundledProfilesPath } from "../../src/routes/slicing/profile-resolver";

// The other resolve specs build a throwaway profile tree, which proves the
// walk but says nothing about the tree we actually ship. This one runs
// against the real bundle inside the image, because the defect it guards
// against was invisible in fixtures: a preset can keep a setting in a
// `<preset> template <key>.json` companion that nothing references, and a
// resolver walking only `inherits` silently falls through to the generic
// value on the root template (bambuddy#2838).
//
// For `machine_start_gcode` that generic value is a ~577-character stub with
// no `M620` AMS load and no `M1002 gcode_claim_action`, so a print sliced
// with it heats the bed, moves the toolhead and extrudes nothing. Fixtures
// cannot catch a bundle reorganising itself in a future slicer release —
// only the shipped tree can.

const bundledPath = getDefaultBundledProfilesPath();
const bundledSuite = bundledPath ? describe : describe.skip;

type MachineEntry = { name: string };

const instantiable: string[] = [];
let genericStartGcode = "";

const readProfile = async (name: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(
      await fs.readFile(path.join(bundledPath as string, "machine", `${name}.json`), "utf-8"),
    );
  } catch {
    return null;
  }
};

const resolveMachine = async (name: string) => {
  const res = await request
    .post("/profiles/resolve")
    .send({
      category: "machine",
      profile: { name, inherits: name, from: "system", type: "machine" },
    })
    .expect(200);
  return res.body.profile as Record<string, unknown>;
};

const asText = (value: unknown): string =>
  Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");

bundledSuite("the shipped bundle resolves to real machine gcode", () => {
  beforeAll(async () => {
    // `BBL.json` sits one level above the category directories and is the
    // bundle's own list of presets, so it stays right when files are added.
    const index = JSON.parse(
      await fs.readFile(path.join(bundledPath as string, "..", "BBL.json"), "utf-8"),
    );

    for (const entry of index.machine_list as MachineEntry[]) {
      if (entry.name.includes(" template ")) continue;
      const own = await readProfile(entry.name);
      if (!own) continue;
      if (String(own.instantiation ?? "").toLowerCase() !== "true") continue;
      instantiable.push(entry.name);
    }

    const root = await readProfile("fdm_machine_common");
    genericStartGcode = asText(root?.machine_start_gcode);
  });

  it("has presets to check and a generic value to compare against", () => {
    // Both are read out of the bundle, so a reorganisation that empties
    // either would otherwise make the real assertion below vacuous.
    expect(instantiable.length).toBeGreaterThan(0);
    expect(genericStartGcode.length).toBeGreaterThan(0);
  });

  it("gives every instantiable machine preset its own start gcode", async () => {
    const generic: string[] = [];
    const missing: string[] = [];

    for (const name of instantiable) {
      const resolved = await resolveMachine(name);
      const startGcode = asText(resolved.machine_start_gcode);
      if (!startGcode) {
        missing.push(name);
      } else if (startGcode === genericStartGcode) {
        generic.push(name);
      }
    }

    // Named rather than counted: when this breaks, the list is the diagnosis.
    expect({ generic, missing }).toEqual({ generic: [], missing: [] });
  });

  it("carries the AMS load macros a print needs to actually extrude", async () => {
    // Any one preset would do; this is the model the defect was reported on.
    const resolved = await resolveMachine("Bambu Lab X2D 0.4 nozzle");
    const startGcode = asText(resolved.machine_start_gcode);

    expect(startGcode).toContain("M620");
    expect(startGcode).toContain("M620.10");
    expect(startGcode).toContain("gcode_claim_action");
  });

  it("resolves a nozzle variant that owns no companion of its own", async () => {
    // The 0.2 / 0.6 / 0.8 presets have no companion; they reach their 0.4
    // sibling's through the inherits walk. Roughly half the shipped presets
    // depend on that, so it needs its own case.
    const variant = await resolveMachine("Bambu Lab X2D 0.6 nozzle");
    const sibling = await resolveMachine("Bambu Lab X2D 0.4 nozzle");

    expect(asText(variant.machine_start_gcode)).toBe(asText(sibling.machine_start_gcode));
    expect(variant.name).toBe("Bambu Lab X2D 0.6 nozzle");
  });
});
