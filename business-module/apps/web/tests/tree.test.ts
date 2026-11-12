import { describe, expect, it } from "vitest";
import { descendantIds, stateOf, submitIds, toggle, type TreeNode } from "../src/components/admin/tree";
import { closeTab, emptyTabs, openTab } from "../src/components/admin/tabs-state";

const tree: TreeNode[] = [
  { id: "sys", label: "System", children: [
    { id: "role", label: "Roles", children: [{ id: "role:add", label: "Add" }, { id: "role:del", label: "Delete" }] },
    { id: "menu", label: "Menus" },
  ] },
  { id: "hr", label: "HR" },
];

describe("tree check state", () => {
  it("is derived from the leaves: all, some or none", () => {
    expect(stateOf(tree[0], new Set())).toBe("unchecked");
    expect(stateOf(tree[0], new Set(["role:add"]))).toBe("half");
    expect(stateOf(tree[0].children![0], new Set(["role:add", "role:del"]))).toBe("checked");
    expect(stateOf(tree[0], new Set(["role:add", "role:del", "menu"]))).toBe("checked");
  });

  it("lists descendants", () => {
    expect(descendantIds(tree[0])).toEqual(["role", "role:add", "role:del", "menu"]);
  });

  it("cascade: ticking a parent ticks everything below it; ticking again clears it", () => {
    const on = toggle(tree, new Set(), "role", true);
    expect([...on].sort()).toEqual(["role", "role:add", "role:del"]);
    expect([...toggle(tree, on, "role", true)]).toEqual([]);
  });

  it("cascade: a half-checked parent becomes fully checked on click", () => {
    const next = toggle(tree, new Set(["role:add"]), "role", true);
    expect(stateOf(tree[0].children![0], next)).toBe("checked");
  });

  it("independent mode only touches the clicked node", () => {
    expect([...toggle(tree, new Set(), "sys", false)]).toEqual(["sys"]);
  });

  it("the ids to submit are the ticked ones plus half-checked ancestors, never untouched branches", () => {
    expect(submitIds(tree, new Set(["role:add"])).sort()).toEqual(["role", "role:add", "sys"]);
    expect(submitIds(tree, new Set())).toEqual([]);
  });

  it("ignores unknown ids", () => {
    expect([...toggle(tree, new Set(["hr"]), "nope", true)]).toEqual(["hr"]);
  });
});

describe("tabs state", () => {
  it("opening an open tab just activates it", () => {
    let s = openTab(emptyTabs, { id: "a", title: "A" });
    s = openTab(s, { id: "b", title: "B" });
    s = openTab(s, { id: "a", title: "A" });
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(s.activeId).toBe("a");
  });

  it("closing the active tab activates the right neighbour, then the left, then none", () => {
    let s = emptyTabs;
    for (const id of ["a", "b", "c"]) s = openTab(s, { id, title: id });
    s = { ...s, activeId: "b" };
    s = closeTab(s, "b");
    expect(s.activeId).toBe("c");
    s = closeTab(s, "c");
    expect(s.activeId).toBe("a");
    s = closeTab(s, "a");
    expect(s).toEqual(emptyTabs);
  });

  it("closing an inactive tab keeps the active one; closing an unknown tab changes nothing", () => {
    let s = emptyTabs;
    for (const id of ["a", "b"]) s = openTab(s, { id, title: id });
    expect(closeTab(s, "a").activeId).toBe("b");
    expect(closeTab(s, "zzz")).toBe(s);
  });
});
