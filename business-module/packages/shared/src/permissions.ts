// 权限码（权限字符）：格式 `模块:资源:动作`。后端 @RequirePermissions 和前端按钮显示用同一份常量。
// 隐藏按钮只是方便，接口每次都校验。
export const PERMS = {
  // 系统管理
  userList: "system:user:list",
  userAdd: "system:user:add",
  userEdit: "system:user:edit",
  userAssignRole: "system:user:assignRole",
  userReconcile: "system:user:reconcile",
  roleList: "system:role:list",
  roleAdd: "system:role:add",
  roleEdit: "system:role:edit",
  roleRemove: "system:role:remove",
  roleAuthorize: "system:role:authorize",
  menuList: "system:menu:list",
  menuAdd: "system:menu:add",
  menuEdit: "system:menu:edit",
  menuRemove: "system:menu:remove",
  entryList: "system:entry:list",
  entryEdit: "system:entry:edit",
  dataScopeList: "system:dataScope:list",
  dataScopeAdd: "system:dataScope:add",
  dataScopeEdit: "system:dataScope:edit",
  dataScopeRemove: "system:dataScope:remove",
  userResetPwd: "system:user:resetPwd",
  deptList: "system:dept:list",
  deptAdd: "system:dept:add",
  deptEdit: "system:dept:edit",
  deptRemove: "system:dept:remove",
  campusList: "system:campus:list",
  campusAdd: "system:campus:add",
  campusEdit: "system:campus:edit",
  /** 校区状态变更（停止新增、关闭、重新开放）：危险操作，单独权限 */
  campusClose: "system:campus:close",
  postList: "system:post:list",
  postAdd: "system:post:add",
  postEdit: "system:post:edit",
  postRemove: "system:post:remove",
  dictList: "system:dict:list",
  dictAdd: "system:dict:add",
  dictEdit: "system:dict:edit",
  dictRemove: "system:dict:remove",
  paramList: "system:param:list",
  paramAdd: "system:param:add",
  paramEdit: "system:param:edit",
  paramRemove: "system:param:remove",
  operationLogList: "system:operationLog:list",
  /** 清空操作日志：单独权限 */
  operationLogClear: "system:operationLog:clear",
  onlineList: "system:online:list",
  onlineForceLogout: "system:online:forceLogout",
  loginLogList: "system:loginLog:list",
  auditLogList: "system:auditLog:list",
  // 平台入口（平台域的账号才有；与租户权限互不相通）
  platformTenantList: "platform:tenant:list",
  platformTenantAdd: "platform:tenant:add",
  platformTenantEdit: "platform:tenant:edit",
  platformTenantStatus: "platform:tenant:status",
  platformTenantGrant: "platform:tenant:grant",
  platformTenantAdmin: "platform:tenant:admin",
  platformAccountList: "platform:account:list",
  platformAccountAdd: "platform:account:add",
  platformAccountEdit: "platform:account:edit",
  platformAccountAssignRole: "platform:account:assignRole",
  platformRoleList: "platform:role:list",
  platformRoleAdd: "platform:role:add",
  platformRoleEdit: "platform:role:edit",
  platformRoleRemove: "platform:role:remove",
  platformRoleAuthorize: "platform:role:authorize",
  platformMenuList: "platform:menu:list",
  platformMenuEdit: "platform:menu:edit",
  platformEntryList: "platform:entry:list",
  platformEntryEdit: "platform:entry:edit",
  platformMonitorList: "platform:monitor:list",
  platformJobList: "platform:job:list",
  platformJobEdit: "platform:job:edit",
  platformJobRun: "platform:job:run",
  platformLogList: "platform:log:list",
  platformAnnouncementList: "platform:announcement:list",
  platformAnnouncementEdit: "platform:announcement:edit",
  // 人事
  hrPersonList: "hr:person:list",
  hrPersonEdit: "hr:person:edit",
  /** 敏感信息：出生日期、性别、证件号、个人电话、住址 */
  hrPersonSensitive: "hr:person:sensitive",
  /** 紧急联系人：查看和修改都写访问日志 */
  hrEmergencyView: "hr:emergency:view",
  hrEmergencyEdit: "hr:emergency:edit",
  hrStaffList: "hr:staff:list",
  hrStaffAdd: "hr:staff:add",
  hrStaffEdit: "hr:staff:edit",
  hrStaffAssign: "hr:staff:assign",
  hrStaffEnd: "hr:staff:end",
  hrStaffImport: "hr:staff:import",
  hrStudentList: "hr:student:list",
  hrStudentAdd: "hr:student:add",
  hrStudentEdit: "hr:student:edit",
  hrStudentImport: "hr:student:import",
  // 教学
  eduTermList: "edu:term:list",
  eduTermAdd: "edu:term:add",
  eduTermEdit: "edu:term:edit",
  eduMajorList: "edu:major:list",
  eduMajorAdd: "edu:major:add",
  eduMajorEdit: "edu:major:edit",
  eduCourseList: "edu:course:list",
  eduCourseAdd: "edu:course:add",
  eduCourseEdit: "edu:course:edit",
  eduSectionList: "edu:section:list",
  eduSectionAdd: "edu:section:add",
  /** 改班级的结构信息（容量、校区、教师……）：教务才有，任课教师没有 */
  eduSectionEdit: "edu:section:edit",
  /** 班级状态：开放选课、开课、结课、取消 */
  eduSectionStatus: "edu:section:status",
  eduEnrollmentList: "edu:enrollment:list",
  /** 教务代选/特批 */
  eduEnrollmentAdd: "edu:enrollment:add",
  eduEnrollmentRemove: "edu:enrollment:remove",
  /** 课件：任课教师增删改 */
  eduMaterialEdit: "edu:material:edit",
  /** 作业：看班级的作业、分组、评分标准 */
  eduAssignmentList: "edu:assignment:list",
  /** 作业：任课教师建、改、删、发布，管分组和评分标准 */
  eduAssignmentEdit: "edu:assignment:edit",
  /** 看提交（含文件） */
  eduSubmissionList: "edu:submission:list",
  /** 批改、发布分数：只有任课教师 */
  eduSubmissionGrade: "edu:submission:grade",
  /** 给某个学生的某次作业延期：任课教师或教务 */
  eduExtensionEdit: "edu:extension:edit",
  /** 成绩册、成绩构成、导出：任课教师和教务（在范围内） */
  eduGradeList: "edu:grade:list",
  /** 改成绩构成权重、手工录分、算总评、发布最终成绩：只有任课教师 */
  eduGradeEdit: "edu:grade:edit",
  /** 结课后改成绩：教务，要填原因，记改前改后 */
  eduGradeAmend: "edu:grade:amend",
  eduScaleList: "edu:scale:list",
  eduScaleEdit: "edu:scale:edit",
  eduTranscriptList: "edu:transcript:list",
  /** 生成正式版成绩单（带编号，写日志） */
  eduTranscriptIssue: "edu:transcript:issue",
  eduDashboardView: "edu:dashboard:view",
  /** 班级讨论：任课教师和教务能看 */
  eduDiscussionList: "edu:discussion:list",
  /** 任课教师发帖、回复、置顶、标记已解决、删除 */
  eduDiscussionEdit: "edu:discussion:edit",
  // 文档库：操作权限；文件夹上的访问级别另有 ACL（两者都满足才行）
  docLibraryList: "doc:library:list",
  docFolderAdd: "doc:folder:add",
  /** 建顶层文件夹 */
  docFolderRoot: "doc:folder:root",
  docFolderEdit: "doc:folder:edit",
  docFolderMove: "doc:folder:move",
  docFolderRemove: "doc:folder:remove",
  docFileUpload: "doc:file:upload",
  docFileDownload: "doc:file:download",
  /** 重命名、换新版本、复制、移动文件 */
  docFileEdit: "doc:file:edit",
  docFileDelete: "doc:file:delete",
  docAclEdit: "doc:acl:edit",
  /** 给自己授权访问某个文件夹（管理员默认看不到机密文件夹；这个动作一定写访问日志） */
  docAclSelfGrant: "doc:acl:selfgrant",
  docLogList: "doc:log:list",
  // 消息
  msgAnnouncementList: "msg:announcement:list",
  /** 发布公告：范围在自己的数据范围内（全公司、校区或班级） */
  msgAnnouncementAdd: "msg:announcement:add",
  msgAnnouncementRemove: "msg:announcement:remove",
  // 学生门户
  portalEnrollList: "portal:enroll:list",
  portalEnrollAdd: "portal:enroll:add",
  portalEnrollDrop: "portal:enroll:drop",
  portalPlanView: "portal:plan:view",
  portalAssignmentList: "portal:assignment:list",
  portalAssignmentSubmit: "portal:assignment:submit",
  portalDiscussionList: "portal:discussion:list",
  portalDiscussionPost: "portal:discussion:post",
  portalLibraryList: "portal:library:list",
  portalLibraryDownload: "portal:library:download",
  portalGradeList: "portal:grade:list",
  portalTranscriptDownload: "portal:transcript:download",
} as const;

export type Permission = (typeof PERMS)[keyof typeof PERMS];

export const PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z0-9]*:[a-z][a-zA-Z0-9]*$/;
