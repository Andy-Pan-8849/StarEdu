// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { PermissionProvider } from "../src/components/admin/permissions";

const detail = {
  id: "s1", name: "Java Programming (DEMO 01)", course: { code: "JAVA101", name: "Java Programming", credits: 3, syllabus: "Learn the language from scratch." },
  term: { name: "Current term", startDate: "2026-09-01", endDate: "2027-01-15" }, campus: "Beijing Headquarter", mode: "onsite",
  schedule: [{ weekday: 2, start: "10:00", end: "11:30", room: "A-201" }], notes: null, capacity: 20, seatsLeft: 1,
  instructors: [{ role: "lead", fullName: "Taylor Demo (teacher)" }], prerequisites: [{ code: "CS100", name: "Intro", met: false }], requirement: "required", myEnrollment: null,
};
const mine = vi.hoisted(() => ({ on: false }));
const enrollments = [{ id: "e1", status: "enrolled", course: { code: "JAVA101", name: "Java Programming" }, term: "Current term", canDrop: true, willBeW: false, section: { id: "s1", name: "Java Programming (DEMO 01)" } }];
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string) => {
    if (path === "sections/s1") return mine.on ? { ...detail, myEnrollment: { id: "e1", status: "enrolled" } } : detail;
    if (path === "my-enrollments") return enrollments;
    if (path === "sections/s1/materials") return [{ id: "m1", title: "Week 1 slides", description: "Read chapter 1", url: null, category: "", published: true, files: [{ id: "f1", fileName: "week1.pdf", size: 2048, downloadUrl: "https://files.test/week1.pdf" }] }];
    if (path === "assignments/a1") return { id: "a1", title: "Homework 1", description: "Write a loop.", section: { name: "x" }, deadline: "2027-01-01T00:00:00Z", allowLate: false, maxScore: 100, canSubmit: false, limits: { maxFiles: 3 }, rubric: [{ id: "r1", title: "Correctness", maxPoints: 100 }], submission: null };
    if (path === "assignments") return [
      { id: "a1", title: "Homework 1", section: { id: "s1", name: "x", course: "Java" }, deadline: "2027-01-01T00:00:00Z", extensionDays: 0, status: "missing", isLate: false, finalScore: null, maxScore: 100 },
      { id: "a2", title: "Other class homework", section: { id: "s2", name: "y", course: "Other" }, deadline: "2027-01-01T00:00:00Z", extensionDays: 0, status: "missing", isLate: false, finalScore: null, maxScore: 100 },
    ];
    return [];
  }),
}));

import { CourseDetailDialog, PortalCoursesPage } from "../src/components/admin/pages/course-pages";

const wrap = (ui: React.ReactElement) => (
  <NextIntlClientProvider locale="en" messages={en}>
    <PermissionProvider permissions={["portal:enroll:add", "portal:enroll:drop"]}>{ui}</PermissionProvider>
  </NextIntlClientProvider>
);

describe("course details for students", () => {
  it("shows what a student needs to decide: description, schedule, teachers, seats, prerequisites; and enrolls from the dialog", async () => {
    const onEnroll = vi.fn();
    render(wrap(<CourseDetailDialog sectionId="s1" onClose={() => undefined} onEnroll={onEnroll} />));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Learn the language from scratch.")).toBeTruthy();
    expect(dialog.getByText(/Tue 10:00–11:30 · A-201/)).toBeTruthy();
    expect(dialog.getByText("1 left of 20")).toBeTruthy();
    expect(dialog.getByText(/CS100 · Intro/).textContent).toContain("not passed yet");
    // 没选上这个班：只有基本信息和任课教师两个页签
    expect(dialog.queryByRole("tab", { name: "Materials" })).toBeNull();
    await userEvent.setup().click(dialog.getByRole("tab", { name: "Instructors" }));
    expect(dialog.getByText(/Taylor Demo \(teacher\)/)).toBeTruthy();
    await userEvent.setup().click(dialog.getByRole("tab", { name: "Base information" }));
    await userEvent.setup().click(dialog.getByRole("button", { name: "Enroll" }));
    expect(onEnroll).toHaveBeenCalledWith("s1");
  });

  it("My courses lists enrolled courses; clicking a course name opens its details", async () => {
    render(wrap(<PortalCoursesPage />));
    const link = await screen.findByRole("button", { name: "JAVA101 · Java Programming" });
    await userEvent.setup().click(link);
    const dialog = within(await screen.findByRole("dialog"));
    await waitFor(() => expect(dialog.getByText("Learn the language from scratch.")).toBeTruthy());
    expect(dialog.queryByRole("button", { name: "Enroll" })).toBeNull(); // 这里是看已选的课，不再提供选课
  });
  it("for an enrolled class the dialog has four tabs: base information, instructors, materials and assignments of this class", async () => {
    mine.on = true;
    render(wrap(<CourseDetailDialog sectionId="s1" onClose={() => undefined} />));
    const dialog = within(await screen.findByRole("dialog"));
    const u = userEvent.setup();
    expect((await dialog.findAllByRole("tab")).map((x) => x.textContent)).toEqual(["Base information", "Instructors", "Materials", "Assignments"]);
    await u.click(dialog.getByRole("tab", { name: "Materials" }));
    expect(await dialog.findByText("Week 1 slides")).toBeTruthy();
    expect(dialog.getByRole("link", { name: "week1.pdf" }).getAttribute("href")).toBe("https://files.test/week1.pdf");
    await u.click(dialog.getByRole("tab", { name: "Assignments" }));
    expect(await dialog.findByText("Homework 1")).toBeTruthy();
    expect(dialog.queryByText("Other class homework")).toBeNull();
    await u.click(dialog.getByRole("button", { name: "Homework 1" })); // 点作业名：打开作业详情
    const detailDialog = within(screen.getByRole("dialog", { name: "Homework 1" }));
    expect(await detailDialog.findByText("Write a loop.")).toBeTruthy();
    expect(detailDialog.getByText(/Correctness/)).toBeTruthy();
    mine.on = false;
  });
});
