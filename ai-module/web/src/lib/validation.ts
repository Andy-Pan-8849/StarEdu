import { ACCESS_LEVELS, DOMAINS } from "@/lib/types";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const EXTENSIONS = ["docx", "pdf", "md", "txt"] as const;

export type UploadFields = {
  doc_code: string;
  title: string;
  domain: string;
  version: string;
  access_level: string;
  min_level: string;
};

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

/** The same checks the server makes, so mistakes show up before the upload starts. */
export function validateUpload(
  fields: UploadFields,
  file: { name: string; size: number } | null,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!file) {
    errors.file = "Choose a file.";
  } else {
    const extension = file.name.includes(".")
      ? (file.name.split(".").pop() ?? "").toLowerCase()
      : "";
    if (!(EXTENSIONS as readonly string[]).includes(extension)) {
      errors.file = "Only docx, pdf, md and txt files are accepted.";
    } else if (file.size === 0) {
      errors.file = "The file is empty.";
    } else if (file.size > MAX_UPLOAD_BYTES) {
      errors.file = "The file is larger than 20 MB.";
    }
  }
  if (!CODE.test(fields.doc_code)) {
    errors.doc_code = "Use letters, digits, dots, dashes or underscores (2–40 characters).";
  }
  if (!fields.title.trim()) errors.title = "Enter a title.";
  if (fields.title.length > 200) errors.title = "The title is too long (200 characters at most).";
  if (!(DOMAINS as readonly string[]).includes(fields.domain)) errors.domain = "Choose a domain.";
  if (!VERSION.test(fields.version)) {
    errors.version = "Use letters, digits, dots, dashes or underscores (20 characters at most).";
  }
  if (!(ACCESS_LEVELS as readonly string[]).includes(fields.access_level)) {
    errors.access_level = "Choose who may read it.";
  }
  if (fields.min_level.trim() !== "") {
    const level = Number(fields.min_level);
    if (!Number.isInteger(level) || level < 1 || level > 7) {
      errors.min_level = "The grade must be a whole number from 1 to 7.";
    }
  }
  return errors;
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
