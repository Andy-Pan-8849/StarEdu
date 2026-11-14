-- B18: 成绩单验真。每份成绩单有不可猜的验真令牌（二维码里的链接）、内容指纹（成绩单内容的 SHA-256）、
-- 生成时的要点快照（公开验真页显示，不依赖之后成绩的变化）和作废记录。
-- 本里程碑之前生成的成绩单补一个令牌（没有指纹和快照，验真页只能确认"有这份文档"）。
ALTER TABLE biz."transcript_issue" ADD COLUMN "verify_token" TEXT;
UPDATE biz."transcript_issue" SET verify_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
ALTER TABLE biz."transcript_issue" ALTER COLUMN "verify_token" SET NOT NULL;
CREATE UNIQUE INDEX "transcript_issue_verify_token_key" ON biz."transcript_issue"("verify_token");
ALTER TABLE biz."transcript_issue" ADD COLUMN "content_hash" TEXT;
ALTER TABLE biz."transcript_issue" ADD COLUMN "snapshot" JSONB;
ALTER TABLE biz."transcript_issue" ADD COLUMN "revoked_at" TIMESTAMP(3);
ALTER TABLE biz."transcript_issue" ADD COLUMN "revoked_by" UUID;
ALTER TABLE biz."transcript_issue" ADD COLUMN "revoke_reason" TEXT;
