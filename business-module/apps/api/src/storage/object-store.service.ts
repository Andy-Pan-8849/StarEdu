// 对象存储（S3 接口；本地是 MinIO 兼容的 silo）。代码只依赖 S3 API，换云上的 S3 只改环境变量。
// 上传：服务端发预签名地址，浏览器直接传给对象存储（文件不经过 NestJS）；提交时服务端用 HEAD 确认对象存在且大小一致。
// 键一律以 tenant/<租户 id>/ 开头，并在取用前核对前缀：一个租户的键换不出另一个租户的文件。
import { BadRequestException, Injectable } from "@nestjs/common";
import { CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const UPLOAD_URL_TTL_SECONDS = 600;
export const DOWNLOAD_URL_TTL_SECONDS = 300;

/** 允许上传的扩展名（按名字判断；内容类型由客户端声明，不可信，不用于放行）。 */
export const ALLOWED_EXTENSIONS = new Set([
  "pdf", "zip", "txt", "md", "csv", "json", "png", "jpg", "jpeg", "gif", "docx", "pptx", "xlsx", "ipynb",
  "py", "java", "ts", "js", "html", "css", "sql", "c", "cpp", "go", "rs",
]);

export function maxUploadBytes(): number {
  const n = Number(process.env.UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 20 * 1024 * 1024;
}

/** 校验文件名、大小；通过时返回规范化后的文件名。 */
export function validateUpload(input: { fileName: string; size: number }): string {
  const name = [...input.fileName].map((c) => (c === "/" || c === "\\" || c.charCodeAt(0) < 32 ? "_" : c)).join("").trim().slice(-150);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!name || !ALLOWED_EXTENSIONS.has(ext)) throw new BadRequestException(`This file type is not allowed (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")})`);
  if (!Number.isInteger(input.size) || input.size <= 0) throw new BadRequestException("The file is empty");
  if (input.size > maxUploadBytes()) throw new BadRequestException(`The file is larger than ${Math.floor(maxUploadBytes() / 1024 / 1024)} MB`);
  return name;
}

/** 键里只放安全字符。 */
export const safeKeyPart = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100);

export const tenantPrefix = (tenantId: string): string => `tenant/${tenantId}/`;

/** 键必须在本租户的前缀下，且不含 ..。 */
export function assertTenantKey(tenantId: string, key: string): void {
  if (!key.startsWith(tenantPrefix(tenantId)) || key.split("/").includes("..")) throw new BadRequestException("Invalid storage key");
}

@Injectable()
export class ObjectStoreService {
  private internal: S3Client | null = null;
  private external: S3Client | null = null;
  private bucketReady: Promise<void> | null = null;

  private make(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? "starit", secretAccessKey: process.env.S3_SECRET_KEY ?? "starit-secret" },
    });
  }

  private get client(): S3Client {
    return (this.internal ??= this.make(process.env.S3_ENDPOINT_URL ?? "http://localhost:9100"));
  }

  /** 签预签名地址用：浏览器能访问到的对象存储地址（默认和服务端用的相同）。 */
  private get signer(): S3Client {
    return (this.external ??= this.make(process.env.S3_PUBLIC_ENDPOINT_URL ?? process.env.S3_ENDPOINT_URL ?? "http://localhost:9100"));
  }

  private get bucket(): string {
    return process.env.S3_BUCKET ?? "starit-biz";
  }

  /** 桶不存在就建（本地和演示；生产里桶由部署建好，没有建桶权限也不报错）。 */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        try {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        } catch {
          // 并发创建或没有权限：后面的读写会给出真正的错误
        }
      }
    })();
    return this.bucketReady;
  }

  async presignUpload(key: string, contentType: string, size: number): Promise<{ url: string; headers: Record<string, string>; expiresInSeconds: number }> {
    await this.ensureBucket();
    const url = await getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: UPLOAD_URL_TTL_SECONDS });
    return { url, headers: { "content-type": contentType }, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
  }

  async presignDownload(key: string, fileName: string): Promise<string> {
    await this.ensureBucket();
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` }), { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  }

  /** 在线预览：用 inline 展示（不是附件），并指定内容类型；地址很快过期。 */
  async presignView(key: string, fileName: string, contentType: string): Promise<string> {
    await this.ensureBucket();
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(fileName)}` }), { expiresIn: 120 });
  }

  /** 服务端复制一个对象（不经过浏览器）。 */
  async copy(sourceKey: string, targetKey: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: targetKey, CopySource: `${this.bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}` }));
  }

  /** 对象存在就返回大小，不存在返回 null。 */
  async head(key: string): Promise<{ size: number } | null> {
    await this.ensureBucket();
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** 服务端读出整个对象（知识库入库用；文件大小在上传时已限制）。 */
  async get(key: string): Promise<Buffer> {
    await this.ensureBucket();
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  /** 服务端直接写入（演示数据和测试用）。 */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
}
