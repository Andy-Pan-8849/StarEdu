import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { loadConfig } from "./config/config";

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Swagger 文档页：开发环境默认开，生产默认关（SWAGGER_ENABLED=true 才开）；页面本身不做访问控制，所以生产不要随便开
  if (config.SWAGGER_ENABLED === "true" || (config.SWAGGER_ENABLED === undefined && process.env.NODE_ENV !== "production")) {
    SwaggerModule.setup("api-docs", app, SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("StarEdu business API").setVersion("1").addBearerAuth().build()));
  }
  await app.listen(config.API_PORT);
}

void bootstrap();
