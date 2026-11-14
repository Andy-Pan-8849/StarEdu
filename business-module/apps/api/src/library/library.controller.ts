// 文档库接口：管理后台（api/library）和学生/成员门户的只读一侧（api/portal/library）。
// 先查"操作权限"（菜单按钮），文件夹上的访问级别在 LibraryService 里再查一次。
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { aclSchema, folderPatchSchema, folderSchema, LibraryService } from "./library.service";

const moveSchema = z.object({ targetId: z.string().uuid().nullable(), confirm: z.boolean().optional() });
const fileMoveSchema = z.object({ targetId: z.string().uuid(), confirm: z.boolean().optional() });
const copySchema = z.object({ targetId: z.string().uuid() });
const renameSchema = z.object({ name: z.string().min(1).max(160) });
const uploadSchema = z.object({ name: z.string().min(1).max(200), size: z.number().int().positive(), contentType: z.string().max(100).default("application/octet-stream"), fileId: z.string().uuid().optional() });
const confirmSchema = z.object({ uploadId: z.string().uuid() });
const selfGrantSchema = z.object({ reason: z.string().trim().min(5).max(500), level: z.enum(["view", "edit", "manage"]).optional(), expiresAt: z.string().datetime().nullable().optional() });

@Controller("api/library")
export class LibraryController {
  constructor(private readonly lib: LibraryService) {}

  @Get("folders")
  @RequirePermissions(PERMS.docLibraryList)
  folders(@Auth() auth: AuthContext) {
    return this.lib.listFolders(auth);
  }

  @Post("folders")
  @RequirePermissions(PERMS.docFolderAdd)
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.lib.createFolder(auth, parse(folderSchema, body));
  }

  @Get("folders/:id")
  @RequirePermissions(PERMS.docLibraryList)
  folder(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.getFolder(auth, id);
  }

  @Patch("folders/:id")
  @RequirePermissions(PERMS.docFolderEdit)
  update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.lib.updateFolder(auth, id, parse(folderPatchSchema, body));
  }

  @Post("folders/:id/move")
  @RequirePermissions(PERMS.docFolderMove)
  move(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(moveSchema, body);
    return this.lib.moveFolder(auth, id, b.targetId, b.confirm ?? false);
  }

  @Delete("folders/:id")
  @RequirePermissions(PERMS.docFolderRemove)
  remove(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.deleteFolder(auth, id);
  }

  // ---- 授权
  @Get("folders/:id/acl")
  @RequirePermissions(PERMS.docAclEdit)
  acl(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.listAcl(auth, id);
  }

  @Post("folders/:id/acl")
  @RequirePermissions(PERMS.docAclEdit)
  addAcl(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.lib.addAcl(auth, id, parse(aclSchema, body));
  }

  @Delete("folders/:id/acl/:aclId")
  @RequirePermissions(PERMS.docAclEdit)
  removeAcl(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Param("aclId", ParseUUIDPipe) aclId: string) {
    return this.lib.removeAcl(auth, id, aclId);
  }

  @Post("folders/:id/self-grant")
  @RequirePermissions(PERMS.docAclSelfGrant)
  selfGrant(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.lib.selfGrant(auth, id, parse(selfGrantSchema, body));
  }

  @Get("principals")
  @RequirePermissions(PERMS.docAclEdit)
  principals(@Query() query: { type?: string; q?: string }) {
    return this.lib.principals(query.type ?? "", query.q);
  }

  @Get("folders/:id/log")
  @RequirePermissions(PERMS.docLogList)
  log(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.accessLog(auth, id);
  }

  // ---- 文件
  @Get("folders/:id/files")
  @RequirePermissions(PERMS.docLibraryList)
  files(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.listFiles(auth, id);
  }

  @Post("folders/:id/uploads")
  @RequirePermissions(PERMS.docFileUpload)
  upload(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.lib.requestUpload(auth, id, parse(uploadSchema, body));
  }

  @Post("folders/:id/uploads/confirm")
  @RequirePermissions(PERMS.docFileUpload)
  confirm(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.lib.confirmUpload(auth, id, parse(confirmSchema, body).uploadId);
  }

  @Get("files/:id/download")
  @RequirePermissions(PERMS.docFileDownload)
  download(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.download(auth, id);
  }

  @Get("files/:id/preview")
  @RequirePermissions(PERMS.docLibraryList)
  preview(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.preview(auth, id);
  }

  @Get("files/:id/versions")
  @RequirePermissions(PERMS.docLibraryList)
  versions(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.versions(auth, id);
  }

  @Patch("files/:id")
  @RequirePermissions(PERMS.docFileEdit)
  rename(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.lib.renameFile(auth, id, parse(renameSchema, body).name);
  }

  @Delete("files/:id")
  @RequirePermissions(PERMS.docFileDelete)
  removeFile(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.deleteFile(auth, id);
  }

  @Post("files/:id/copy")
  @RequirePermissions(PERMS.docFileUpload)
  copy(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.lib.copyFile(auth, id, parse(copySchema, body).targetId);
  }

  @Post("files/:id/move")
  @RequirePermissions(PERMS.docFileEdit)
  moveFile(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(fileMoveSchema, body);
    return this.lib.moveFile(auth, id, b.targetId, b.confirm ?? false);
  }
}

/** 门户只读：只看得到 everyone 授权的公开文件夹（学生没有员工身份，其他授权都匹配不上）。 */
@Controller("api/portal/library")
export class PortalLibraryController {
  constructor(private readonly lib: LibraryService) {}

  @Get("folders")
  @RequirePermissions(PERMS.portalLibraryList)
  folders(@Auth() auth: AuthContext) {
    return this.lib.listFolders(auth);
  }

  @Get("folders/:id/files")
  @RequirePermissions(PERMS.portalLibraryList)
  files(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.listFiles(auth, id);
  }

  @Get("files/:id/download")
  @RequirePermissions(PERMS.portalLibraryDownload)
  download(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.download(auth, id);
  }

  @Get("files/:id/preview")
  @RequirePermissions(PERMS.portalLibraryList)
  preview(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.lib.preview(auth, id);
  }
}
