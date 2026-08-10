import { configureApp } from "../../src/index";
import { beforeAll, afterAll } from "vitest";
import supertest, { Test } from "supertest";
import { Server } from "http";
import type TestAgent from "supertest/lib/agent";
import { loadEnvFile } from "process";

try {
  loadEnvFile();
} catch {
  // Expected everywhere the config comes from the environment instead of a
  // file -- CI, Docker, `./test_e2e.sh`. It was warning once per test file,
  // which is a dozen lines of nothing on every green run.
}

const app = configureApp();

let server: Server;
let request: TestAgent<Test>;

beforeAll(async () => {
  server = app.listen(0);
  request = supertest(app);
});

afterAll(async () => {
  server.close();
});

export { request };
