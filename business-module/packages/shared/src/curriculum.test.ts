import { describe, expect, it } from "vitest";
import { resolveVersion, versionRanges } from "./curriculum";

const v = (id: string, effectiveYear: number) => ({ id, effectiveYear });

describe("curriculum versions", () => {
  const versions = [v("c", 2026), v("a", 2000), v("b", 2024)];
  it("picks the latest version that started on or before the entry year", () => {
    expect(resolveVersion(versions, 2025)?.id).toBe("b");
    expect(resolveVersion(versions, 2024)?.id).toBe("b");
    expect(resolveVersion(versions, 2026)?.id).toBe("c");
    expect(resolveVersion(versions, 2031)?.id).toBe("c");
  });
  it("uses the earliest version for earlier entry years, and null when there are none", () => {
    expect(resolveVersion(versions, 1990)?.id).toBe("a");
    expect(resolveVersion([], 2024)).toBeNull();
  });
  it("versionRanges covers every year without gaps", () => {
    expect(versionRanges(versions).map((r) => [r.id, r.from, r.to])).toEqual([["a", null, 2023], ["b", 2024, 2025], ["c", 2026, null]]);
  });
});
