import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  inheritedField,
  readBundledDir,
  type BundledCompatEntry,
  type BundledFilament,
  type BundledProfile,
} from "../../src/routes/profiles/route";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-index-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(profile: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(dir, `${profile.name as string}.json`),
    JSON.stringify(profile),
    "utf8",
  );
}

// The shape the shipped BBL bundle actually has: the leaf carries only its own
// deltas, the material sits two hops up, and the printer list sits on the leaf.
async function writeBblFilamentChain(): Promise<void> {
  await write({
    name: "fdm_filament_abs",
    instantiation: "false",
    filament_type: ["ABS"],
  });
  await write({
    name: "Bambu ABS @base",
    inherits: "fdm_filament_abs",
    instantiation: "false",
    filament_vendor: ["Bambu Lab"],
  });
  await write({
    name: "Bambu ABS @BBL A1",
    inherits: "Bambu ABS @base",
    instantiation: "true",
    compatible_printers: ["Bambu Lab A1 0.4 nozzle", "Bambu Lab A1 0.6 nozzle"],
  });
}

describe("inheritedField", () => {
  const byName = new Map<string, BundledProfile>([
    ["root", { name: "root", filament_type: ["PLA"], shared: "root" }],
    ["mid", { name: "mid", inherits: "root", shared: "mid" }],
    ["leaf", { name: "leaf", inherits: "mid" }],
  ]);

  it("finds a field defined several hops up the chain", () => {
    expect(inheritedField(byName, byName.get("leaf")!, "filament_type")).toEqual([
      "PLA",
    ]);
  });

  it("prefers the nearest definition over an ancestor's", () => {
    expect(inheritedField(byName, byName.get("leaf")!, "shared")).toBe("mid");
  });

  it("returns a profile's own value without walking", () => {
    expect(inheritedField(byName, byName.get("root")!, "shared")).toBe("root");
  });

  it("returns undefined when no ancestor defines the field", () => {
    expect(inheritedField(byName, byName.get("leaf")!, "nope")).toBeUndefined();
  });

  it("stops at a dangling inherits instead of throwing", () => {
    // 32 of the shipped BBL filament profiles name a parent the bundle does
    // not contain. They must still be listed, just without the field.
    const dangling = new Map<string, BundledProfile>([
      ["orphan", { name: "orphan", inherits: "not-in-this-bundle" }],
    ]);
    expect(
      inheritedField(dangling, dangling.get("orphan")!, "filament_type"),
    ).toBeUndefined();
  });

  it("terminates on a cycle", () => {
    const cyclic = new Map<string, BundledProfile>([
      ["a", { name: "a", inherits: "b" }],
      ["b", { name: "b", inherits: "a" }],
    ]);
    expect(inheritedField(cyclic, cyclic.get("a")!, "filament_type")).toBeUndefined();
  });
});

