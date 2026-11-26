// 菜单同步：目录里调整了顶层菜单的排序，已有的库里入口的排序也要跟上（它就是左侧菜单树的顺序）。
import { MENU_CATALOG } from "@staredu/shared";
import { syncPlatformMenus } from "../src/catalog/menu-sync";
import { ownerClient } from "./helpers/fixtures";

describe("menu sync keeps the entry order in line with the catalog", () => {
  const owner = ownerClient();
  afterAll(async () => {
    await syncPlatformMenus(owner);
    await owner.$disconnect();
  });

  it("puts a top-level menu back to the catalog's sort, in every entry it is assigned to", async () => {
    await syncPlatformMenus(owner);
    const ai = await owner.menu.findFirstOrThrow({ where: { tenantId: null, code: "ai" } });
    await owner.entryMenu.updateMany({ where: { tenantId: null, menuId: ai.id }, data: { sort: 99 } });
    await syncPlatformMenus(owner);
    const rows = await owner.entryMenu.findMany({ where: { tenantId: null, menuId: ai.id } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sort === MENU_CATALOG.find((m) => m.code === "ai")!.sort)).toBe(true);
  });
});
