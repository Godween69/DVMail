import "reflect-metadata";
import { createApp } from "./bootstrap";

async function main() {
  const { app, cfg } = await createApp();
  await app.listen(cfg.port, cfg.host); // в контейнере HOST=0.0.0.0, наружу порт не публикуется
}
main();
