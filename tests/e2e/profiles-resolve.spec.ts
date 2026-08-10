import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { request } from "./setup";

// POST /profiles/resolve exposes the same inheritance walk /slice runs, so a
// client can show a user what a preset actually sets. These drive the route
// end to end against a throwaway bundled-profile tree; the walk itself is
// covered separately in tests/unit/profile-resolver.spec.ts.

let scratchRoot: string;
let originalBundledPath: string | undefined;

beforeAll(async () => {
  originalBundledPath = process.env.BUNDLED_PROFILES_PATH;
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-route-"));
  const processDir = path.join(scratchRoot, "process");
  await fs.mkdir(processDir, { recursive: true });

  // A two-level chain: the root carries a field only it defines, the middle
  // overrides one of them. Resolving must reach both.
  await fs.writeFile(
    path.join(processDir, "fdm_process_root.json"),
    JSON.stringify({
      type: "process",
      name: "fdm_process_root",
      layer_height: "0.20",
      line_width: "0.42",
      wall_loops: "2",
    }),
  );
  await fs.writeFile(
    path.join(processDir, "0.20mm Standard @BBL X1C.json"),
    JSON.stringify({
      type: "process",
      name: "0.20mm Standard @BBL X1C",
      inherits: "fdm_process_root",
      wall_loops: "3",
    }),
  );

  // The route reads this per request, so setting it after the app was
  // configured is enough — no restart needed.
  process.env.BUNDLED_PROFILES_PATH = scratchRoot;
});

afterAll(async () => {
  if (originalBundledPath === undefined) {
    delete process.env.BUNDLED_PROFILES_PATH;
  } else {
    process.env.BUNDLED_PROFILES_PATH = originalBundledPath;
  }
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

describe("POST /profiles/resolve", () => {
  it("flattens an inherits-only stub into the values it resolves to", async () => {
    // This is the shape a system-tier pick arrives as: a name and nothing
    // else. Every value has to come from the bundled tree.
    const res = await request
      .post("/profiles/resolve")
      .send({
        category: "process",
        profile: { inherits: "0.20mm Standard @BBL X1C" },
      })
      .expect(200);

    expect(res.body.profile.line_width).toBe("0.42");
    expect(res.body.profile.layer_height).toBe("0.20");
  });

  it("walks the whole chain, not just the first parent", async () => {
    const res = await request
      .post("/profiles/resolve")
      .send({
        category: "process",
        profile: { inherits: "0.20mm Standard @BBL X1C" },
      })
      .expect(200);

    // wall_loops is overridden by the middle profile; line_width only exists
    // on the root, so seeing both proves the walk didn't stop early.
    expect(res.body.profile.wall_loops).toBe("3");
    expect(res.body.profile.line_width).toBe("0.42");
    expect(res.body.profile.inherits).toBeUndefined();
  });

  it("lets the caller's own values win over the inherited ones", async () => {
    // A user's delta: their edits must survive the merge.
    const res = await request
      .post("/profiles/resolve")
      .send({
        category: "process",
        profile: { inherits: "0.20mm Standard @BBL X1C", wall_loops: "5" },
      })
      .expect(200);

    expect(res.body.profile.wall_loops).toBe("5");
    expect(res.body.profile.line_width).toBe("0.42");
  });

  it("returns an already-flat profile unchanged", async () => {
    const flat = { type: "process", name: "flat", line_width: "0.45" };
    const res = await request
      .post("/profiles/resolve")
      .send({ category: "process", profile: flat })
      .expect(200);

    expect(res.body.profile).toMatchObject(flat);
  });

  it("drops an inherits that names no bundled file rather than failing", async () => {
    // Matches the resolver's existing behaviour for stale inherits values;
    // a preset referencing a profile this image doesn't ship should still
    // yield whatever the caller supplied.
    const res = await request
      .post("/profiles/resolve")
      .send({
        category: "process",
        profile: { inherits: "no_such_parent", wall_loops: "4" },
      })
      .expect(200);

    expect(res.body.profile.wall_loops).toBe("4");
    expect(res.body.profile.inherits).toBeUndefined();
  });

  it("rejects the storage category names", async () => {
    // The CRUD routes on this router use printers / presets / filaments; the
    // resolver keys off the bundled-profile directory names. Reusing the
    // wrong validator here would reject every valid call, so pin the
    // distinction.
    await request
      .post("/profiles/resolve")
      .send({ category: "presets", profile: { inherits: "x" } })
      .expect(400);
  });

  it.each(["machine", "process", "filament"])(
    "accepts the %s category",
    async (category) => {
      await request
        .post("/profiles/resolve")
        .send({ category, profile: { name: "flat" } })
        .expect(200);
    },
  );

  it("rejects a missing category", async () => {
    await request
      .post("/profiles/resolve")
      .send({ profile: { inherits: "x" } })
      .expect(400);
  });

  it.each([
    ["a missing profile", { category: "process" }],
    ["a null profile", { category: "process", profile: null }],
    ["a string profile", { category: "process", profile: "nope" }],
    ["an array profile", { category: "process", profile: [] }],
  ])("rejects %s", async (_label, body) => {
    await request.post("/profiles/resolve").send(body).expect(400);
  });

  it("explains itself when no bundled profile tree is configured", async () => {
    // Both vars have to go. `getDefaultBundledProfilesPath` falls back to
    // deriving the tree from ORCASLICER_PATH, so clearing only
    // BUNDLED_PROFILES_PATH left the resolver working on any machine that
    // actually has a slicer -- the test passed on a bare dev box and failed
    // in the very images it is meant to cover.
    const savedBundled = process.env.BUNDLED_PROFILES_PATH;
    const savedSlicer = process.env.ORCASLICER_PATH;
    delete process.env.BUNDLED_PROFILES_PATH;
    delete process.env.ORCASLICER_PATH;
    try {
      const res = await request
        .post("/profiles/resolve")
        .send({ category: "process", profile: { inherits: "x" } })
        .expect(500);
      // The message has to name the env vars — this is the failure an
      // operator hits on a misconfigured image, and "500" alone is useless.
      expect(res.body.details).toMatch(/BUNDLED_PROFILES_PATH|ORCASLICER_PATH/);
    } finally {
      if (savedBundled === undefined) delete process.env.BUNDLED_PROFILES_PATH;
      else process.env.BUNDLED_PROFILES_PATH = savedBundled;
      if (savedSlicer === undefined) delete process.env.ORCASLICER_PATH;
      else process.env.ORCASLICER_PATH = savedSlicer;
    }
  });

  it("is not shadowed by the /:category route", async () => {
    // "/resolve" would otherwise be read as a category name by the generic
    // GET/POST handlers registered after it.
    const res = await request
      .post("/profiles/resolve")
      .send({ category: "process", profile: { name: "flat" } })
      .expect(200);
    expect(res.body).toHaveProperty("profile");
  });
});
