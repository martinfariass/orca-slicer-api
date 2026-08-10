import { describe, expect, it } from "vitest";
import { request } from "./setup";
import fs from "fs";
import path from "path";

/**
 * STEP is refused at the HTTP boundary, not by the slicer.
 *
 * These tests used to slice `Cube.step` and expect 200. Neither CLI can load
 * it: OrcaSlicer 2.4.2 and BambuStudio 02.07.01.62 both answer
 *
 *   Unknown file format. Input file must have .stl, .obj, .amf(.xml) extension.
 *
 * and exit 250. The wrapper accepted the upload anyway, so an unsupported
 * format arrived as "The input model file to the slicer can not be parsed"
 * several seconds later -- indistinguishable from a corrupt model, and the
 * upload was buffered and written to disk before anyone found out.
 *
 * The format is now rejected up front with a message naming the supported
 * ones. If a future slicer release grows CLI STEP support, delete
 * `unsupportedModelExts` in middleware/upload.ts and restore the slicing
 * assertions from git history rather than loosening these.
 */
describe("STEP uploads", () => {
  const stepBuffer = () =>
    fs.readFileSync(path.join(__dirname, "../files/input/Cube.step"));

  const profile = (name: string) =>
    fs.readFileSync(path.join(__dirname, `../files/input/${name}`));

  it("is rejected before the slicer is spawned", async () => {
    const response = await request
      .post("/slice")
      .attach("file", stepBuffer(), "Cube.step")
      .attach("printerProfile", profile("printer.json"), "printer.json")
      .attach("presetProfile", profile("process.json"), "process.json")
      .attach("filamentProfile", profile("filament.json"), "filament.json")
      .expect(400);

    // 400, not 500: the input is wrong, the service is fine. A 500 here sent
    // people looking for a broken slicer (compare bambuddy#2802).
    expect(response.body.message).toMatch(/STEP/);
  });

  it("names the formats that do work", async () => {
    const response = await request
      .post("/slice")
      .attach("file", stepBuffer(), "Cube.step")
      .expect(400);

    // "Unsupported" on its own leaves the caller guessing what to convert to.
    expect(response.body.message).toMatch(/STL/);
    expect(response.body.message).toMatch(/3MF/);
  });

  it("rejects .stp as well as .step", async () => {
    const response = await request
      .post("/slice")
      .attach("file", stepBuffer(), "Cube.stp")
      .expect(400);

    expect(response.body.message).toMatch(/STEP/);
  });

  it("still accepts the formats the slicer can load", async () => {
    // Guards the obvious over-correction: dropping STEP from the allow-list
    // must not take STL with it.
    const stl = fs.readFileSync(
      path.join(__dirname, "../files/input/Cube.stl"),
    );

    const response = await request
      .post("/slice")
      .attach("file", stl, "Cube.stl")
      .attach("printerProfile", profile("printer.json"), "printer.json")
      .attach("presetProfile", profile("process.json"), "process.json")
      .attach("filamentProfile", profile("filament.json"), "filament.json");

    expect(response.status).toBe(200);
  }, 120_000);
});
