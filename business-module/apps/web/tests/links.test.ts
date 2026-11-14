import { describe, expect, it } from "vitest";
import { linkFor } from "../src/components/admin/menu-tree-shell";

describe("linkFor", () => {
  it("puts the company's code into the AI assistant address", () => {
    expect(linkFor("http://{code}.localhost:3000/", "hq.localhost")).toBe("http://hq.localhost:3000/");
    expect(linkFor("http://{code}.localhost:3000/", "riverside-franchise.example.com")).toBe("http://riverside-franchise.localhost:3000/");
  });
  it("leaves ordinary links and empty ones alone", () => {
    expect(linkFor("https://example.test/help", "hq.localhost")).toBe("https://example.test/help");
    expect(linkFor(null, "hq.localhost")).toBe("#");
  });
});
