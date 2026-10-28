import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function main() {
  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().disable("x-powered-by"); // не рассказываем, на чём работаем
  await app.listen(3000, "127.0.0.1"); // только локально: наружу выходит через Caddy и туннель
}
main();
