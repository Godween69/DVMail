import qrcode from "qrcode-generator";

// Матрица QR-кода: true = тёмный модуль. Уровень коррекции M (около 15%): хватает для экрана, код остаётся небольшим.
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M"); // 0: версию (размер) подобрать по длине текста
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

// Путь SVG: подряд идущие тёмные модули строки склеиваются в один прямоугольник, файл получается компактным.
export function qrPath(modules: boolean[][]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x++; continue; }
      const start = x;
      while (x < row.length && row[x]) x++;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return parts.join("");
}
