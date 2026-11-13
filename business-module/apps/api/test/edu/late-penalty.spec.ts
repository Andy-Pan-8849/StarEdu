// 迟交扣分与截止时间：纯函数测试（不连任何服务）。黄金测试用 AI 样本里的 198 条提交重算，必须与样本完全一致。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { endOfLocalDay } from "../../src/edu/deadline";
import { applyPenalty, DEFAULT_LATE_POLICY, hoursLate, latePolicySchema, penaltyPct } from "../../src/edu/late-penalty";

const SAMPLE = resolve(__dirname, "../../../../../ai-module/sample-data/structured");
const csv = (name: string) => {
  const [head, ...lines] = readFileSync(resolve(SAMPLE, name), "utf8").trim().split(/\r?\n/);
  const keys = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v]))) as Array<Record<string, string>>;
};

describe("late penalty table", () => {
  it("applies the default tiers at and around their edges", () => {
    const pct = (h: number) => penaltyPct(DEFAULT_LATE_POLICY, h);
    expect([pct(0), pct(-3), pct(0.01), pct(24), pct(24.01), pct(48), pct(48.5), pct(72), pct(72.01), pct(500)]).toEqual([0, 0, 10, 10, 20, 20, 30, 30, 100, 100]);
  });

  it("takes the score down by the percentage, whole points, half to even; no penalty keeps the raw score as entered", () => {
    expect(applyPenalty("85.5", 0).toString()).toBe("85.5");
    expect(applyPenalty(75, 30).toString()).toBe("52"); // 52.5 → 52（五成双）
    expect(applyPenalty(85, 30).toString()).toBe("60"); // 59.5 → 60
    expect(applyPenalty(94, 30).toString()).toBe("66"); // 65.8
    expect(applyPenalty(80, 100).toString()).toBe("0");
  });

  it("measures lateness in continuous hours", () => {
    const due = new Date("2026-04-03T23:59:59.999Z");
    expect(hoursLate(due, new Date("2026-04-03T23:59:30Z"))).toBe(0);
    expect(hoursLate(due, new Date("2026-04-04T01:59:59.999Z"))).toBeCloseTo(2, 6);
  });

  it("validates a custom table: increasing hours, penalties that never go down", () => {
    expect(latePolicySchema.safeParse(DEFAULT_LATE_POLICY).success).toBe(true);
    expect(latePolicySchema.safeParse({ tiers: [{ upToHours: 48, pct: 10 }, { upToHours: 24, pct: 20 }], beyondPct: 100 }).success).toBe(false);
    expect(latePolicySchema.safeParse({ tiers: [{ upToHours: 24, pct: 30 }, { upToHours: 48, pct: 20 }], beyondPct: 100 }).success).toBe(false);
    expect(latePolicySchema.safeParse({ tiers: [], beyondPct: 0 }).success).toBe(true);
  });
});

describe("deadline: 23:59 on the due date in the campus time zone", () => {
  it("converts the end of a local day to the right instant", () => {
    expect(endOfLocalDay("2026-04-03", "UTC").toISOString()).toBe("2026-04-03T23:59:59.999Z");
    expect(endOfLocalDay("2026-04-03", "Asia/Shanghai").toISOString()).toBe("2026-04-03T15:59:59.999Z");
    expect(endOfLocalDay("2026-04-03", "Asia/Kolkata").toISOString()).toBe("2026-04-03T18:29:59.999Z");
  });

  it("follows daylight saving: New York is UTC-5 in winter, UTC-4 in summer, and the switch days are right", () => {
    expect(endOfLocalDay("2026-01-15", "America/New_York").toISOString()).toBe("2026-01-16T04:59:59.999Z");
    expect(endOfLocalDay("2026-07-15", "America/New_York").toISOString()).toBe("2026-07-16T03:59:59.999Z");
    expect(endOfLocalDay("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-09T03:59:59.999Z"); // 春季切换日，当晚已是 UTC-4
    expect(endOfLocalDay("2026-11-01", "America/New_York").toISOString()).toBe("2026-11-02T04:59:59.999Z"); // 秋季切换日，当晚已是 UTC-5
  });

  it("rejects a malformed date", () => {
    expect(() => endOfLocalDay("2026-4-3", "UTC")).toThrow();
  });
});

describe("golden test: the sample's 198 submissions", () => {
  const assignments = new Map(csv("assignments.csv").map((a) => [a.assignment_id, a.due_date]));
  const rows = csv("submissions.csv");

  it("has the expected size", () => {
    expect(rows).toHaveLength(198);
  });

  it("recomputes penalty and final score from raw_score and hours_late exactly as the sample has them", () => {
    const wrong = rows.filter((r) => {
      const pct = penaltyPct(DEFAULT_LATE_POLICY, Number(r.hours_late));
      return pct !== Number(r.late_penalty_pct) || !applyPenalty(r.raw_score, pct).equals(r.final_score);
    });
    expect(wrong.map((r) => r.submission_id)).toEqual([]);
  });

  it("derives the same hours from the submit time and the due date (sample times are campus wall-clock)", () => {
    const wrong = rows.filter((r) => {
      const deadline = endOfLocalDay(assignments.get(r.assignment_id)!, "UTC");
      const hours = Math.ceil(hoursLate(deadline, new Date(r.submitted_at.replace(" ", "T") + "Z")));
      const pct = penaltyPct(DEFAULT_LATE_POLICY, hoursLate(deadline, new Date(r.submitted_at.replace(" ", "T") + "Z")));
      return hours !== Number(r.hours_late) || pct !== Number(r.late_penalty_pct);
    });
    expect(wrong.map((r) => r.submission_id)).toEqual([]);
  });
});
