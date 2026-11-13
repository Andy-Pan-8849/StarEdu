import { describe, expect, it } from "vitest";
import { parseRubric } from "../src/components/admin/pages/assignment-pages";

describe("parseRubric", () => {
  it("reads one item per line as 'title: points'", () => {
    expect(parseRubric("Correctness: 6\n  Style: 4  \n\n")).toEqual([
      { title: "Correctness", maxPoints: 6 },
      { title: "Style", maxPoints: 4 },
    ]);
  });
  it("keeps colons inside the title and marks a missing number as NaN so the server rejects it", () => {
    expect(parseRubric("Part 1: parsing: 2.5")).toEqual([{ title: "Part 1: parsing", maxPoints: 2.5 }]);
    expect(Number.isNaN(parseRubric("No points")[0].maxPoints)).toBe(true);
  });
});
