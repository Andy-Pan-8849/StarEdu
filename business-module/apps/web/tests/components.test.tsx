// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { DataTable, pageCount } from "../src/components/admin/data-table";
import { NextIntlClientProvider } from "next-intl";
import { Modal } from "../src/components/admin/modal";
import { usePromptDialog } from "../src/components/admin/prompt-dialog";
import { MenuTreeShell, type ShellLabels } from "../src/components/admin/menu-tree-shell";
import type { MenuNode } from "../src/components/admin/menu-nav";
import { Can, PermButton, PermissionProvider } from "../src/components/admin/permissions";
import { IconButton, PermRowAction, RowAction } from "../src/components/admin/icon-button";
import { Plus } from "lucide-react";
import { NavTree, type NavNode } from "../src/components/admin/nav-tree";
import { TreeSelect } from "../src/components/admin/tree-select";
import type { TreeNode } from "../src/components/admin/tree";

describe("permissions", () => {
  it("renders content and buttons only when the permission is held", () => {
    render(
      <PermissionProvider permissions={["system:role:add"]}>
        <PermButton perm="system:role:add">Add</PermButton>
        <PermButton perm="system:role:remove">Remove</PermButton>
        <Can perm="system:role:add"><span>visible</span></Can>
        <Can perm="system:role:remove"><span>hidden</span></Can>
        <Can all={["system:role:add", "system:role:remove"]}><span>needs-both</span></Can>
        <Can any={["system:role:add", "system:role:remove"]}><span>needs-one</span></Can>
      </PermissionProvider>,
    );
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull(); // 没权限就不渲染（不是禁用）
    expect(screen.getByText("visible")).toBeTruthy();
    expect(screen.queryByText("hidden")).toBeNull();
    expect(screen.queryByText("needs-both")).toBeNull();
    expect(screen.getByText("needs-one")).toBeTruthy();
  });

  it("without a provider nothing is permitted", () => {
    render(<PermButton perm="x:y:z">Danger</PermButton>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

const nodes: TreeNode[] = [
  { id: "sys", label: "System", children: [{ id: "role", label: "Roles", children: [{ id: "role:add", label: "Add" }] }, { id: "menu", label: "Menus" }] },
  { id: "hr", label: "HR" },
];

function Harness({ initial = [] as string[], onValue }: { initial?: string[]; onValue?: (v: string[]) => void }) {
  const [value, setValue] = useState(initial);
  return <TreeSelect label="Menus" nodes={nodes} value={value} onChange={(v) => { setValue(v); onValue?.(v); }} />;
}

describe("TreeSelect", () => {
  it("ticking a parent ticks its children, and shows a mixed state for a partial selection", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onValue={seen} />);
    await user.click(screen.getByRole("checkbox", { name: "Roles" }));
    expect(seen).toHaveBeenLastCalledWith(expect.arrayContaining(["role", "role:add"]));
    expect((screen.getByRole("checkbox", { name: "Add" }) as HTMLInputElement).checked).toBe(true);
    const system = screen.getByRole("checkbox", { name: "System" }) as HTMLInputElement;
    expect(system.checked).toBe(false);
    expect(system.indeterminate).toBe(true); // 只勾了一部分下级 → 半选
    await user.click(screen.getByRole("checkbox", { name: "Menus" }));
    expect((screen.getByRole("checkbox", { name: "System" }) as HTMLInputElement).checked).toBe(true);
  });

  it("collapses a branch", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("checkbox", { name: "Roles" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse System" }));
    expect(screen.queryByRole("checkbox", { name: "Roles" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand System" }));
    expect(screen.getByRole("checkbox", { name: "Roles" })).toBeTruthy();
  });

  it("is read-only when disabled", () => {
    render(<TreeSelect label="Menus" nodes={nodes} value={["hr"]} onChange={() => {}} disabled />);
    expect((screen.getByRole("checkbox", { name: "HR" }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe("DataTable", () => {
  const columns = [{ key: "n", header: "Name", cell: (r: { n: string }) => r.n }];

  it("shows rows, the empty state and the loading state", () => {
    const { rerender } = render(<DataTable columns={columns} rows={[{ n: "alice" }]} rowKey={(r) => r.n} emptyText="Nothing" />);
    expect(screen.getByText("alice")).toBeTruthy();
    rerender(<DataTable columns={columns} rows={[]} rowKey={(r) => r.n} emptyText="Nothing" />);
    expect(screen.getByText("Nothing")).toBeTruthy();
    rerender(<DataTable columns={columns} rows={[]} rowKey={(r) => r.n} emptyText="Nothing" loading loadingText="Wait…" />);
    expect(screen.getByText("Wait…")).toBeTruthy();
    expect(screen.queryByText("Nothing")).toBeNull();
  });

  it("highlights the clicked row and moves the highlight to the next click", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={[{ n: "alice" }, { n: "bob" }]} rowKey={(r) => r.n} emptyText="-" />);
    const row = (name: string) => screen.getByText(name).closest("tr")!;
    expect(row("alice").getAttribute("aria-selected")).toBe("false");
    await user.click(screen.getByText("alice"));
    expect(row("alice").getAttribute("aria-selected")).toBe("true");
    expect(row("bob").getAttribute("aria-selected")).toBe("false");
    await user.click(screen.getByText("bob"));
    expect(row("alice").getAttribute("aria-selected")).toBe("false");
    expect(row("bob").getAttribute("aria-selected")).toBe("true");
  });

  it("has a checkbox column: select all / one row, bulk actions appear, and the Actions column is last and named", async () => {
    const user = userEvent.setup();
    const cols = [
      { key: "actions", header: "", cell: () => <button>Edit</button> },
      { key: "n", header: "Name", cell: (r: { n: string }) => r.n },
    ];
    render(<DataTable columns={cols} rows={[{ n: "a" }, { n: "b" }]} rowKey={(r) => r.n} emptyText="-" bulkActions={(keys) => <button>Delete {keys.join(",")}</button>} />);
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["", "Name", "Actions"]); // 复选列在最前，操作列在最后
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    await user.click(screen.getAllByRole("checkbox", { name: "Select row" })[1]!);
    expect(screen.getByRole("button", { name: "Delete b" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Delete a,b" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("selectable={false} hides the checkbox column", () => {
    render(<DataTable columns={columns} rows={[{ n: "a" }]} rowKey={(r) => r.n} emptyText="-" selectable={false} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("pages forwards and backwards within bounds (known total)", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<DataTable columns={columns} rows={[{ n: "a" }]} rowKey={(r) => r.n} emptyText="-" pagination={{ page: 2, size: 10, total: 25, onPageChange }} />);
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("without a known total, Next is enabled only when there may be more", () => {
    const { rerender } = render(<DataTable columns={columns} rows={[{ n: "a" }]} rowKey={(r) => r.n} emptyText="-" pagination={{ page: 1, size: 20, hasMore: false, onPageChange: () => {} }} />);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<DataTable columns={columns} rows={[{ n: "a" }]} rowKey={(r) => r.n} emptyText="-" pagination={{ page: 1, size: 20, hasMore: true, onPageChange: () => {} }} />);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("counts pages", () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(25, 10)).toBe(3);
    expect(pageCount(30, 10)).toBe(3);
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
const intl = (ui: React.ReactElement) => <NextIntlClientProvider locale="en" messages={{}}>{ui}</NextIntlClientProvider>;

describe("MenuTreeShell", () => {
  it("shows the company brand at the top of the menu: custom logo and short name, or the default logo", () => {
    const labels0: ShellLabels = { closeTab: "Close", noMenus: "No menus", pageNotBuilt: "Not built", signedInAs: "Signed in as", signOut: "Sign out" };
    const shell = (brand?: { name: string; logoUrl: string | null }) => (
      intl(<MenuTreeShell menus={[]} pages={{}} label={(n) => n.name} userName="a" brand={brand} signOutAction="/x" labels={labels0} />)
    );
    const { container, rerender } = render(shell({ name: "RiverSide", logoUrl: "https://example.test/logo.png" }));
    expect(screen.getByText("RiverSide")).toBeTruthy();
    expect(container.querySelector("nav img")?.getAttribute("src")).toBe("https://example.test/logo.png");
    rerender(shell({ name: "RiverSide", logoUrl: null }));
    expect(container.querySelector("nav img")).toBeNull();
    expect(container.querySelector("nav svg")).toBeTruthy(); // default logo
    rerender(shell());
    expect(screen.getByText("StarIT")).toBeTruthy();
  });

  const menus: MenuNode[] = [
    { id: "d1", code: "system", name: "System", nameKey: null, type: "directory", route: "system", component: null, icon: null, children: [
      { id: "m1", code: "system:online", name: "Online users", nameKey: null, type: "menu", route: "online", component: "system/online/index", icon: null, children: [] },
      { id: "m2", code: "system:role", name: "Roles", nameKey: null, type: "menu", route: "role", component: "system/role/index", icon: null, children: [] },
      { id: "l1", code: null, name: "Wiki", nameKey: null, type: "link", route: "https://wiki.example.test", component: null, icon: null, children: [] },
    ] },
  ];
  const labels: ShellLabels = { closeTab: "Close", noMenus: "No menus", pageNotBuilt: "Not built", signedInAs: "Signed in as", signOut: "Sign out" };
  const shell = (m: MenuNode[]) => (
    intl(<MenuTreeShell menus={m} pages={{ "system/online/index": () => <p>online page</p> }} label={(n) => n.name} userName="alice" signOutAction="/admin/auth/logout" labels={labels} />)
  );

  it("opens the first page as a tab, switches between tabs, closes tabs, and shows a placeholder for pages that do not exist yet", async () => {
    const user = userEvent.setup();
    render(shell(menus));
    expect(screen.getByText("online page")).toBeTruthy(); // 默认打开第一个菜单
    await user.click(screen.getByRole("button", { name: "Roles" }));
    expect(screen.getByText("Not built")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Online users", "Roles"]);
    await user.click(screen.getByRole("tab", { name: "Online users" }));
    expect(screen.getByText("online page")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Roles" }));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("filters the menu by the search box and collapses to an icon-only column", async () => {
    const user = userEvent.setup();
    render(shell(menus));
    await user.type(screen.getByRole("searchbox", { name: "Search menu" }), "role");
    expect(screen.getByRole("button", { name: "Roles" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Online users" })).toBeNull();
    await user.clear(screen.getByRole("searchbox", { name: "Search menu" }));
    await user.click(screen.getByRole("button", { name: "Collapse menu" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("button", { name: "System" })).toBeTruthy(); // 只剩目录图标
    await user.click(screen.getByRole("button", { name: "Expand menu" }));
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("opens external links in a new window without opener access, and folds directories", async () => {
    const user = userEvent.setup();
    render(shell(menus));
    const link = screen.getByRole("link", { name: /Wiki/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    await user.click(screen.getByRole("button", { name: /System/, expanded: true }));
    expect(screen.queryByRole("link", { name: /Wiki/ })).toBeNull();
  });

  it("says so when no menu is assigned, and offers sign-out as a POST form in the avatar menu", async () => {
    const user = userEvent.setup();
    render(shell([]));
    expect(screen.getByText("No menus")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "alice" })); // 头像
    const form = screen.getByRole("menuitem", { name: "Sign out" }).closest("form") as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(form.getAttribute("action")).toBe("/admin/auth/logout");
    expect(within(screen.getByRole("menu")).getByText("alice")).toBeTruthy();
  });

  it("opens a pinned Home tab that cannot be closed, and the profile page from the avatar menu", async () => {
    const user = userEvent.setup();
    render(intl(<MenuTreeShell menus={menus} pages={{ "system/online/index": () => <p>online page</p> }} label={(n) => n.name} userName="alice" signOutAction="/x" labels={{ ...labels, home: "Home", profile: "Profile" }} homePage={() => <p>home content</p>} profilePage={() => <p>profile content</p>} />));
    expect(screen.getByText("home content")).toBeTruthy(); // 登录后先到首页
    expect(screen.queryByRole("button", { name: "Close Home" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "alice" }));
    await user.click(screen.getByRole("menuitem", { name: "Profile" }));
    expect(screen.getByText("profile content")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Home", "Profile"]);
    await user.click(screen.getByRole("button", { name: "Close Profile" }));
    expect(screen.getByText("home content")).toBeTruthy();
  });

  it("lists Home at the top of the menu tree and returns to it from the tree", async () => {
    const user = userEvent.setup();
    render(intl(<MenuTreeShell menus={menus} pages={{ "system/online/index": () => <p>online page</p> }} label={(n) => n.name} userName="alice" signOutAction="/x" labels={{ ...labels, home: "Home" }} homePage={() => <p>home content</p>} />));
    const nav = within(screen.getByRole("navigation", { name: "Menu" }));
    expect(nav.getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    await user.click(nav.getByRole("button", { name: "Online users" }));
    expect(screen.getByText("online page")).toBeTruthy();
    await user.click(nav.getByRole("button", { name: "Home" }));
    expect(screen.getByText("home content")).toBeTruthy();
  });
});

describe("Modal", () => {
  it("shows its content as a dialog, and closes on Esc, on the backdrop, but not on a click inside", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal title="Details" onClose={onClose}><p>body</p></Modal>);
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(within(dialog).getByText("body")).toBeTruthy();
    await user.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("usePromptDialog", () => {
  function Demo({ onResult }: { onResult: (v: Record<string, string> | null) => void }) {
    const { ask, dialog } = usePromptDialog();
    return (
      <>
        <button onClick={() => void ask("Ask", [{ name: "x", label: "X", initial: "a" }]).then(onResult)}>go</button>
        {dialog}
      </>
    );
  }
  it("returns the typed values on save and null on cancel", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(<NextIntlClientProvider locale="en" messages={{ crud: { save: "save", cancel: "cancel" } }}><Demo onResult={onResult} /></NextIntlClientProvider>);
    await user.click(screen.getByRole("button", { name: "go" }));
    const box = screen.getByLabelText("X") as HTMLInputElement;
    expect(box.value).toBe("a");
    await user.type(box, "b");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(onResult).toHaveBeenLastCalledWith({ x: "ab" });
    await user.click(screen.getByRole("button", { name: "go" }));
    await user.keyboard("{Escape}");
    expect(onResult).toHaveBeenLastCalledWith(null);
  });
});

describe("NavTree", () => {
  const nodes: NavNode[] = [
    { id: "root", label: "Root", children: [{ id: "kid", label: "Kid", children: [] }] },
    { id: "other", label: "Other", children: [] },
  ];
  it("selects a node, and folds and unfolds the children of a node", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<NavTree label="Tree" nodes={nodes} selectedId="kid" onSelect={onSelect} />);
    expect(screen.getByRole("treeitem", { name: /Kid/, selected: true })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Other" }));
    expect(onSelect).toHaveBeenCalledWith("other");
    await user.click(screen.getByRole("button", { name: "Collapse Root" }));
    expect(screen.queryByRole("button", { name: "Kid" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand Root" }));
    expect(screen.getByRole("button", { name: "Kid" })).toBeTruthy();
  });
});

describe("IconButton", () => {
  it("has the label as its accessible name and shows it as a tooltip on hover", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton icon={Plus} label="Add" onClick={onClick} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Add");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onClick).toHaveBeenCalled();
    await user.unhover(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("table row actions overflow", () => {
  const act = (name: string) => <RowAction key={name} icon={Plus} onClick={() => {}}>{name}</RowAction>;
  it("shows up to three actions directly and puts the rest in a More menu", async () => {
    const user = userEvent.setup();
    const cols = [{ key: "n", header: "Name", cell: (r: { n: string }) => r.n }, { key: "actions", header: "", cell: () => <>{act("One")}{act("Two")}{act("Three")}{act("Four")}{act("Five")}</> }];
    render(<DataTable columns={cols} rows={[{ n: "a" }]} rowKey={(r) => r.n} emptyText="-" labels={{ previous: "P", next: "N", page: () => "", more: "More" }} />);
    expect(screen.getByRole("button", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Two" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Three" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Three" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Five" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Three" })).toBeNull();
  });
  it("does not count actions the user has no permission for, and shows no More menu when three or fewer remain", () => {
    const cols = [{ key: "actions", header: "", cell: () => <>{act("One")}<PermRowAction perm="x:y" icon={Plus}>Hidden</PermRowAction>{act("Two")}{act("Three")}</> }];
    render(<DataTable columns={cols} rows={[{ n: "a" }]} rowKey={(r) => r.n} emptyText="-" />);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getByRole("button", { name: "Three" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hidden" })).toBeNull();
  });
});