describe("readBundledDir", () => {
  it("resolves filament_type through the inherits chain", async () => {
    // Zero of the 1156 instantiable BBL filament leaves carry filament_type.
    // Reading the leaf alone returned null for every one of them, which is
    // what let a PETG preset be auto-picked for a PLA plate (#2982).
    await writeBblFilamentChain();
    const out = (await readBundledDir(dir, "filament")) as BundledFilament[];
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Bambu ABS @BBL A1");
    expect(out[0].filament_type).toBe("ABS");
  });

  it("reports compatible_printers for filament and process entries", async () => {
    await writeBblFilamentChain();
    const out = (await readBundledDir(dir, "filament")) as BundledFilament[];
    expect(out[0].compatible_printers).toEqual([
      "Bambu Lab A1 0.4 nozzle",
      "Bambu Lab A1 0.6 nozzle",
    ]);
  });

  it("keeps a process usable on a printer no profile is named after", async () => {
    // Every P1S process preset is named "@BBL X1C" and names the P1S only in
    // compatible_printers. Dropping that list left the P1S with no compatible
    // process at all, and an A1 one auto-picked in its place (#2982).
    await write({
      name: "0.20mm Standard @BBL X1C",
      instantiation: "true",
      compatible_printers: [
        "Bambu Lab X1 Carbon 0.4 nozzle",
        "Bambu Lab P1S 0.4 nozzle",
      ],
    });
    const out = (await readBundledDir(dir, "process")) as BundledCompatEntry[];
    expect(out[0].compatible_printers).toContain("Bambu Lab P1S 0.4 nozzle");
  });

  it("omits abstract bases from the listing but still reads through them", async () => {
    await writeBblFilamentChain();
    const out = await readBundledDir(dir, "filament");
    expect(out.map((p) => p.name)).toEqual(["Bambu ABS @BBL A1"]);
  });

  it("lists a profile whose parent is missing, with the field left null", async () => {
    await write({
      name: "PolyLite PLA @BBL H2S",
      inherits: "PolyLite PLA @base",
      instantiation: "true",
      compatible_printers: ["Bambu Lab H2S 0.4 nozzle"],
    });
    const out = (await readBundledDir(dir, "filament")) as BundledFilament[];
    expect(out).toHaveLength(1);
    expect(out[0].filament_type).toBeNull();
    expect(out[0].compatible_printers).toEqual(["Bambu Lab H2S 0.4 nozzle"]);
  });

  it("normalises a bare-string compatible_printers to a list", async () => {
    await write({
      name: "Solo",
      instantiation: "true",
      compatible_printers: "Bambu Lab P1S 0.4 nozzle",
    });
    const out = (await readBundledDir(dir, "process")) as BundledCompatEntry[];
    expect(out[0].compatible_printers).toEqual(["Bambu Lab P1S 0.4 nozzle"]);
  });

  it("reports a missing compatible_printers as null, not an empty list", async () => {
    // "said nothing" has to stay distinguishable from "declares no printers":
    // only the former may fall back to guessing the printer from the name.
    await write({ name: "Generic ABS", instantiation: "true" });
    const out = (await readBundledDir(dir, "filament")) as BundledFilament[];
    expect(out[0].compatible_printers).toBeNull();
  });

  it("takes the first extruder's value from an array-typed field", async () => {
    await write({
      name: "Bi-material",
      instantiation: "true",
      filament_type: ["PLA", "PETG"],
    });
    const out = (await readBundledDir(dir, "filament")) as BundledFilament[];
    expect(out[0].filament_type).toBe("PLA");
  });

  it("leaves filament_colour null when the bundle carries none", async () => {
    // True of the entire BBL tree at every depth -- colour is a spool
    // attribute, not a profile one.
    await writeBblFilamentChain();
    const out = (await readBundledDir(dir, "filament")) as BundledFilament[];
    expect(out[0].filament_colour).toBeNull();
  });

  it("omits compatibility fields from printer entries", async () => {
    await write({ name: "Bambu Lab P1S 0.4 nozzle", instantiation: "true" });
    const out = await readBundledDir(dir, "printer");
    expect(out[0]).toEqual({ name: "Bambu Lab P1S 0.4 nozzle", base_id: null });
  });

  it("skips an unparseable file without losing the rest of the directory", async () => {
    await write({ name: "Good", instantiation: "true" });
    await fs.writeFile(path.join(dir, "Broken.json"), "{ not json", "utf8");
    const out = await readBundledDir(dir, "filament");
    expect(out.map((p) => p.name)).toEqual(["Good"]);
  });

  it("returns an empty list for a directory that does not exist", async () => {
    expect(await readBundledDir(path.join(dir, "absent"), "filament")).toEqual([]);
  });

  it("sorts entries by name", async () => {
    await write({ name: "Zed", instantiation: "true" });
    await write({ name: "Alpha", instantiation: "true" });
    const out = await readBundledDir(dir, "process");
    expect(out.map((p) => p.name)).toEqual(["Alpha", "Zed"]);
  });
});
