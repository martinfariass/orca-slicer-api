import { describe, expect, it } from "vitest";
import { request } from "./setup";
import fs from "fs";
import path from "path";

/**
 * Write a profile file straight to DATA_PATH, bypassing the upload route.
 *
 * POST /profiles/:category validates the JSON, so an unparseable profile
 * cannot be created through the API -- but one can certainly exist on disk
 * (a half-written file, a hand-edited DATA_PATH), and that case has to read
 * differently from a profile that simply isn't there.
 */
function saveRaw(category: string, name: string, contents: string): void {
  const base = process.env.DATA_PATH || path.join(process.cwd(), "data");
  const dir = path.join(base, category);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), contents, "utf8");
}

describe("Profiles API", () => {
  const printerPath = path.join(__dirname, "../files/input/printer.json");
  const printerBuffer = fs.readFileSync(printerPath);

  const presetPath = path.join(__dirname, "../files/input/process.json");
  const presetBuffer = fs.readFileSync(presetPath);

  const filamentPath = path.join(__dirname, "../files/input/filament.json");
  const filamentBuffer = fs.readFileSync(filamentPath);

  describe("POST /profiles/:category", () => {
    it("should upload a printer profile successfully", async () => {
      await request
        .post("/profiles/printers")
        .field("name", "testprinter")
        .attach("file", printerBuffer, "printer.json")
        .expect(201)
        .expect("Content-Type", /json/)
        .expect({ name: "testprinter" });
    });

    it("should upload a preset profile successfully", async () => {
      await request
        .post("/profiles/presets")
        .field("name", "testpreset")
        .attach("file", presetBuffer, "process.json")
        .expect(201)
        .expect({ name: "testpreset" });
    });

    it("should upload a filament profile successfully", async () => {
      await request
        .post("/profiles/filaments")
        .field("name", "testfilament")
        .attach("file", filamentBuffer, "filament.json")
        .expect(201)
        .expect({ name: "testfilament" });
    });

    it("should return 400 for invalid category", async () => {
      await request
        .post("/profiles/invalid")
        .field("name", "test")
        .attach("file", printerBuffer, "printer.json")
        .expect(400)
        .expect((res) => {
          if (res.body.message !== "Invalid or missing category")
            throw new Error("Wrong error message: " + res.body.message);
        });
    });

    it("should return 400 for invalid name (special characters)", async () => {
      await request
        .post("/profiles/printers")
        .field("name", "test-printer!")
        .attach("file", printerBuffer, "printer.json")
        .expect(400)
        .expect((res) => {
          if (res.body.message !== "Name must only contain letters and numbers")
            throw new Error("Wrong error message: " + res.body.message);
        });
    });

    it("should return 400 if file is missing", async () => {
      await request
        .post("/profiles/printers")
        .field("name", "testprinter")
        .expect(400)
        .expect((res) => {
          if (res.body.message !== "File is required")
            throw new Error("Wrong error message: " + res.body.message);
        });
    });
  });

  describe("GET /profiles/:category", () => {
    it("should list uploaded printer profiles", async () => {
      await request
        .get("/profiles/printers")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (!Array.isArray(res.body))
            throw new Error("Response should be an array");
          if (!res.body.includes("testprinter"))
            throw new Error("testprinter should be in the list");
        });
    });

    it("should list uploaded preset profiles", async () => {
      await request
        .get("/profiles/presets")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (!Array.isArray(res.body))
            throw new Error("Response should be an array");
          if (!res.body.includes("testpreset"))
            throw new Error("testpreset should be in the list");
        });
    });

    it("should list uploaded filament profiles", async () => {
      await request
        .get("/profiles/filaments")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (!Array.isArray(res.body))
            throw new Error("Response should be an array");
          if (!res.body.includes("testfilament"))
            throw new Error("testfilament should be in the list");
        });
    });
  });

  describe("GET /profiles/:category/:name", () => {
    it("should get a specific printer profile", async () => {
      await request
        .get("/profiles/printers/testprinter")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (res.body.name !== "Bambu Lab P1S 0.4 nozzle")
            throw new Error(
              `Profile content mismatch, got "${res.body.name}" expected "Bambu Lab P1S 0.4 nozzle"`
            );
        });
    });
    it("should get a specific preset profile", async () => {
      await request
        .get("/profiles/presets/testpreset")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (res.body.name !== "0.20mm Standard @BBL X1C")
            throw new Error(
              `Profile content mismatch, got "${res.body.name}" expected "0.20mm Standard @BBL X1C"`
            );
        });
    });
    it("should get a specific filament profile", async () => {
      await request
        .get("/profiles/filaments/testfilament")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (res.body.name !== "Bambu PETG Basic @BBL X1C")
            throw new Error(
              `Profile content mismatch, got "${res.body.name}" expected "Bambu PETG Basic @BBL X1C"`
            );
        });
    });

    // 404, not 500. A profile that isn't there is the caller naming one that
    // doesn't exist; a 500 said the service had broken, and made a typo'd
    // preset name indistinguishable from an unreadable DATA_PATH.
    it.each(["printers", "presets", "filaments"])(
      "returns 404 for a non-existent %s profile",
      async (category) => {
        const res = await request
          .get(`/profiles/${category}/nonexistent`)
          .expect(404);
        expect(res.body.message).toContain("nonexistent");
      },
    );

    it("still reports an unreadable profile as a server error", async () => {
      // The other half of the split: the file exists but cannot be used, which
      // is a real fault and must not be dressed up as "not found".
      saveRaw("printers", "corrupt", "{ this is not json");

      const res = await request.get("/profiles/printers/corrupt").expect(500);
      expect(res.body.message).toMatch(/not valid JSON/i);
    });

    it("deleting a profile that was never there is a 404", async () => {
      await request.delete("/profiles/printers/nonexistent").expect(404);
    });
  });
});
