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
const enrollments = [{ id: "e1", status: "enrolled", course: { code: "JAVA101", name: "Java Programming" }, term: "Current term", canDrop: true, willBeW: false, section: { id: "s1", name: "Java Programming (DEMO 01)" } }];
vi.mock("@/lib/bff", () => ({
  bff: vi.fn(async (path: string) => (path === "sections/s1" ? detail : path === "my-enrollments" ? enrollments : [])),
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
    expect(dialog.getByText("Taylor Demo (teacher)")).toBeTruthy();
    expect(dialog.getByText("1 left of 20")).toBeTruthy();
    expect(dialog.getByText(/CS100 · Intro/).textContent).toContain("not passed yet");
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
});
