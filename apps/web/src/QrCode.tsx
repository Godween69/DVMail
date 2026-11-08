import { useMemo } from "react";
import { qrModules, qrPath } from "./qr";

// QR-код как SVG. Фон всегда белый, а модули тёмные, даже в тёмной теме: так его читают камеры.
// Размер задаётся атрибутами (встроенные стили запрещены политикой страницы).
export function QrCode({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const m = qrModules(value);
    return { n: m.length, d: qrPath(m) };
  }, [value]);
  const quiet = 3; // белое поле вокруг (по стандарту 4, для экрана хватает 3)
  return (
    <svg className="qr" role="img" aria-label={label} viewBox={`${-quiet} ${-quiet} ${n + quiet * 2} ${n + quiet * 2}`} width={size} height={size} shapeRendering="crispEdges">
      <rect x={-quiet} y={-quiet} width={n + quiet * 2} height={n + quiet * 2} fill="#ffffff" />
      <path d={d} fill="#111827" />
    </svg>
  );
}
