import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Citation, DocumentCitation, Me } from "@/lib/types";

const auth = vi.hoisted(() => ({
  me: null as unknown,
  json: vi.fn(),
  blob: vi.fn(),
  signOut: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    state: auth.me ? { status: "ready", me: auth.me } : { status: "loading" },
    api: { json: auth.json, blob: auth.blob },
    signOut: auth.signOut,
    retry: auth.retry,
  }),
  useMe: () => auth.me,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn() }),
}));

import { AppShell } from "@/components/app-shell";
import { CitationDrawer } from "@/components/citation-drawer";
import { DocumentsAdmin } from "@/components/documents-admin";
import { MessageBody } from "@/components/message-body";
import { UploadForm } from "@/components/upload-form";
import { Chat } from "@/components/chat";

function person(role: string): Me {
  return {
    user_id: "u1",
    name: "Pat Example",
    roles: [role],
    campus_id: "SH",
    level: "S2",
    employee_id: null,
    student_id: null,
  };
}

beforeEach(() => {
  auth.json.mockReset();
  auth.blob.mockReset();
  auth.me = null;
});

describe("menu", () => {
  it.each(["student", "staff", "manager", "hr", "finance", "Admin"])(
    "%s sees no document management",
    (role) => {
      auth.me = person(role);
      render(<AppShell>content</AppShell>);
      expect(screen.getByRole("link", { name: "Assistant" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Documents" })).not.toBeInTheDocument();
      expect(screen.getByTestId("who")).toHaveTextContent(role);
    },
  );

  it("RAGETLAdmin sees the Documents link", () => {
    auth.me = person("RAGETLAdmin");
    render(<AppShell>content</AppShell>);
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/admin/documents",
    );
  });

  it("waits while signing in", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.getByText("Signing in…")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("the documents page refuses other roles even if reached directly", () => {
    auth.me = person("manager");
    render(<DocumentsAdmin />);
    expect(screen.getByRole("alert")).toHaveTextContent(/do not have permission/);
    expect(auth.json).not.toHaveBeenCalled();
  });
});

describe("MessageBody", () => {
  it("makes markers clickable and shows text as text", async () => {
    const onCite = vi.fn();
    const citation: Citation = { n: 1, kind: "data", views: ["students"], row_count: 3 };
    render(
      <MessageBody content={"5 students <b>[1]</b> [2]"} citations={[citation]} onCite={onCite} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show source 1" }));
    expect(onCite).toHaveBeenCalledWith(citation);
    expect(screen.queryByRole("button", { name: "Show source 2" })).not.toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText(/<b>/)).toBeInTheDocument();
  });
});

describe("CitationDrawer", () => {
  it("shows the views and row count for data", () => {
    render(
      <CitationDrawer
        citation={{ n: 1, kind: "data", views: ["students"], row_count: 12 }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("students")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  const documentCitation: DocumentCitation = {
    n: 1,
    kind: "document",
    doc_code: "FIN-REIM-002",
    title: "Travel Policy",
    version: "2.0",
    status: "active",
    heading_path: ["4. Hotels"],
    page: null,
    chunk_id: "c2",
    document_id: "d1",
  };

  it("loads the cited passage with its neighbours and highlights it", async () => {
    auth.json.mockResolvedValue({
      document: {
        id: "d1",
        doc_code: "FIN-REIM-002",
        title: "Travel Policy",
        version: "2.0",
        status: "active",
        format: "md",
      },
      chunks: [
        { id: "c1", chunk_index: 0, text: "before", heading_path: [], page: null },
        {
          id: "c2",
          chunk_index: 1,
          text: "The hotel limit is CNY 600.",
          heading_path: [],
          page: null,
        },
      ],
    });
    render(<CitationDrawer citation={documentCitation} onClose={vi.fn()} />);
    const cited = await screen.findByText("The hotel limit is CNY 600.");
    expect(cited).toHaveAttribute("data-cited", "true");
    expect(screen.getByText("before")).toHaveAttribute("data-cited", "false");
    expect(auth.json).toHaveBeenCalledWith("/documents/d1/chunks?around=c2&window=1");
    expect(screen.getByText("4. Hotels")).toBeInTheDocument();
  });

  it("says so when the passage cannot be read", async () => {
    auth.json.mockRejectedValue(new Error("no"));
    render(<CitationDrawer citation={documentCitation} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("explains when an old answer has no document id", async () => {
    render(
      <CitationDrawer
        citation={{ ...documentCitation, document_id: undefined }}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/not available/);
    expect(auth.json).not.toHaveBeenCalled();
  });
});

describe("UploadForm", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Document code"), "TST-001");
    await user.type(screen.getByLabelText("Title"), "Travel notes");
    const version = screen.getByLabelText("Version");
    await user.clear(version);
    await user.type(version, "1.0");
  }

  it("shows mistakes and sends nothing", async () => {
    const user = userEvent.setup();
    render(<UploadForm onUploaded={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(screen.getByText("Choose a file.")).toBeInTheDocument();
    expect(screen.getByText(/Use letters, digits/)).toBeInTheDocument();
    expect(auth.json).not.toHaveBeenCalled();
  });

  it("rejects a file of the wrong kind before uploading", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<UploadForm onUploaded={vi.fn()} />);
    await fill(user);
    await user.upload(screen.getByLabelText("File"), new File(["x"], "run.exe"));
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(screen.getByText(/Only docx, pdf, md and txt/)).toBeInTheDocument();
    expect(auth.json).not.toHaveBeenCalled();
  });

  it("posts the file and the fields", async () => {
    const created = { id: "d1", doc_code: "TST-001", version: "1.0" };
    auth.json.mockResolvedValue({ document: created, job_id: "j1" });
    const onUploaded = vi.fn();
    const user = userEvent.setup();
    render(<UploadForm onUploaded={onUploaded} />);
    await fill(user);
    await user.clear(screen.getByLabelText("Campuses"));
    await user.type(screen.getByLabelText("Campuses"), "SH, BJ");
    await user.upload(
      screen.getByLabelText("File"),
      new File(["# hi"], "notes.md", { type: "text/markdown" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(created));
    const [path, options] = auth.json.mock.calls[0] as [string, { method: string; form: FormData }];
    expect(path).toBe("/documents");
    expect(options.method).toBe("POST");
    expect(options.form.get("doc_code")).toBe("TST-001");
    expect(options.form.getAll("campus_scope")).toEqual(["SH", "BJ"]);
    expect((options.form.get("file") as File).name).toBe("notes.md");
  });

  it("shows the server's reason, such as a duplicate", async () => {
    const { ApiError } = await import("@/lib/api");
    auth.json.mockRejectedValue(
      new ApiError(409, "conflict", "TST-001 version 1.0 already exists (id d1)"),
    );
    const user = userEvent.setup();
    render(<UploadForm onUploaded={vi.fn()} />);
    await fill(user);
    await user.upload(screen.getByLabelText("File"), new File(["# hi"], "notes.md"));
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
  });
});

describe("DocumentsAdmin", () => {
  const doc = {
    id: "d1",
    doc_code: "HR-REC-001",
    title: "Recruitment Policy",
    domain: "hr",
    version: "2.1",
    status: "active",
    effective_date: null,
    access_level: "all-staff",
    allowed_users: [],
    campus_scope: ["all"],
    min_level_rank: null,
    format: "docx",
    ingest_status: "ready",
    uploaded_by: "x",
    created_at: "2026-11-03T10:00:00Z",
    updated_at: "2026-11-03T10:00:00Z",
  };

  it("lists documents and deletes one after confirmation", async () => {
    auth.me = person("RAGETLAdmin");
    auth.json.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "DELETE") return undefined;
      return { items: [doc], next_cursor: null };
    });
    const user = userEvent.setup();
    render(<DocumentsAdmin />);
    expect(await screen.findByText("Recruitment Policy")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete HR-REC-001" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    expect(
      auth.json.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(auth.json).toHaveBeenCalledWith("/documents/d1", { method: "DELETE" }),
    );
  });

  it("filters through the query string", async () => {
    auth.me = person("RAGETLAdmin");
    auth.json.mockResolvedValue({ items: [], next_cursor: null });
    const user = userEvent.setup();
    render(<DocumentsAdmin />);
    await user.selectOptions(screen.getByLabelText("Filter by domain"), "finance");
    await waitFor(() =>
      expect(auth.json.mock.calls.some((c) => String(c[0]).includes("domain=finance"))).toBe(true),
    );
    expect(await screen.findByText("No documents match.")).toBeInTheDocument();
  });

  it("shows ingestion state and failure reasons", async () => {
    auth.me = person("RAGETLAdmin");
    auth.json.mockImplementation(async (path: string) =>
      path.endsWith("/jobs")
        ? {
            items: [
              {
                id: "j1",
                status: "failed",
                stage: "parse",
                attempt: 3,
                max_attempts: 3,
                error_code: "parse_error",
                error_message: "bad pdf",
                started_at: null,
                finished_at: null,
              },
            ],
          }
        : { items: [{ ...doc, ingest_status: "failed" }], next_cursor: null },
    );
    const user = userEvent.setup();
    render(<DocumentsAdmin />);
    await screen.findByText("Recruitment Policy");
    await user.click(screen.getByRole("button", { name: "Ingestion of HR-REC-001" }));
    expect(await screen.findByText(/parse_error: bad pdf/)).toBeInTheDocument();
  });
});

describe("Chat", () => {
  it("creates a conversation, sends the question and shows the answer with a source", async () => {
    auth.me = person("staff");
    auth.json.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path.startsWith("/conversations?")) return { items: [], next_cursor: null };
      if (path === "/conversations" && options?.method === "POST")
        return { id: "cv1", title: null, archived: false };
      if (path === "/conversations/cv1/messages") {
        return {
          run_id: "r1",
          message: {
            id: "m1",
            content: "The limit is CNY 600 [1].",
            citations: [{ n: 1, kind: "data", views: ["expense_claims"], row_count: 2 }],
          },
          end_state: "answered",
          end_reason: null,
        };
      }
      return { items: [], next_cursor: null };
    });
    const user = userEvent.setup();
    render(<Chat />);
    await user.type(screen.getByLabelText("Your question"), "hotel limit?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/The limit is CNY 600/)).toBeInTheDocument();
    expect(screen.getByText("hotel limit?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show source 1" }));
    expect(screen.getByRole("complementary", { name: "Source" })).toHaveTextContent(
      "expense_claims",
    );
  });

  it("shows a plain message when the service refuses", async () => {
    const { ApiError } = await import("@/lib/api");
    auth.me = person("staff");
    auth.json.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path.startsWith("/conversations?")) return { items: [], next_cursor: null };
      if (path === "/conversations" && options?.method === "POST")
        return { id: "cv1", title: null, archived: false };
      throw new ApiError(429, "rate_limited", "Too many messages; wait a minute");
    });
    const user = userEvent.setup();
    render(<Chat />);
    await user.type(screen.getByLabelText("Your question"), "again");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/wait a minute/);
  });
});
