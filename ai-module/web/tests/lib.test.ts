import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi, userMessage } from "@/lib/api";
import { canManageDocuments, safeReturnPath } from "@/lib/auth";
import { splitCitations } from "@/lib/citations";
import { splitList, validateUpload, type UploadFields } from "@/lib/validation";

describe("splitCitations", () => {
  it("turns known markers into citations and keeps the text around them", () => {
    expect(splitCitations("Limit is 600 [1] per night [2].", new Set([1, 2]))).toEqual([
      { type: "text", text: "Limit is 600 " },
      { type: "cite", n: 1 },
      { type: "text", text: " per night " },
      { type: "cite", n: 2 },
      { type: "text", text: "." },
    ]);
  });

  it("leaves markers that match no citation as text", () => {
    const parts = splitCitations("See [3] and [1]", new Set([1]));
    expect(parts.filter((p) => p.type === "cite")).toEqual([{ type: "cite", n: 1 }]);
    expect(parts.map((p) => (p.type === "text" ? p.text : "")).join("")).toContain("[3]");
  });

  it("never treats the text as markup", () => {
    const parts = splitCitations("<img src=x onerror=alert(1)> [1]", new Set([1]));
    expect(parts[0]).toEqual({ type: "text", text: "<img src=x onerror=alert(1)> " });
  });

  it("returns the whole text when there are no markers", () => {
    expect(splitCitations("plain", new Set())).toEqual([{ type: "text", text: "plain" }]);
    expect(splitCitations("", new Set())).toEqual([]);
  });
});

describe("safeReturnPath", () => {
  it.each([
    ["/admin/documents", "/admin/documents"],
    ["/", "/"],
    ["//evil.example", "/"],
    ["https://evil.example", "/"],
    ["javascript:alert(1)", "/"],
    [undefined, "/"],
    [42, "/"],
  ])("%s -> %s", (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });
});

describe("canManageDocuments", () => {
  it.each(["student", "staff", "manager", "hr", "finance", "Admin"])("%s cannot", (role) => {
    expect(canManageDocuments([role])).toBe(false);
  });
  it("RAGETLAdmin can", () => {
    expect(canManageDocuments(["RAGETLAdmin"])).toBe(true);
  });
});

const good: UploadFields = {
  doc_code: "HR-REC-001",
  title: "Recruitment",
  domain: "hr",
  version: "2.1",
  access_level: "all-staff",
  min_level: "",
};
const file = { name: "policy.docx", size: 1000 };

describe("validateUpload", () => {
  it("accepts a good upload", () => {
    expect(validateUpload(good, file)).toEqual({});
  });
  it.each([
    [{ ...good, doc_code: "bad code!" }, file, "doc_code"],
    [{ ...good, title: "  " }, file, "title"],
    [{ ...good, domain: "sales" }, file, "domain"],
    [{ ...good, version: "../1" }, file, "version"],
    [{ ...good, access_level: "everyone" }, file, "access_level"],
    [{ ...good, min_level: "9" }, file, "min_level"],
    [{ ...good, min_level: "2.5" }, file, "min_level"],
    [good, null, "file"],
    [good, { name: "run.exe", size: 10 }, "file"],
    [good, { name: "noextension", size: 10 }, "file"],
    [good, { name: "empty.md", size: 0 }, "file"],
    [good, { name: "big.pdf", size: 20 * 1024 * 1024 + 1 }, "file"],
  ])("rejects %#", (fields, chosen, field) => {
    expect(Object.keys(validateUpload(fields, chosen))).toContain(field);
  });
  it("splits comma lists", () => {
    expect(splitList(" SH, BJ ,, all ")).toEqual(["SH", "BJ", "all"]);
  });
});

describe("createApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bearer token and parses JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApi({ getToken: async () => "tok", onUnauthorized: vi.fn() });
    expect(await api.json("/me")).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/me")).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("sends JSON bodies with a content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApi({ getToken: async () => "tok", onUnauthorized: vi.fn() });
    await api.json("/x", { method: "POST", json: { a: 1 } });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("signs in again on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "unauthenticated", message: "expired" } }), {
          status: 401,
        }),
      ),
    );
    const onUnauthorized = vi.fn();
    const api = createApi({ getToken: async () => "tok", onUnauthorized });
    await expect(api.json("/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("does not call the API without a token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const api = createApi({ getToken: async () => null, onUnauthorized });
    await expect(api.json("/me")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("returns undefined for 204 and keeps API error codes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })));
    const api = createApi({ getToken: async () => "tok", onUnauthorized: vi.fn() });
    expect(await api.json("/x", { method: "DELETE" })).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "conflict", message: "exists (id 1)" } }), {
          status: 409,
        }),
      ),
    );
    await expect(api.json("/x")).rejects.toMatchObject({ status: 409, code: "conflict" });
  });
});

describe("userMessage", () => {
  it("explains common failures plainly", () => {
    expect(userMessage(new ApiError(403, "forbidden", "x"))).toMatch(/permission/);
    expect(userMessage(new ApiError(429, "rate_limited", "x"))).toMatch(/wait/);
    expect(userMessage(new ApiError(500, "internal_error", "boom"))).not.toMatch(/boom/);
    expect(userMessage(new TypeError("Failed to fetch"))).toMatch(/Could not reach/);
    expect(userMessage(new ApiError(409, "conflict", "TST-001 already exists"))).toMatch(
      /already exists/,
    );
  });
});
