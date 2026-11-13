// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FormPanel, toPayload, type Field } from "../src/components/admin/pages/crud";

const fields: Field[] = [
  { name: "code", label: "Code", required: true },
  { name: "sort", label: "Order", type: "number" },
  { name: "enabled", label: "Enabled", type: "checkbox" },
  { name: "kind", label: "Kind", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  { name: "fixed", label: "Fixed", readOnly: true },
];

describe("toPayload", () => {
  it("turns numbers into numbers, drops empty text, keeps booleans, skips read-only fields", () => {
    expect(toPayload(fields, { code: "x", sort: "3", enabled: true, kind: "", fixed: "ignored" })).toEqual({ code: "x", sort: 3, enabled: true });
    expect(toPayload(fields, { code: "", sort: "", enabled: false, kind: "b", fixed: "" })).toEqual({ enabled: false, kind: "b" });
  });
});

describe("FormPanel", () => {
  it("submits the typed values and can be cancelled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<FormPanel title="Add" fields={fields} submitLabel="Save" cancelLabel="Cancel" onSubmit={onSubmit} onCancel={onCancel} />);
    await user.type(screen.getByLabelText("Code"), "abc");
    await user.type(screen.getByLabelText("Order"), "7");
    await user.click(screen.getByLabelText("Enabled"));
    await user.selectOptions(screen.getByLabelText("Kind"), "b");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith({ code: "abc", sort: 7, enabled: true, kind: "b" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("starts from the given values and does not submit a missing required field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<FormPanel title="Edit" fields={fields} initial={{ code: "old", sort: "2", enabled: true }} submitLabel="Save" cancelLabel="Cancel" onSubmit={onSubmit} onCancel={() => {}} />);
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("old");
    await user.clear(screen.getByLabelText("Code"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled(); // 必填没填，浏览器的表单校验拦住
  });
});
