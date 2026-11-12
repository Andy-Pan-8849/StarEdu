import { EMPTY_SCOPE, MATCH_NOTHING, scopeWhere, unionScopes, withScope, type ResolvedScope } from "./scope-filter";

const mapping = {
  dept: (ids: string[]) => ({ deptId: { in: ids } }),
  self: (id: string) => ({ personId: id }),
  classes: (ids: string[]) => ({ classId: { in: ids } }),
  staffBasic: { type: "staff" },
};
const scope = (p: Partial<ResolvedScope>): ResolvedScope => ({ ...EMPTY_SCOPE, ...p });

describe("scopeWhere", () => {
  it("adds no condition for the all scope", () => {
    expect(scopeWhere(scope({ all: true }), mapping)).toBeNull();
  });
  it("the match-nothing condition is not an empty OR (Prisma ignores an empty OR nested inside AND, which would show every row)", () => {
    expect(JSON.stringify(MATCH_NOTHING)).not.toContain('"OR":[]');
    expect(MATCH_NOTHING).toEqual({ id: { in: [] } });
  });
  it("matches nothing when no set applies", () => {
    expect(scopeWhere(EMPTY_SCOPE, mapping)).toEqual(MATCH_NOTHING);
  });
  it("one clause per applicable dimension, combined with OR", () => {
    const w = scopeWhere(scope({ deptIds: ["d1"], selfPersonId: "p1", classIds: ["c1"], staffBasic: true }), mapping);
    expect(w).toEqual({ OR: [{ deptId: { in: ["d1"] } }, { personId: "p1" }, { classId: { in: ["c1"] } }, { type: "staff" }] });
  });
  it("ignores dimensions the table does not know (so a class-only scope sees nothing on a dept table)", () => {
    expect(scopeWhere(scope({ classIds: ["c1"] }), { dept: mapping.dept })).toEqual(MATCH_NOTHING);
    expect(scopeWhere(scope({ deptIds: ["d1"], classIds: ["c1"] }), { dept: mapping.dept })).toEqual({ OR: [{ deptId: { in: ["d1"] } }] });
  });
  it("an empty dept list is not a dept clause", () => {
    expect(scopeWhere(scope({ deptIds: [] }), mapping)).toEqual(MATCH_NOTHING);
  });
});

describe("withScope", () => {
  it("keeps the original where when unrestricted", () => {
    expect(withScope({ a: 1 }, scope({ all: true }), mapping)).toEqual({ a: 1 });
    expect(withScope(undefined, scope({ all: true }), mapping)).toEqual({});
  });
  it("ANDs the original where with the scope", () => {
    expect(withScope({ a: 1 }, scope({ selfPersonId: "p" }), mapping)).toEqual({ AND: [{ a: 1 }, { OR: [{ personId: "p" }] }] });
  });
});

describe("unionScopes", () => {
  it("unions ids and flags", () => {
    const u = unionScopes([scope({ deptIds: ["b", "a"] }), scope({ deptIds: ["a", "c"], selfPersonId: "p" }), scope({ staffBasic: true })]);
    expect(u).toEqual({ all: false, deptIds: ["a", "b", "c"], selfPersonId: "p", classIds: [], staffBasic: true });
  });
  it("all wins, and an empty list is the empty scope", () => {
    expect(unionScopes([scope({ all: true }), scope({})]).all).toBe(true);
    expect(unionScopes([])).toEqual(EMPTY_SCOPE);
  });
});
