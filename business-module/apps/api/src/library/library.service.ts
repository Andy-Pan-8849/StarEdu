// 文档库的业务规则：文件夹树、文件、授权、密级、访问日志。
// 两层权限：接口先检查菜单按钮上的"操作权限"，这里再检查用户在该文件夹上的"访问级别"（见 LibraryAccess）。
// 没有查看权限的文件夹对用户来说就不存在（404，不透露是否存在）。
import { QuotaService } from "../quota/quota.service";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Prisma } from "../generated/prisma";
import { ObjectStoreService, assertTenantKey, safeKeyPart, tenantPrefix } from "../storage/object-store.service";
import { OutboxService } from "../edu/outbox.service";
import { extendedEvents } from "../events/event-bus";
import { assertVisible } from "../tenancy/owned";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { atLeast, LibraryAccess, type Access, type FolderRow, type Level } from "./library-access.service";

export const CLASSIFICATIONS = ["public", "internal", "confidential"] as const;
const RANK_CLASS: Record<string, number> = { public: 0, internal: 1, confidential: 2 };
const ALLOWED_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "gif", "txt", "md", "csv", "json", "docx", "xlsx", "pptx", "zip"]);
const INLINE_TYPES: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };

export const maxLibraryBytes = (): number => (Number(process.env.LIBRARY_MAX_BYTES) > 0 ? Number(process.env.LIBRARY_MAX_BYTES) : 50 * 1024 * 1024);
const extOf = (name: string): string => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export const folderSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  classification: z.enum(CLASSIFICATIONS).optional(),
  ownerDeptId: z.string().uuid().nullable().optional(),
});
export const folderPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  ownerDeptId: z.string().uuid().nullable().optional(),
  inheritAcl: z.boolean().optional(),
  previewOnly: z.boolean().optional(),
  logAccess: z.boolean().optional(),
  confirm: z.boolean().optional(),
});
export const aclSchema = z.object({
  principalType: z.enum(["everyone", "all_staff", "dept", "role", "user"]),
  principalId: z.string().uuid().nullable().optional(),
  includeSub: z.boolean().optional(),
  level: z.enum(["view", "edit", "manage"]),
  expiresAt: z.string().datetime().nullable().optional(),
});

