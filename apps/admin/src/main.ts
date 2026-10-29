import "reflect-metadata";
import { createApp } from "./bootstrap";

async function main() {
  const { app, cfg } = await createApp();
  await app.listen(cfg.port, cfg.host); // в контейнере HOST=0.0.0.0; наружу порт публикуется только на 127.0.0.1 мини-ПК
}
main().catch((e) => {
  console.error(String(e?.message ?? e)); // секретов в тексте ошибок нет
  process.exit(1);
});
