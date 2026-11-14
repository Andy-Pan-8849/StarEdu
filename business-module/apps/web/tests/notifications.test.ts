import { describe, expect, it } from "vitest";
import { wsUrl } from "../src/components/admin/notification-bell";

describe("wsUrl", () => {
  it("uses the API port in development and the page's own host behind a proxy; wss on https", () => {
    expect(wsUrl({ protocol: "http:", hostname: "hq.localhost", host: "hq.localhost:3001" }, "4000", "abc")).toBe("ws://hq.localhost:4000/ws?ticket=abc");
    expect(wsUrl({ protocol: "https:", hostname: "hq.example.com", host: "hq.example.com" }, "", "abc")).toBe("wss://hq.example.com/ws?ticket=abc");
  });
});
