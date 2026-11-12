// Nest 里使用的 Keycloak 管理客户端：管理令牌很快过期（默认约 1 分钟），所以按需重新连接。
import { Injectable } from "@nestjs/common";
import { KeycloakAdmin } from "./keycloak-admin";

const MAX_AGE_MS = 30_000;

@Injectable()
export class KeycloakService {
  private admin: KeycloakAdmin | null = null;
  private connectedAt = 0;

  async client(): Promise<KeycloakAdmin> {
    if (!this.admin || Date.now() - this.connectedAt > MAX_AGE_MS) {
      this.admin = await KeycloakAdmin.connect();
      this.connectedAt = Date.now();
    }
    return this.admin;
  }
}
