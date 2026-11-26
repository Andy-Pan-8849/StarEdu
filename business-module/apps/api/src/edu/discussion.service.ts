// 班级讨论（最简版）：发帖、回复、置顶、标记已解决、删除；相关的人收到通知（经出站箱）。
//   - 谁能写：该班的任课教师，和"已选课且学籍为在读"的学生；班级结课、取消后只读。教务和休学的学生可以看，不能写。
//   - 置顶：只有任课教师；标记已解决：发帖人或任课教师；删除：自己的帖子/回复，任课教师可以删任何（软删除）。
//   - 回复只有一层（不能回复回复）。
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { OutboxService } from "./outbox.service";

export interface DiscussionActor {
  /** 没有人员记录的账号（如内置管理员）为 null：只能看 */
  personId: string | null;
  instructor: boolean;
  /** 已选课（enrolled）且学籍在读的学生 */
  activeStudent: boolean;
}

const LIMITS = { title: 200, body: 5000 };

export interface AllThread {
  id: string;
  section: { id: string; name: string };
  title: string | null;
  author: { personId: string; name: string | null; role: string };
  pinned: boolean;
  resolved: boolean;
  createdAt: Date;
  replyCount: number;
  lastActivityAt: Date;
  unread: boolean;
}

@Injectable()
export class DiscussionService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 班级是否还能写（开放选课或进行中）。 */
  private async writable(sectionId: string, actor: DiscussionActor): Promise<void> {
    if (!actor.personId) throw new ForbiddenException("Only the section's instructors and enrolled students can write here");
    const s = await this.db.section.findUnique({ where: { id: sectionId }, select: { status: true } });
    if (!s) throw new NotFoundException();
    if (s.status !== "open" && s.status !== "in_progress") throw new ConflictException(`The section is ${s.status}; the discussion is read-only`);
    if (!(actor.instructor || actor.activeStudent)) throw new ForbiddenException("Only the section's instructors and enrolled students can write here");
  }

  private async names(personIds: string[], sectionId: string) {
    const [people, teachers] = await Promise.all([this.db.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true } }), this.db.sectionInstructor.findMany({ where: { sectionId }, select: { personId: true } })]);
    const teacher = new Set(teachers.map((t) => t.personId));
    return (id: string) => ({ personId: id, name: people.find((p) => p.id === id)?.fullName ?? null, role: teacher.has(id) ? "instructor" : "student" });
  }

  private flags(p: { authorPersonId: string }, actor: DiscussionActor, isThread: boolean, writable: boolean) {
    const mine = !!actor.personId && p.authorPersonId === actor.personId;
    return { canDelete: writable && (mine || actor.instructor), canResolve: writable && isThread && (mine || actor.instructor), canPin: writable && isThread && actor.instructor, canReply: writable && isThread };
  }

  private async isWritable(sectionId: string, actor: DiscussionActor): Promise<boolean> {
    const s = await this.db.section.findUnique({ where: { id: sectionId }, select: { status: true } });
    return !!actor.personId && (actor.instructor || actor.activeStudent) && (s?.status === "open" || s?.status === "in_progress");
  }

  /**
   * 某人在一批讨论帖里哪些是未读：帖子（根帖）里有"别人"在我上次打开之后的发言——别人发的根帖本身，或别人的回复——
   * 就是未读；我自己发的话不算。没有人员记录的账号（如内置管理员）不记已读，一律不算未读。
   */
  private async unreadOf(personId: string | null, rows: Array<{ id: string; parentId: string | null; authorPersonId: string; createdAt: Date }>): Promise<Set<string>> {
    if (!personId) return new Set();
    const reads = new Map((await this.db.discussionRead.findMany({ where: { personId, threadId: { in: rows.filter((r) => !r.parentId).map((r) => r.id) } } })).map((r) => [r.threadId, r.lastReadAt]));
    const out = new Set<string>();
    for (const t of rows.filter((r) => !r.parentId)) {
      const others = [t, ...rows.filter((r) => r.parentId === t.id)].filter((r) => r.authorPersonId !== personId);
      if (others.length === 0) continue;
      const lastOther = Math.max(...others.map((r) => r.createdAt.getTime()));
      const read = reads.get(t.id);
      if (!read || read.getTime() < lastOther) out.add(t.id);
    }
    return out;
  }

  /** 帖子列表：置顶的在前，其余按最近活动（最后一条回复或发帖时间）从新到旧。 */
  async list(sectionId: string, actor: DiscussionActor) {
    const rows = await this.db.discussionPost.findMany({ where: { sectionId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const threads = rows.filter((r) => !r.parentId);
    const who = await this.names([...new Set(rows.map((r) => r.authorPersonId))], sectionId);
    const writable = await this.isWritable(sectionId, actor);
    const unread = await this.unreadOf(actor.personId, rows);
    return threads
      .map((t) => {
        const replies = rows.filter((r) => r.parentId === t.id);
        const last = replies.length ? replies[replies.length - 1].createdAt : t.createdAt;
        return { id: t.id, title: t.title, body: t.body, author: who(t.authorPersonId), pinned: t.pinned, resolved: t.resolved, createdAt: t.createdAt, replyCount: replies.length, lastActivityAt: last, unread: unread.has(t.id), ...this.flags(t, actor, true, writable) };
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }

  /**
   * 我所有班级里的讨论（学生的"讨论"页默认看全部）：未读的排在最前（再按最近活动从新到旧），其余按最近活动排；
   * 每条带上班级名，方便在一张表里直接看全部。
   */
  async listAll(sections: Array<{ id: string; name: string }>, actor: DiscussionActor) {
    const rows = await this.db.discussionPost.findMany({ where: { sectionId: { in: sections.map((x) => x.id) }, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const unread = await this.unreadOf(actor.personId, rows);
    const out: AllThread[] = [];
    for (const section of sections) {
      const inSection = rows.filter((r) => r.sectionId === section.id);
      if (inSection.length === 0) continue;
      const who = await this.names([...new Set(inSection.map((r) => r.authorPersonId))], section.id);
      for (const t of inSection.filter((r) => !r.parentId)) {
        const replies = inSection.filter((r) => r.parentId === t.id);
        const last = replies.length ? replies[replies.length - 1].createdAt : t.createdAt;
        out.push({ id: t.id, section, title: t.title, author: who(t.authorPersonId), pinned: t.pinned, resolved: t.resolved, createdAt: t.createdAt, replyCount: replies.length, lastActivityAt: last, unread: unread.has(t.id) });
      }
    }
    const perSection = sections.map((x) => ({ id: x.id, name: x.name, unread: out.filter((t) => t.section.id === x.id && t.unread).length }));
    out.sort((a, b) => Number(b.unread) - Number(a.unread) || b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
    return { sections: perSection, threads: out, unread: out.filter((t) => t.unread).length };
  }

  /** 打开一个帖子就算读过了（记下时间）；没有人员记录的账号不记。 */
  private async markRead(tenantId: string, actor: DiscussionActor, threadId: string): Promise<void> {
    if (!actor.personId) return;
    await this.db.discussionRead.upsert({
      where: { personId_threadId: { personId: actor.personId, threadId } },
      create: { tenantId, personId: actor.personId, threadId },
      update: { lastReadAt: new Date() },
    });
  }

  async get(sectionId: string, postId: string, actor: DiscussionActor) {
    const t = await this.db.discussionPost.findFirst({ where: { id: postId, sectionId, parentId: null, deletedAt: null } });
    if (!t) throw new NotFoundException();
    await this.markRead(t.tenantId, actor, t.id); // 打开就算读过
    const replies = await this.db.discussionPost.findMany({ where: { parentId: postId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const who = await this.names([...new Set([t.authorPersonId, ...replies.map((r) => r.authorPersonId)])], sectionId);
    const writable = await this.isWritable(sectionId, actor);
    return {
      id: t.id, title: t.title, body: t.body, author: who(t.authorPersonId), pinned: t.pinned, resolved: t.resolved, createdAt: t.createdAt, ...this.flags(t, actor, true, writable),
      replies: replies.map((r) => ({ id: r.id, body: r.body, author: who(r.authorPersonId), createdAt: r.createdAt, ...this.flags(r, actor, false, writable) })),
    };
  }

  async create(auth: { tenantId: string }, sectionId: string, actor: DiscussionActor, input: { title: string; body: string }) {
    await this.writable(sectionId, actor);
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || title.length > LIMITS.title) throw new BadRequestException(`The title needs 1 to ${LIMITS.title} characters`);
    if (!body || body.length > LIMITS.body) throw new BadRequestException(`The text needs 1 to ${LIMITS.body} characters`);
    const post = await this.db.discussionPost.create({ data: { tenantId: auth.tenantId, sectionId, authorPersonId: actor.personId as string, title, body } });
    await this.outbox.emit("discussion.posted", { postId: post.id, sectionId, authorPersonId: actor.personId });
    return this.get(sectionId, post.id, actor);
  }

  async reply(auth: { tenantId: string }, sectionId: string, threadId: string, actor: DiscussionActor, bodyText: string) {
    await this.writable(sectionId, actor);
    const thread = await this.db.discussionPost.findFirst({ where: { id: threadId, sectionId, parentId: null, deletedAt: null } });
    if (!thread) throw new NotFoundException();
    const body = bodyText.trim();
    if (!body || body.length > LIMITS.body) throw new BadRequestException(`The text needs 1 to ${LIMITS.body} characters`);
    const reply = await this.db.discussionPost.create({ data: { tenantId: auth.tenantId, sectionId, parentId: threadId, authorPersonId: actor.personId as string, body } });
    await this.outbox.emit("discussion.replied", { postId: threadId, replyId: reply.id, sectionId, authorPersonId: actor.personId });
    return this.get(sectionId, threadId, actor);
  }

  async pin(sectionId: string, threadId: string, actor: DiscussionActor, pinned: boolean) {
    await this.writable(sectionId, actor);
    if (!actor.instructor) throw new ForbiddenException("Only the section's instructors can pin");
    const { count } = await this.db.discussionPost.updateMany({ where: { id: threadId, sectionId, parentId: null, deletedAt: null }, data: { pinned } });
    if (!count) throw new NotFoundException();
    return this.get(sectionId, threadId, actor);
  }

  async resolve(sectionId: string, threadId: string, actor: DiscussionActor, resolved: boolean) {
    await this.writable(sectionId, actor);
    const t = await this.db.discussionPost.findFirst({ where: { id: threadId, sectionId, parentId: null, deletedAt: null } });
    if (!t) throw new NotFoundException();
    if (!actor.instructor && t.authorPersonId !== actor.personId) throw new ForbiddenException("Only the author or an instructor can mark it as solved");
    if (t.resolved !== resolved) {
      await this.db.discussionPost.update({ where: { id: threadId }, data: { resolved } });
      if (resolved && t.authorPersonId !== actor.personId) await this.outbox.emit("discussion.resolved", { postId: threadId, sectionId, resolverPersonId: actor.personId });
    }
    return this.get(sectionId, threadId, actor);
  }

  async remove(sectionId: string, postId: string, actor: DiscussionActor) {
    await this.writable(sectionId, actor);
    const p = await this.db.discussionPost.findFirst({ where: { id: postId, sectionId, deletedAt: null } });
    if (!p) throw new NotFoundException();
    if (!actor.instructor && p.authorPersonId !== actor.personId) throw new ForbiddenException("You can delete your own posts only");
    await this.db.discussionPost.update({ where: { id: postId }, data: { deletedAt: new Date() } });
    return { id: postId };
  }
}
