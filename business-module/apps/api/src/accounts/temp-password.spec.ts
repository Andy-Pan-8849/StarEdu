import { generateTempPassword } from "./accounts.service";

describe("generateTempPassword", () => {
  it("is 12 characters with upper, lower, digit and special, and differs every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const p = generateTempPassword();
      expect(p).toHaveLength(12);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%^&*\-_=+]/);
      expect(p).not.toMatch(/[0OlI1]/); // 容易看混的字符不出现
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
