import { loadConfig } from "./config";

describe("loadConfig", () => {
  const ok = { DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x" };

  it("applies the default port", () => {
    expect(loadConfig(ok).API_PORT).toBe(4000);
  });

  it("reads the port from the environment", () => {
    expect(loadConfig({ ...ok, API_PORT: "4100" }).API_PORT).toBe(4100);
  });

  it("fails fast with a readable message when something is missing", () => {
    expect(() => loadConfig({ REDIS_URL: "redis://x" })).toThrow(/DATABASE_URL/);
  });
});
