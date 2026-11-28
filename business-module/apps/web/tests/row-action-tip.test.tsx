// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Play } from "lucide-react";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { RowAction } from "../src/components/admin/icon-button";

describe("row action tips", () => {
  it("shows an explanation when the pointer is over the action", async () => {
    render(<RowAction icon={Play} tip="Teaching begins.">Start teaching</RowAction>);
    await userEvent.setup().hover(screen.getByRole("button", { name: "Start teaching" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Teaching begins.");
  });
  it("every class status action has a label and a tip in both languages", () => {
    for (const m of [en, zh] as Array<{ pages: { edu: Record<string, string> } }>) {
      for (const k of ["draft", "open", "in_progress", "ended", "cancelled"]) {
        expect(m.pages.edu[`to_sec_${k}`]).toBeTruthy();
        expect(m.pages.edu[`tip_sec_${k}`]).toBeTruthy();
      }
    }
  });
});

describe("start class action", () => {
  it("is a short button whose tip carries the full name", () => {
    expect(en.pages.edu.to_sec_in_progress).toBe("Start class");
    expect(en.pages.edu.tip_sec_in_progress.startsWith("Close enrollment & start class")).toBe(true);
  });
});
