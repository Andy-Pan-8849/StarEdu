import { describe, expect, it } from "vitest";
import { flatten, nest } from "../src/components/admin/pages/library-pages";

const f = (id: string, parentId: string | null, name: string) => ({ id, parentId, name, classification: "internal" as const, level: "view" as const, inheritAcl: true, previewOnly: false, logAccess: false, files: 0 });

describe("library folder tree", () => {
  it("orders children under their parent with depth", () => {
    const rows = flatten([f("c", "b", "C"), f("a", null, "A"), f("b", "a", "B"), f("z", null, "Z")]);
    expect(rows.map((r) => `${r.depth}:${r.name}`)).toEqual(["0:A", "1:B", "2:C", "0:Z"]);
  });
  it("treats a folder whose parent is not visible as top level", () => {
    expect(flatten([f("b", null, "B")]).map((r) => r.depth)).toEqual([0]);
  });
  it("nests folders into a tree for the navigation panel", () => {
    const tree = nest([f("c", "b", "C"), f("a", null, "A"), f("b", "a", "B")]);
    expect(tree.map((n) => n.label)).toEqual(["A"]);
    expect(tree[0]!.children[0]!.children[0]!.label).toBe("C");
  });
});
