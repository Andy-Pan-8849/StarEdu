import { describe, expect, it } from "vitest";
import { buildOrgTree, childDepts, orderTop, ROOT_ID, type CampusRow, type DeptRow } from "../src/components/admin/org-tree";

const d = (id: string, name: string, parentId: string | null, createdAt: string, sort = 0): DeptRow => ({ id, name, parentId, sort, status: true, ancestors: [], createdAt });
const campus = (id: string, deptId: string, type: "hq" | "campus", createdAt: string): CampusRow => ({ id, deptId, name: id, type, createdAt });

describe("organization tree", () => {
  const depts = [
    d("wuhan", "Wuhan", null, "2026-03-01"),
    d("hq", "Beijing HQ", null, "2026-01-01"),
    d("shenzhen", "Shenzhen", null, "2026-02-01"),
    d("hr", "HR", "hq", "2026-01-02", 2),
    d("fin", "Finance", "hq", "2026-01-03", 1),
  ];
  const campuses = [campus("c-wuhan", "wuhan", "campus", "2026-03-01"), campus("c-hq", "hq", "hq", "2026-01-01"), campus("c-sz", "shenzhen", "campus", "2026-02-01")];

  it("puts the headquarters first and the branch campuses after it in the order they were set up", () => {
    expect(orderTop(depts, campuses).map((x) => x.name)).toEqual(["Beijing HQ", "Shenzhen", "Wuhan"]);
  });

  it("has the company as a virtual root above the campuses, and departments under their campus ordered by sort", () => {
    const tree = buildOrgTree(depts, campuses, "StarIT");
    expect(tree.id).toBe(ROOT_ID);
    expect(tree.label).toBe("StarIT");
    expect(tree.children.map((c) => `${c.kind}:${c.label}`)).toEqual(["hq:Beijing HQ", "campus:Shenzhen", "campus:Wuhan"]);
    expect(tree.children[0]!.children.map((c) => `${c.kind}:${c.label}`)).toEqual(["dept:Finance", "dept:HR"]);
  });

  it("lists the direct children of a department", () => {
    expect(childDepts("hq", depts).map((x) => x.name)).toEqual(["Finance", "HR"]);
  });

  it("still works without campus information (top-level departments by creation time)", () => {
    expect(orderTop(depts, []).map((x) => x.name)).toEqual(["Beijing HQ", "Shenzhen", "Wuhan"]);
  });
});
