import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";

/**
 * Upload-cap behaviour on POST /slice.
 *
 * These run without a slicer binary on purpose: multer rejects the request
 * before anything is spawned, which is exactly the layer under test.
 *
 * Regression context (bambuddy#2802): the model cap was a hardcoded 100 MB and
 * multer's rejection surfaced as HTTP 500 `{"message":"File too large"}`. A 500
 * reads as "the slicer crashed", so the reporter spent the evening raising body
 * limits on a reverse proxy that was never in the path. The status and the text
 * are the fix, so both are asserted rather than just the rejection.
 */

const ORIGINAL_ENV = { ...process.env };

async function appWithLimits(
  env: Record<string, string | undefined>,
): Promise<ReturnType<typeof supertest>> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The caps are module-level constants, so a fresh import is what makes a
  // different limit observable.
  vi.resetModules();
  const { configureApp } = await import("../../src/index");
  return supertest(configureApp());
}

function model(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes);
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("model upload cap", () => {
  it("rejects an oversize model with 413 and names the limit", async () => {
    const request = await appWithLimits({ MAX_MODEL_UPLOAD_MB: "1" });

    const response = await request
      .post("/slice")
      .attach("file", model(2 * 1024 * 1024), {
        filename: "big.3mf",
        contentType: "model/3mf",
      });

    expect(response.status).toBe(413);
    expect(response.body.message).toContain("1 MB");
    expect(response.body.message).toMatch(/model file/i);
  });

  it("tells the caller which knob to turn, and which one not to", async () => {
    const request = await appWithLimits({ MAX_MODEL_UPLOAD_MB: "1" });

    const response = await request
      .post("/slice")
      .attach("file", model(2 * 1024 * 1024), {
        filename: "big.3mf",
        contentType: "model/3mf",
      });

    // Without this the message is just a number, and the reader's next guess
    // is their proxy -- which is the wrong layer and cost #2802 an evening.
    expect(response.body.details).toContain("MAX_MODEL_UPLOAD_MB");
    expect(response.body.details).toMatch(/not by any proxy/i);
  });

  it("accepts a model that fits under a raised cap", async () => {
    const request = await appWithLimits({ MAX_MODEL_UPLOAD_MB: "8" });

    const response = await request
      .post("/slice")
      .attach("file", model(4 * 1024 * 1024), {
        filename: "ok.3mf",
        contentType: "model/3mf",
      });

    // No slicer is configured here, so the request gets as far as the slicing
    // service and stops there. Anything other than 413 proves the upload layer
    // let it through, which is the whole assertion.
    expect(response.status).not.toBe(413);
  });

  it("falls back to the default when the env value is nonsense", async () => {
    const request = await appWithLimits({ MAX_MODEL_UPLOAD_MB: "please" });

    const response = await request
      .post("/slice")
      .attach("file", model(2 * 1024 * 1024), {
        filename: "small.3mf",
        contentType: "model/3mf",
      });

    // A typo in an env var must not silently clamp uploads to nothing -- or,
    // worse, stop the container from starting.
    expect(response.status).not.toBe(413);
  });
});

describe("profile upload cap", () => {
  it("bounds profile parts separately from the model", async () => {
    // multer applies one fileSize to every part, so without a separate bound
    // a mislabelled "profile" could buffer the model-sized ceiling into heap.
    const request = await appWithLimits({
      MAX_MODEL_UPLOAD_MB: "64",
      MAX_JSON_UPLOAD_MB: "1",
    });

    const response = await request
      .post("/slice")
      .attach("file", model(1024), {
        filename: "ok.3mf",
        contentType: "model/3mf",
      })
      .attach("printerProfile", model(2 * 1024 * 1024), {
        filename: "printer.json",
        contentType: "application/json",
      });

    expect(response.status).toBe(413);
    expect(response.body.message).toContain("printerProfile");
  });

  it("leaves normal-sized profiles alone", async () => {
    const request = await appWithLimits({
      MAX_MODEL_UPLOAD_MB: "64",
      MAX_JSON_UPLOAD_MB: "1",
    });

    const response = await request
      .post("/slice")
      .attach("file", model(1024), {
        filename: "ok.3mf",
        contentType: "model/3mf",
      })
      .attach("printerProfile", Buffer.from(JSON.stringify({ a: 1 })), {
        filename: "printer.json",
        contentType: "application/json",
      });

    expect(response.status).not.toBe(413);
  });
});
