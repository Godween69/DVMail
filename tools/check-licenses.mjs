// Проверка лицензий зависимостей, которые попадут в приложение (dev-инструменты не считаются).
// Строго разрешены: MIT, BSD, Apache-2.0, MPL-2.0. Лицензии «как MIT» (ISC и подобные)
// допускаются, но каждая показана в списке. Всё остальное: ошибка (код выхода 1).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STRICT = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "MPL-2.0"]);
const SIMILAR = new Set(["ISC", "0BSD", "CC0-1.0", "Unlicense", "BlueOak-1.0.0"]);

// класс части выражения: 2 строго, 1 «как MIT», 0 не разрешено
const cls = (id) => (STRICT.has(id) ? 2 : SIMILAR.has(id) ? 1 : 0);
// SPDX: «A OR B» достаточно одной, «A AND B» нужны обе
function rank(expr) {
  const groups = expr.replace(/[()]/g, "").split(/\s+OR\s+/);
  return Math.max(...groups.map((g) => Math.min(...g.split(/\s+AND\s+/).map((p) => cls(p.trim())))));
}

let listing;
try {
  listing = execSync("npm ls --omit=dev --all --parseable", { maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }).toString();
} catch (e) {
  listing = e.stdout ? e.stdout.toString() : "";
}
const seen = new Map();
for (const dir of listing.split("\n").filter(Boolean)) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { continue; }
  if (!pkg.name || pkg.name.startsWith("@dvmail/") || pkg.name === "dvmail") continue; // свои пакеты
  const lic = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? pkg.licenses?.[0]?.type ?? "НЕТ";
  seen.set(pkg.name + "@" + pkg.version, lic);
}
if (seen.size === 0) { console.error("Ошибка: не найдено ни одной зависимости (выполнен ли npm install?)"); process.exit(1); }

const count = {}, similar = [], bad = [];
for (const [name, lic] of seen) {
  count[lic] = (count[lic] ?? 0) + 1;
  const r = rank(lic);
  if (r === 1) similar.push(name + "  " + lic);
  if (r === 0) bad.push(name + "  " + lic);
}
console.log("Зависимостей в приложении:", seen.size);
for (const [lic, n] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log("  " + lic + ": " + n);
if (similar.length) console.log("\nДопущены как «похожие на MIT» (проверь глазами):\n  " + similar.join("\n  "));
if (bad.length) { console.log("\nНЕ РАЗРЕШЕНО:\n  " + bad.join("\n  ")); process.exit(1); }
console.log("\nЛицензии в порядке.");
