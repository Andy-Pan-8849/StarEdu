import { describe, expect, it } from "vitest";
import { parseScale } from "../src/components/admin/pages/grade-pages";

describe("parseScale", () => {
  it("reads 'name, minimum %, points, pass' per line", () => {
    expect(parseScale("A, 90, 4.0, y\n F ,0, 0, n \n")).toEqual([
      { grade: "A", minPercent: 90, points: 4, passing: true },
      { grade: "F", minPercent: 0, points: 0, passing: false },
    ]);
  });
});
