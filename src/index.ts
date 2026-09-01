import express from "express";
import swaggerUi from "swagger-ui-express";
import { errorHandler } from "./middleware/error";
import health from "./routes/health/route";
import profiles from "./routes/profiles/route";
import asyncSlicing from "./routes/slicing/async.route";
import slicing from "./routes/slicing/route";
import cors from "cors";
import { recoverStaleSliceWorkspaces } from "./routes/slicing/temp-workspaces";

export const configureApp = () => {
  const app = express();

  app.use(
    cors({
      origin: process.env.CORS_ORIGINS ?? "*", // if not set, allow all origins
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      exposedHeaders: [
        "Content-Disposition",
        "ETag",
        "Last-Modified",
        "Content-Length",
        "X-Filament-Used-G",
        "X-Filament-Used-Mm",
        "X-Print-Time-Seconds",
      ],
    })
  );

  app.use(express.json());

  app.use("/health", health);
  app.use("/profiles", profiles);
  app.use("/slice", slicing);
  app.use("/slice-async", asyncSlicing);

  app.use(errorHandler);

  return app;
};

const app = configureApp();

const port = process.env.PORT || 3000;

if (process.env.NODE_ENV !== "production") {
  import("../swagger.json", { with: { type: "json" } })
    .then((swaggerDocument) => {
      app.use(
        "/api-docs",
        swaggerUi.serve,
        swaggerUi.setup(swaggerDocument.default)
      );
    })
    .catch((err) => {
      console.error("Failed to load swagger.json:", err);
    });
}

// Importing this module must not bind a port under test. The e2e setup calls
// `configureApp()` and does its own `listen(0)`, and the unit tests re-import
// through `vi.resetModules()` -- so the module-level listen raced its own
// earlier instances for port 3000 and printed "App listening" once per import.
if (process.env.NODE_ENV !== "test") {
  void recoverStaleSliceWorkspaces()
    .then(() => {
      app.listen(port, () => {
        console.log(`App listening on port ${port}`);
      });
    })
    .catch((error) => {
      console.error("Failed to recover stale slicer workspaces before startup:", error);
      process.exitCode = 1;
    });
}
