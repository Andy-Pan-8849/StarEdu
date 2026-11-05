/**
 * 文件：lib/types.ts
 * 作用：前端用到的数据类型，与后端 API 返回的 JSON 一一对应（见 docs/design/03）。
 * 包括：当前用户 Me、会话 Conversation、消息 Message 与引用 Citation（文档引用/数据引用两种）、
 * 运行结局 EndState、分页 Page、文档元数据 DocumentMeta、入库任务 Job、文本块 Chunk，
 * 以及上传表单可选的权限级别和领域列表。
 */

/**
 * /me 返回的当前用户：ID、姓名、角色、校区、职级、员工/学员编号。
 */
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

/**
 * 文档类引用：对应哪份文档的哪个版本和章节，点开可看原文。
 */
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

/**
 * 数据类引用：说明答案来自哪些视图、多少行。
 */
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

/**
 * 一次运行的六种结局：已回答 / 需要澄清 / 无权限 / 没找到 / 拒绝 / 出错。
 */
export type EndState =
  "answered" | "need_clarification" | "no_permission" | "not_found" | "refused" | "error";

/**
 * 游标分页的一页：items 和下一页游标（没有更多为 null）。
 */
export type Page<T> = { items: T[]; next_cursor: string | null };

/**
 * 文档元数据（不含正文）：编号、标题、版本、状态、权限、入库状态等。
 */
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

/**
 * 一个入库任务的状态、阶段、重试次数和错误。
 */
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

/**
 * 上传时可选的权限级别（与后端 ACCESS_LEVEL_ROLES 对应）。
 */
export const ACCESS_LEVELS = [
  "students-and-staff",
  "all-staff",
  "staff",
  "managers",
  "finance-and-hr",
  "hr-only",
] as const;

export const DOMAINS = ["hr", "finance", "tech-support"] as const;