@Injectable()
export class LibraryService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly access: LibraryAccess,
    private readonly store: ObjectStoreService,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 文件有变化（新增、新版本、改名、删除、移动、复制）：通知 AI 知识库来同步（只带文件 id，内容由它回来取）。 */
  private async changed(fileId: string): Promise<void> {
    if (extendedEvents()) await this.outbox.emit("library.file_changed", { fileId });
  }

  // ------------------------------------------------------------ 日志
  /** 写访问日志。always：管理类动作一定写；否则只有"记录访问日志"的文件夹（机密必记）才写。 */
  async log(auth: AuthContext, action: string, opts: { folder?: FolderRow | null; fileId?: string; detail?: Record<string, unknown>; always?: boolean }): Promise<void> {
    if (!opts.always && !(opts.folder && (opts.folder.logAccess || opts.folder.classification === "confidential"))) return;
    await this.db.docAccessLog.create({ data: { tenantId: auth.tenantId, accountId: auth.accountId, action, folderId: opts.folder?.id ?? null, fileId: opts.fileId ?? null, detail: (opts.detail ?? undefined) as never } });
  }

  // ------------------------------------------------------------ 访问级别
  /** 取文件夹并要求至少某级别；看不到的一律 404。 */
  async folderAt(auth: AuthContext, id: string, need: Level, access?: Access): Promise<{ folder: FolderRow; level: Level; access: Access }> {
    const a = access ?? (await this.access.resolve(auth));
    const folder = a.folders.get(id);
    const level = a.level(id);
    if (!folder || !atLeast(level, "view")) throw new NotFoundException();
    if (!atLeast(level, need)) throw new ForbiddenException(`This needs the ${need === "manage" ? "manage" : "edit"} level on the folder`);
    return { folder, level, access: a };
  }

  private async fileAt(auth: AuthContext, fileId: string, need: Level) {
    const file = await this.db.docFile.findFirst({ where: { id: fileId, deletedAt: null } });
    if (!file) throw new NotFoundException();
    const at = await this.folderAt(auth, file.folderId, need);
    return { file, ...at };
  }

  /** 编辑/上传级别只能动自己上传的文件，管理级别可以动任何文件。 */
  private canTouch(level: Level, file: { uploadedBy: string | null }, auth: AuthContext): boolean {
    return atLeast(level, "manage") || (atLeast(level, "edit") && file.uploadedBy === auth.accountId);
  }

  // ------------------------------------------------------------ 文件夹
  async listFolders(auth: AuthContext) {
    const a = await this.access.resolve(auth);
    const visible = [...a.folders.values()].filter((f) => atLeast(a.level(f.id), "view"));
    const files = await this.db.docFile.groupBy({ by: ["folderId"], where: { deletedAt: null }, _count: true, _sum: { size: true } });
    return visible
      .map((f) => ({ id: f.id, tenantId: auth.tenantId, parentId: f.parentId && atLeast(a.level(f.parentId), "view") ? f.parentId : null, name: f.name, classification: f.classification, level: a.level(f.id), inheritAcl: f.inheritAcl, previewOnly: f.previewOnly, logAccess: f.logAccess, ownerDeptId: f.ownerDeptId, files: files.find((x) => x.folderId === f.id)?._count ?? 0, bytes: files.find((x) => x.folderId === f.id)?._sum.size ?? 0, createdAt: f.createdAt }))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  async getFolder(auth: AuthContext, id: string) {
    const { folder, level } = await this.folderAt(auth, id, "view");
    const [stats, children] = await Promise.all([this.db.docFile.aggregate({ where: { folderId: id, deletedAt: null }, _count: true, _sum: { size: true } }), this.db.docFolder.count({ where: { parentId: id } })]);
    return { id: folder.id, parentId: folder.parentId, name: folder.name, classification: folder.classification, level, inheritAcl: folder.inheritAcl, previewOnly: folder.previewOnly, logAccess: folder.logAccess, ownerDeptId: folder.ownerDeptId, createdBy: folder.createdBy, createdAt: folder.createdAt, files: stats._count, bytes: stats._sum.size ?? 0, subfolders: children };
  }

  async createFolder(auth: AuthContext, input: z.infer<typeof folderSchema>) {
    const parentId = input.parentId ?? null;
    if (parentId === null) {
      if (!auth.authz.perms.includes("doc:folder:root")) throw new ForbiddenException("Creating a top-level folder needs its own permission");
    } else await this.folderAt(auth, parentId, "manage");
    if (input.ownerDeptId) await assertVisible(this.db.dept, [input.ownerDeptId], "department");
    const classification = input.classification ?? "internal";
    const confidential = classification === "confidential";
    try {
      const id = await this.tenantDb.transaction(async (tx) => {
        const f = await tx.docFolder.create({
          data: { tenantId: auth.tenantId, parentId, name: input.name, ownerDeptId: input.ownerDeptId ?? null, classification, inheritAcl: !confidential, logAccess: confidential, createdBy: auth.accountId },
        });
        const rows: Prisma.DocAclCreateManyInput[] = [];
        if (!confidential) {
          // 默认授权（来自需求文档的示例数据）：公开 = 所有人（含学生）；内部 = 所属部门（含下级）查看，没有所属部门就是全体员工；
          // 机密不生成任何默认授权。别的人要看，由管理者手工授权。
          if (classification === "public") rows.push({ tenantId: auth.tenantId, folderId: f.id, principalType: "everyone", level: "view", source: "default", grantedBy: auth.accountId });
          else if (input.ownerDeptId) rows.push({ tenantId: auth.tenantId, folderId: f.id, principalType: "dept", principalId: input.ownerDeptId, includeSub: true, level: "view", source: "default", grantedBy: auth.accountId });
          else rows.push({ tenantId: auth.tenantId, folderId: f.id, principalType: "all_staff", level: "view", source: "default", grantedBy: auth.accountId });
        }
        // 建的人管理：机密文件夹没有默认授权，建的人由手工授权保证不会把自己锁在外面（写日志）
        rows.push({ tenantId: auth.tenantId, folderId: f.id, principalType: "user", principalId: auth.accountId, level: "manage", source: confidential ? "manual" : "default", grantedBy: auth.accountId });
        await tx.docAcl.createMany({ data: rows });
        return f.id;
      });
      const folder = (await this.db.docFolder.findUniqueOrThrow({ where: { id } })) as FolderRow;
      await this.log(auth, "folder.create", { folder, always: true, detail: { name: input.name, classification } });
      return this.getFolder(auth, id);
    } catch (err) {
      this.mapFolderError(err);
    }
  }

  private mapFolderError(err: unknown): never {
    const code = (err as { code?: string }).code;
    if (code === "P2002" || /doc_folder_name_key/.test(String((err as Error).message))) throw new ConflictException("A folder with that name already exists here");
    if (/cannot be moved under itself/.test(String((err as Error).message))) throw new BadRequestException("A folder cannot be moved into itself or its own subfolders");
    throw err;
  }

  async updateFolder(auth: AuthContext, id: string, input: z.infer<typeof folderPatchSchema>) {
    const { folder } = await this.folderAt(auth, id, "manage");
    const data: Prisma.DocFolderUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.ownerDeptId !== undefined) {
      if (input.ownerDeptId) await assertVisible(this.db.dept, [input.ownerDeptId], "department");
      data.ownerDeptId = input.ownerDeptId;
    }
    const next = input.classification ?? folder.classification;
    if (input.classification !== undefined && input.classification !== folder.classification) {
      if (RANK_CLASS[input.classification] < RANK_CLASS[folder.classification] && folder.classification === "confidential" && !input.confirm) {
        throw new ConflictException({ code: "CONFIRM_DECLASSIFY", message: "Lowering the classification of a confidential folder needs confirmation" });
      }
      data.classification = input.classification;
    }
    if (next === "confidential") {
      data.inheritAcl = false; // 机密：不继承、必记日志
      data.logAccess = true;
      if (input.previewOnly !== undefined) data.previewOnly = input.previewOnly;
    } else {
      if (input.inheritAcl !== undefined) data.inheritAcl = input.inheritAcl;
      if (input.logAccess !== undefined) data.logAccess = input.logAccess;
      data.previewOnly = false;
    }
    try {
      await this.db.docFolder.update({ where: { id }, data });
    } catch (err) {
      this.mapFolderError(err);
    }
    await this.log(auth, "folder.update", { folder, always: true, detail: { before: { name: folder.name, classification: folder.classification, inheritAcl: folder.inheritAcl }, changes: input } });
    return this.getFolder(auth, id);
  }

  /** 移动：需要对被移动的文件夹和目标位置都有管理级别；不能移进自己的子树；继承授权的先确认。 */
  async moveFolder(auth: AuthContext, id: string, targetParentId: string | null, confirm: boolean) {
    const { folder, access } = await this.folderAt(auth, id, "manage");
    if (targetParentId === null) {
      if (!auth.authz.perms.includes("doc:folder:root")) throw new ForbiddenException("Moving to the top level needs its own permission");
    } else {
      await this.folderAt(auth, targetParentId, "manage", access);
      const target = access.folders.get(targetParentId)!;
      if (target.ancestors.includes(id)) throw new BadRequestException("A folder cannot be moved into itself or its own subfolders");
    }
    if (folder.parentId === targetParentId) throw new ConflictException("The folder is already there");
    if (folder.inheritAcl && !confirm) throw new ConflictException({ code: "CONFIRM_INHERIT", message: "After the move this folder uses the access of its new location" });
    try {
      await this.db.docFolder.update({ where: { id }, data: { parentId: targetParentId } });
    } catch (err) {
      this.mapFolderError(err);
    }
    await this.log(auth, "folder.move", { folder, always: true, detail: { from: folder.parentId, to: targetParentId } });
    return this.getFolder(auth, id);
  }

  /** 删除：只能删空文件夹（没有子文件夹、没有文件）。 */
  async deleteFolder(auth: AuthContext, id: string) {
    const { folder } = await this.folderAt(auth, id, "manage");
    const [subs, files] = await Promise.all([this.db.docFolder.count({ where: { parentId: id } }), this.db.docFile.count({ where: { folderId: id, deletedAt: null } })]);
    if (subs || files) throw new ConflictException(`The folder is not empty (${subs} subfolders, ${files} files); empty it first`);
    await this.tenantDb.transaction(async (tx) => {
      const gone = await tx.docFile.findMany({ where: { folderId: id }, select: { id: true } });
      await tx.docFileVersion.deleteMany({ where: { fileId: { in: gone.map((g) => g.id) } } });
      await tx.docFile.deleteMany({ where: { folderId: id } });
      await tx.docUpload.deleteMany({ where: { folderId: id } });
      await tx.docAcl.deleteMany({ where: { folderId: id } });
      await tx.docFolder.delete({ where: { id } });
    });
    await this.log(auth, "folder.delete", { folder: { ...folder, id: null as never } as FolderRow, always: true, detail: { name: folder.name, folderId: id } });
    return { id };
  }

  // ------------------------------------------------------------ 授权
  async listAcl(auth: AuthContext, folderId: string) {
    const { folder } = await this.folderAt(auth, folderId, "manage");
    const rows = await this.db.docAcl.findMany({ where: { folderId }, orderBy: { grantedAt: "asc" } });
    const [depts, roles, accounts] = await Promise.all([
      this.db.dept.findMany({ where: { id: { in: rows.filter((r) => r.principalType === "dept").map((r) => r.principalId as string) } }, select: { id: true, name: true } }),
      this.db.role.findMany({ where: { id: { in: rows.filter((r) => r.principalType === "role").map((r) => r.principalId as string) } }, select: { id: true, name: true } }),
      this.db.account.findMany({ where: { id: { in: rows.filter((r) => r.principalType === "user").map((r) => r.principalId as string) } }, select: { id: true, username: true } }),
    ]);
    const name = (r: (typeof rows)[number]) => (r.principalType === "dept" ? depts.find((d) => d.id === r.principalId)?.name : r.principalType === "role" ? roles.find((x) => x.id === r.principalId)?.name : r.principalType === "user" ? accounts.find((x) => x.id === r.principalId)?.username : r.principalType === "everyone" ? "Everyone (incl. students)" : "All staff") ?? null;
    const now = Date.now();
    return {
      inheritAcl: folder.inheritAcl,
      items: rows.map((r) => ({ id: r.id, principalType: r.principalType, principalId: r.principalId, principalName: name(r), includeSub: r.includeSub, level: r.level, source: r.source, expiresAt: r.expiresAt, expired: !!r.expiresAt && r.expiresAt.getTime() <= now, grantedAt: r.grantedAt })),
    };
  }

  /** 授权对象选择器：管理授权的人不一定有"部门/角色/账号"管理菜单，所以这里单独给一个只读的候选列表。 */
  async principals(type: string, q?: string): Promise<Array<{ id: string; label: string }>> {
    const like = q?.trim() ? { contains: q.trim(), mode: "insensitive" as const } : undefined;
    if (type === "dept") return (await this.db.dept.findMany({ where: like ? { name: like } : undefined, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true } })).map((d) => ({ id: d.id, label: d.name }));
    if (type === "role") return (await this.db.role.findMany({ where: like ? { name: like } : undefined, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true } })).map((d) => ({ id: d.id, label: d.name }));
    if (type === "user") return (await this.db.account.findMany({ where: like ? { username: like } : undefined, orderBy: { username: "asc" }, take: 50, select: { id: true, username: true } })).map((d) => ({ id: d.id, label: d.username }));
    throw new BadRequestException("Unknown principal type");
  }

  async addAcl(auth: AuthContext, folderId: string, input: z.infer<typeof aclSchema>) {
    const { folder } = await this.folderAt(auth, folderId, "manage");
    const confidential = folder.classification === "confidential";
    if (confidential && (input.principalType === "everyone" || input.principalType === "all_staff")) throw new BadRequestException("A confidential folder is only for named departments, roles and people");
    if (input.principalType === "everyone" || input.principalType === "all_staff") input.principalId = null;
    else if (!input.principalId) throw new BadRequestException("Choose who the access is for");
    else if (input.principalType === "dept") await assertVisible(this.db.dept, [input.principalId], "department");
    else if (input.principalType === "role") await assertVisible(this.db.role, [input.principalId], "role");
    else await assertVisible(this.db.account, [input.principalId], "account");
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new BadRequestException("The end date must be in the future");
    const row = await this.db.docAcl.create({ data: { tenantId: auth.tenantId, folderId, principalType: input.principalType, principalId: input.principalId ?? null, includeSub: input.principalType === "dept" ? (input.includeSub ?? false) : false, level: input.level, source: "manual", expiresAt, grantedBy: auth.accountId } });
    await this.log(auth, "acl.add", { folder, always: true, detail: { principalType: input.principalType, principalId: input.principalId ?? null, level: input.level, expiresAt } });
    return row;
  }

  async removeAcl(auth: AuthContext, folderId: string, aclId: string) {
    const { folder } = await this.folderAt(auth, folderId, "manage");
    const row = await this.db.docAcl.findFirst({ where: { id: aclId, folderId } });
    if (!row) throw new NotFoundException();
    const now = new Date();
    const managers = await this.db.docAcl.count({ where: { folderId, level: "manage", id: { not: aclId }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    if (row.level === "manage" && managers === 0 && !(folder.inheritAcl && folder.parentId)) throw new ConflictException("This is the last manager of the folder; add another one first");
    await this.db.docAcl.delete({ where: { id: aclId } });
    await this.log(auth, "acl.remove", { folder, always: true, detail: { principalType: row.principalType, principalId: row.principalId, level: row.level } });
    return { id: aclId };
  }

  /** 管理员默认看不到机密文件夹：要先给自己授权。必须写原因，一定写访问日志和审计日志。 */
  async selfGrant(auth: AuthContext, folderId: string, input: { reason: string; level?: Level; expiresAt?: string | null }) {
    const folder = await this.db.docFolder.findUnique({ where: { id: folderId } });
    if (!folder) throw new NotFoundException();
    const level = input.level && input.level !== "none" ? input.level : "manage";
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new BadRequestException("The end date must be in the future");
    const row = await this.db.docAcl.create({ data: { tenantId: auth.tenantId, folderId, principalType: "user", principalId: auth.accountId, level, source: "manual", expiresAt, grantedBy: auth.accountId } });
    await this.log(auth, "acl.self_grant", { folder: folder as FolderRow, always: true, detail: { reason: input.reason, level, expiresAt } });
    await this.audit.record(auth.accountId, "doc.acl_self_grant", "folder", folderId, { reason: input.reason, level });
    return row;
  }

  async accessLog(auth: AuthContext, folderId: string) {
    await this.folderAt(auth, folderId, "manage");
    const rows = await this.db.docAccessLog.findMany({ where: { folderId }, orderBy: { createdAt: "desc" }, take: 200 });
    const accounts = new Map((await this.db.account.findMany({ where: { id: { in: rows.map((r) => r.accountId).filter(Boolean) as string[] } }, select: { id: true, username: true } })).map((a) => [a.id, a.username]));
    const files = new Map((await this.db.docFile.findMany({ where: { id: { in: rows.map((r) => r.fileId).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]));
    return rows.map((r) => ({ id: r.id, at: r.createdAt, action: r.action, username: r.accountId ? (accounts.get(r.accountId) ?? null) : null, fileId: r.fileId, fileName: r.fileId ? (files.get(r.fileId) ?? null) : null, detail: r.detail }));
  }

  // ------------------------------------------------------------ 文件
  async listFiles(auth: AuthContext, folderId: string) {
    const { folder, level } = await this.folderAt(auth, folderId, "view");
    const rows = await this.db.docFile.findMany({ where: { folderId, deletedAt: null }, orderBy: { name: "asc" } });
    const names = new Map((await this.db.account.findMany({ where: { id: { in: rows.map((r) => r.uploadedBy).filter(Boolean) as string[] } }, select: { id: true, username: true } })).map((a) => [a.id, a.username]));
    await this.log(auth, "folder.open", { folder });
    return rows.map((f) => ({
      id: f.id, name: f.name, size: f.size, contentType: f.contentType, version: f.version, uploadedBy: f.uploadedBy ? (names.get(f.uploadedBy) ?? null) : null, uploadedAt: f.uploadedAt, updatedAt: f.updatedAt,
      canDownload: !folder.previewOnly, canPreview: extOf(f.name) in INLINE_TYPES, canEdit: this.canTouch(level, f, auth), canDelete: this.canTouch(level, f, auth),
    }));
  }

  async requestUpload(auth: AuthContext, folderId: string, input: { name: string; size: number; contentType: string; fileId?: string }) {
    const { folder, level } = await this.folderAt(auth, folderId, "edit");
    const name = input.name.replace(/[\\/]/g, "_").trim().slice(-150);
    if (!name || !ALLOWED_EXTENSIONS.has(extOf(name))) throw new BadRequestException(`This file type is not allowed (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")})`);
    if (!Number.isInteger(input.size) || input.size <= 0) throw new BadRequestException("The file is empty");
    if (input.size > maxLibraryBytes()) throw new BadRequestException(`The file is larger than ${Math.floor(maxLibraryBytes() / 1024 / 1024)} MB`);
    await this.quota.assertCanStore(input.size);
    let target: string | null = null;
    if (input.fileId) {
      const file = await this.db.docFile.findFirst({ where: { id: input.fileId, folderId, deletedAt: null } });
      if (!file) throw new NotFoundException();
      if (!this.canTouch(level, file, auth)) throw new ForbiddenException("You can replace only the files you uploaded");
      target = file.id;
    }
    const key = `${tenantPrefix(auth.tenantId)}library/${folder.id}/${randomUUID()}/${safeKeyPart(name)}`;
    const up = await this.db.docUpload.create({ data: { tenantId: auth.tenantId, folderId, accountId: auth.accountId, fileId: target, storageKey: key, name, size: input.size, contentType: input.contentType.slice(0, 100) } });
    const signed = await this.store.presignUpload(key, up.contentType, up.size);
    return { uploadId: up.id, uploadUrl: signed.url, method: "PUT", headers: signed.headers, expiresInSeconds: signed.expiresInSeconds };
  }

  /** 浏览器传完以后确认：服务端核对对象存在且大小一致，再入库（新文件或已有文件的新版本）。 */
  async confirmUpload(auth: AuthContext, folderId: string, uploadId: string) {
    const { folder } = await this.folderAt(auth, folderId, "edit");
    const up = await this.db.docUpload.findFirst({ where: { id: uploadId, folderId, accountId: auth.accountId, usedAt: null } });
    if (!up) throw new NotFoundException();
    assertTenantKey(auth.tenantId, up.storageKey);
    const head = await this.store.head(up.storageKey);
    if (!head) throw new BadRequestException(`"${up.name}" was not uploaded`);
    if (head.size !== up.size) throw new BadRequestException(`"${up.name}" does not match the size you declared`);
    try {
      const fileId = await this.tenantDb.transaction(async (tx) => {
        let id = up.fileId;
        let version = 1;
        if (id) {
          const cur = await tx.docFile.findUniqueOrThrow({ where: { id } });
          version = cur.version + 1;
          await tx.docFile.update({ where: { id }, data: { storageKey: up.storageKey, size: up.size, contentType: up.contentType, version, uploadedAt: new Date() } });
        } else {
          const f = await tx.docFile.create({ data: { tenantId: auth.tenantId, folderId, name: up.name, storageKey: up.storageKey, size: up.size, contentType: up.contentType, version: 1, uploadedBy: auth.accountId } });
          id = f.id;
        }
        await tx.docFileVersion.create({ data: { tenantId: auth.tenantId, fileId: id, version, storageKey: up.storageKey, size: up.size, contentType: up.contentType, uploadedBy: auth.accountId } });
        await tx.docUpload.update({ where: { id: up.id }, data: { usedAt: new Date() } });
        return id;
      });
      await this.log(auth, up.fileId ? "file.new_version" : "file.upload", { folder, fileId, detail: { name: up.name, size: up.size } });
      await this.changed(fileId);
      return { id: fileId, name: up.name, version: up.fileId ? ((await this.db.docFile.findUnique({ where: { id: fileId } }))?.version ?? 1) : 1 };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002" || /doc_file_name_key/.test(String((err as Error).message))) throw new ConflictException(`A file named "${up.name}" already exists in this folder`);
      throw err;
    }
  }

  async download(auth: AuthContext, fileId: string) {
    const { file, folder } = await this.fileAt(auth, fileId, "view");
    if (folder.previewOnly) {
      await this.log(auth, "file.download_refused", { folder, fileId, detail: { reason: "view only" } });
      throw new ForbiddenException("This folder is view-only: open the file in the viewer instead");
    }
    await this.log(auth, "file.download", { folder, fileId });
    return { url: await this.store.presignDownload(file.storageKey, file.name), name: file.name, size: file.size };
  }

  async preview(auth: AuthContext, fileId: string) {
    const { file, folder } = await this.fileAt(auth, fileId, "view");
    const type = INLINE_TYPES[extOf(file.name)];
    if (!type) throw new BadRequestException("There is no online preview for this file type");
    await this.log(auth, "file.view", { folder, fileId });
    const viewer = auth.authz.personId ? ((await this.db.person.findUnique({ where: { id: auth.authz.personId }, select: { fullName: true } }))?.fullName ?? auth.authz.username) : auth.authz.username;
    // 机密文件夹：给前端一段水印文字（查看者姓名 + 时间），前端叠加在预览上
    return { url: await this.store.presignView(file.storageKey, file.name, type), name: file.name, contentType: type, viewOnly: folder.previewOnly, watermark: folder.classification === "confidential" ? `${viewer} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` : null };
  }

  async renameFile(auth: AuthContext, fileId: string, name: string) {
    const { file, folder, level } = await this.fileAt(auth, fileId, "edit");
    if (!this.canTouch(level, file, auth)) throw new ForbiddenException("You can rename only the files you uploaded");
    const clean = name.replace(/[\\/]/g, "_").trim().slice(-150);
    if (!clean || !ALLOWED_EXTENSIONS.has(extOf(clean))) throw new BadRequestException("This file type is not allowed");
    try {
      await this.db.docFile.update({ where: { id: fileId }, data: { name: clean } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002" || /doc_file_name_key/.test(String((err as Error).message))) throw new ConflictException("A file with that name already exists in this folder");
      throw err;
    }
    await this.log(auth, "file.rename", { folder, fileId, detail: { from: file.name, to: clean } });
    await this.changed(fileId);
    return { id: fileId, name: clean };
  }

  async deleteFile(auth: AuthContext, fileId: string) {
    const { file, folder, level } = await this.fileAt(auth, fileId, "edit");
    if (!this.canTouch(level, file, auth)) throw new ForbiddenException("You can delete only the files you uploaded");
    await this.db.docFile.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    await this.log(auth, "file.delete", { folder, fileId, detail: { name: file.name } });
    await this.changed(fileId);
    return { id: fileId };
  }

  /** 复制：源需要"查看/下载"，目标需要"编辑/上传"；仅在线查看的文件夹里的文件不能复制出去。 */
  async copyFile(auth: AuthContext, fileId: string, targetFolderId: string) {
    const { file, folder } = await this.fileAt(auth, fileId, "view");
    if (folder.previewOnly) throw new ForbiddenException("Files in a view-only folder cannot be copied out");
    const { folder: target } = await this.folderAt(auth, targetFolderId, "edit");
    const key = `${tenantPrefix(auth.tenantId)}library/${target.id}/${randomUUID()}/${safeKeyPart(file.name)}`;
    await this.store.copy(file.storageKey, key);
    try {
      const copy = await this.tenantDb.transaction(async (tx) => {
        const f = await tx.docFile.create({ data: { tenantId: auth.tenantId, folderId: target.id, name: file.name, storageKey: key, size: file.size, contentType: file.contentType, version: 1, uploadedBy: auth.accountId } });
        await tx.docFileVersion.create({ data: { tenantId: auth.tenantId, fileId: f.id, version: 1, storageKey: key, size: file.size, contentType: file.contentType, uploadedBy: auth.accountId } });
        return f;
      });
      await this.log(auth, "file.copy", { folder, fileId, detail: { to: target.id, copyId: copy.id } });
      await this.log(auth, "file.copy_in", { folder: target, fileId: copy.id, detail: { from: folder.id } });
      await this.changed(copy.id);
      return { id: copy.id, folderId: target.id, name: copy.name };
    } catch (err) {
      await this.store.remove(key).catch(() => undefined);
      if ((err as { code?: string }).code === "P2002" || /doc_file_name_key/.test(String((err as Error).message))) throw new ConflictException("A file with that name already exists in the target folder");
      throw err;
    }
  }

  /** 移动：源要能删除这个文件（编辑级别只能动自己的，管理级别任意），目标需要"编辑/上传"；从机密移到更低密级要管理级别并确认。 */
  async moveFile(auth: AuthContext, fileId: string, targetFolderId: string, confirm: boolean) {
    const { file, folder, level } = await this.fileAt(auth, fileId, "edit");
    if (!this.canTouch(level, file, auth)) throw new ForbiddenException("You can move only the files you uploaded");
    const { folder: target } = await this.folderAt(auth, targetFolderId, "edit");
    if (target.id === folder.id) throw new ConflictException("The file is already in that folder");
    if (folder.classification === "confidential" && RANK_CLASS[target.classification] < RANK_CLASS.confidential) {
      if (!atLeast(level, "manage")) throw new ForbiddenException("Moving a file out of a confidential folder needs the manage level");
      if (!confirm) throw new ConflictException({ code: "CONFIRM_DECLASSIFY", message: "The target folder has a lower classification" });
    }
    try {
      await this.db.docFile.update({ where: { id: fileId }, data: { folderId: target.id } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002" || /doc_file_name_key/.test(String((err as Error).message))) throw new ConflictException("A file with that name already exists in the target folder");
      throw err;
    }
    await this.log(auth, "file.move", { folder, fileId, detail: { to: target.id } });
    await this.log(auth, "file.move_in", { folder: target, fileId, detail: { from: folder.id } });
    await this.changed(fileId);
    return { id: fileId, folderId: target.id };
  }

  async versions(auth: AuthContext, fileId: string) {
    await this.fileAt(auth, fileId, "view");
    const rows = await this.db.docFileVersion.findMany({ where: { fileId }, orderBy: { version: "desc" } });
    return rows.map((v) => ({ version: v.version, size: v.size, uploadedAt: v.uploadedAt }));
  }
}
