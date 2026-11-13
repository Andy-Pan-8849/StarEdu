// 成绩计算：纯函数测试。
import { computeGpa, DEFAULT_SCALE, finalTotal, gradeFor, policyProblems, scaleProblems, type GpaRow } from "../../src/edu/grade-calc";

describe("grading scale", () => {
  it("the default scale is valid and maps totals to grades at the edges", () => {
    expect(scaleProblems(DEFAULT_SCALE)).toEqual([]);
    const g = (t: number) => gradeFor(DEFAULT_SCALE, t).grade;
    expect([g(100), g(90), g(89.9), g(80), g(70), g(60), g(59.9), g(0)]).toEqual(["A", "A", "B", "B", "C", "D", "F", "F"]);
    expect(gradeFor(DEFAULT_SCALE, 60).passing).toBe(true);
    expect(gradeFor(DEFAULT_SCALE, 59.9).passing).toBe(false);
  });

  it("accepts a tenant's own scale (A+ and A-) and rejects broken ones", () => {
    const custom = [
      { grade: "A+", minPercent: 97, points: 4, passing: true }, { grade: "A", minPercent: 93, points: 4, passing: true }, { grade: "A-", minPercent: 90, points: 3.7, passing: true },
      { grade: "B", minPercent: 80, points: 3, passing: true }, { grade: "C", minPercent: 70, points: 2, passing: true }, { grade: "F", minPercent: 0, points: 0, passing: false },
    ];
    expect(scaleProblems(custom)).toEqual([]);
    expect(gradeFor(custom, 95).grade).toBe("A");
    expect(scaleProblems(custom.slice(0, 5))).toContain("The lowest grade must start at 0%");
    expect(scaleProblems([...custom, { grade: "A", minPercent: 50, points: 0, passing: false }])).toContain("Grade names must be different");
    expect(scaleProblems(custom.map((c) => (c.grade === "B" ? { ...c, passing: false } : c)))).toContain("Passing grades must be the top grades (one pass line)");
    expect(scaleProblems(custom.map((c) => (c.grade === "C" ? { ...c, points: 3.5 } : c)))).toContain("Grade points must not rise as the percentage falls");
  });
});

describe("final total", () => {
  const groups = [
    { name: "Homework", weight: 40, items: [{ earned: 8, max: 10 }, { earned: 9, max: 10 }] },
    { name: "Midterm", weight: 20, items: [{ earned: 70, max: 100 }] },
    { name: "Final", weight: 30, items: [{ earned: 85, max: 100 }] },
    { name: "Participation", weight: 10, items: [{ earned: 10, max: 10 }] },
  ];
  it("weights each group's rate: 0.85×40 + 0.7×20 + 0.85×30 + 1×10 = 83.5", () => {
    expect(policyProblems(groups)).toEqual([]);
    expect(finalTotal(groups).toString()).toBe("83.5");
  });
  it("counts a missing submission as zero, uses exact decimals and rounds to one decimal (half up)", () => {
    expect(finalTotal([{ name: "HW", weight: 100, items: [{ earned: 0, max: 10 }, { earned: 10, max: 10 }] }]).toString()).toBe("50");
    expect(finalTotal([{ name: "HW", weight: 100, items: [{ earned: 1, max: 3 }] }]).toString()).toBe("33.3");
    expect(finalTotal([{ name: "HW", weight: 100, items: [{ earned: 0.1, max: 0.3 }, { earned: 0.2, max: 0.3 }] }]).toString()).toBe("50");
    expect(finalTotal([{ name: "HW", weight: 100, items: [{ earned: 8.05, max: 10 }] }]).toString()).toBe("80.5");
    expect(finalTotal([{ name: "HW", weight: 100, items: [{ earned: 8.0449, max: 10 }] }]).toString()).toBe("80.4");
  });
  it("flags weights that do not add up to 100 and weighted groups with nothing in them", () => {
    expect(policyProblems([{ name: "A", weight: 60, items: [{ earned: 1, max: 1 }] }])).toEqual(["Weights add up to 60%, not 100%"]);
    expect(policyProblems([{ name: "A", weight: 50, items: [{ earned: 1, max: 1 }] }, { name: "B", weight: 50, items: [] }])).toEqual(['Group "B" has a weight but no scored assignment']);
    expect(policyProblems([{ name: "A", weight: 33.33, items: [{ earned: 1, max: 1 }] }, { name: "B", weight: 33.33, items: [{ earned: 1, max: 1 }] }, { name: "C", weight: 33.34, items: [{ earned: 1, max: 1 }] }])).toEqual([]);
  });
});

describe("GPA", () => {
  const row = (id: string, course: string, term: string, start: string, credits: number, points: number, passed = points > 0): GpaRow => ({ enrollmentId: id, courseId: course, termId: term, termStart: new Date(start), enrolledAt: new Date(start), credits, points, passed });
  it("is Σ(points × credits) ÷ Σ credits, by term and cumulative; failed credits count as attempted, not earned", () => {
    const r = computeGpa([row("a", "c1", "t1", "2026-01-01", 3, 4), row("b", "c2", "t1", "2026-01-01", 4, 3), row("c", "c3", "t2", "2026-06-01", 2, 0)]);
    expect(r.byTerm.t1).toEqual({ gpa: 3.43, attempted: 7, earned: 7 });
    expect(r.byTerm.t2).toEqual({ gpa: 0, attempted: 2, earned: 0 });
    expect(r.cumulative).toEqual({ gpa: 2.67, attempted: 9, earned: 7 });
  });
  it("retake: the latest result replaces the old one, credits count once, the old record is marked", () => {
    const r = computeGpa([row("old", "c1", "t1", "2026-01-01", 3, 0), row("new", "c1", "t2", "2026-06-01", 3, 3), row("other", "c2", "t1", "2026-01-01", 3, 4)]);
    expect(r.replaced).toEqual(["old"]);
    expect(r.counted.sort()).toEqual(["new", "other"]);
    expect(r.cumulative).toEqual({ gpa: 3.5, attempted: 6, earned: 6 });
    expect(r.byTerm.t1.attempted).toBe(3); // 旧学期只剩没被替代的那一门
  });
  it("a later retake that is worse still replaces the earlier one", () => {
    expect(computeGpa([row("good", "c1", "t1", "2026-01-01", 3, 4), row("bad", "c1", "t2", "2026-06-01", 3, 1)]).cumulative.gpa).toBe(1);
  });
  it("has no GPA when nothing counts", () => {
    expect(computeGpa([]).cumulative).toEqual({ gpa: null, attempted: 0, earned: 0 });
  });
});
