export type Me = {
  user_id: string;
  name: string;
  roles: string[];
  campus_id: string | null;
  level: string | null;
  employee_id: string | null;
  student_id: string | null;
};

export type Conversation = {
  id: string;
  title: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type DocumentCitation = {
  n: number;
  kind: "document";
  doc_code: string;
  title: string;
  version: string;
  status: string;
  heading_path: string[];
  page: number | null;
  chunk_id: string;
  document_id?: string;
};

export type DataCitation = {
  n: number;
  kind: "data";
  views: string[];
  row_count: number;
};

export type Citation = DocumentCitation | DataCitation;

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  created_at?: string;
};

export type EndState =
  "answered" | "need_clarification" | "no_permission" | "not_found" | "refused" | "error";

export type Page<T> = { items: T[]; next_cursor: string | null };

export type DocumentMeta = {
  id: string;
  doc_code: string;
  title: string;
  domain: string;
  version: string;
  status: "active" | "superseded" | "draft";
  effective_date: string | null;
  access_level: string;
  allowed_users: string[];
  campus_scope: string[];
  min_level_rank: number | null;
  format: string;
  ingest_status: "queued" | "running" | "ready" | "failed";
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Job = {
  id: string;
  status: string;
  stage: string | null;
  attempt: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type Chunk = {
  id: string;
  chunk_index: number;
  text: string;
  heading_path: string[];
  page: number | null;
};

export type ChunksResponse = {
  document: {
    id: string;
    doc_code: string;
    title: string;
    version: string;
    status: string;
    format: string;
  };
  chunks: Chunk[];
};

export const ACCESS_LEVELS = [
  "students-and-staff",
  "all-staff",
  "staff",
  "managers",
  "finance-and-hr",
  "hr-only",
] as const;

export const DOMAINS = ["hr", "finance", "tech-support"] as const;
