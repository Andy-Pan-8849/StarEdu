// 登录页上的演示账号块（Keycloak 主题里的一个脚本）必须和演示数据同步：账号名和密码对得上，否则点了登不进去。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_PASSWORD, scenarioAccounts } from "../../src/demo/demo-scenario";

const dir = resolve(__dirname, "../../../../deploy/keycloak/themes/staredu-demo/login");
const script = readFileSync(resolve(dir, "resources/js/demo-accounts.js"), "utf8");

describe("demo login block", () => {
  it("lists exactly the accounts the demo data creates, with the right entries and password", () => {
    const listed = [...script.matchAll(/\{ u: "([^"]+)", entry: "(admin|portal|platform)"/g)].map((m) => `${m[1]}:${m[2]}`).sort();
    const expected = [...scenarioAccounts("demo"), ...scenarioAccounts("rv")].map((a) => `${a.username}:${a.entry}`).concat("demo.operator:platform").sort();
    expect(listed).toEqual(expected);
    expect(script).toContain(`var PASSWORD = "${DEMO_PASSWORD}";`);
  });

  it("says in English that the accounts are for demonstration only, and can be removed by deleting one line", () => {
    expect(script).toContain("The accounts below are for demonstration only.");
    const props = readFileSync(resolve(dir, "theme.properties"), "utf8");
    expect(props).toMatch(/^scripts=js\/demo-accounts\.js$/m);
  });
});
