import { isPlatformHost, tenantCodeFromHost } from "../../src/tenancy/request-scope";

describe("tenantCodeFromHost", () => {
  it("takes the first label of the host", () => {
    expect(tenantCodeFromHost("hq.localhost:3001")).toBe("hq");
    expect(tenantCodeFromHost("Franchise.StarEdu.com")).toBe("franchise");
  });

  it("has no tenant for bare hosts and IP addresses", () => {
    expect(tenantCodeFromHost("localhost:4000")).toBeNull();
    expect(tenantCodeFromHost("127.0.0.1:4000")).toBeNull();
    expect(tenantCodeFromHost(undefined)).toBeNull();
  });

  it("recognizes the platform host by its first label only", () => {
    expect(isPlatformHost("platform.localhost:3001")).toBe(true);
    expect(isPlatformHost("platform.staredu.com")).toBe(true);
    expect(isPlatformHost("platformer.localhost")).toBe(false);
    expect(isPlatformHost("hq.platform.example.com")).toBe(false);
  });
});
