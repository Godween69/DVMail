import { useEffect, useRef, useState } from "react";
import { ApiError, type Challenge } from "./api";
import { QrCode } from "./QrCode";

interface Props {
  challenge: Challenge;
  // Опрос сервера: «pending» ждём, «done» подтверждено (родитель сам идёт дальше), «failed» запрос отменён.
  poll: () => Promise<"pending" | "done" | "failed">;
  onRetry: () => void;
  intro: string;
}

// QR-код и число для подтверждения в DVChat. Страница сама спрашивает сервер раз в две секунды.
export function ChallengePanel({ challenge, poll, onRetry, intro }: Props) {
  const [left, setLeft] = useState(challenge.expiresIn);
  const [state, setState] = useState<"wait" | "failed" | "expired">("wait");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    const end = Date.now() + challenge.expiresIn * 1000;
    let stop = false;
    const tick = window.setInterval(() => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { stop = true; setState((st) => (st === "wait" ? "expired" : st)); }
    }, 500);
    const ask = window.setInterval(async () => {
      if (stop) return;
      try {
        const r = await pollRef.current();
        if (stop) return;
        if (r === "done") stop = true;
        else if (r === "failed") { stop = true; setState("failed"); }
      } catch (e) {
        stop = true;
        setError(e instanceof ApiError ? e.message : "Не удалось проверить подтверждение");
        setState("failed");
      }
    }, 2000);
    return () => { stop = true; window.clearInterval(tick); window.clearInterval(ask); };
  }, [challenge]);

  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

  if (state !== "wait") {
    return (
      <div className="chal">
        <p className="warn-box" role="alert">{error ?? (state === "expired" ? "Время вышло. Покажите код заново." : "Запрос отменён. Покажите код заново.")}</p>
        <button type="button" className="btn primary" onClick={onRetry}>Показать новый код</button>
      </div>
    );
  }

  return (
    <div className="chal">
      <p className="muted">{intro}</p>
      <QrCode value={challenge.qr} label="QR-код для подтверждения в DVChat" />
      <p className="muted">Приложение попросит ввести число:</p>
      <p className="chal-number" aria-label={`Число для ввода: ${challenge.number.split("").join(" ")}`}>{challenge.number}</p>
      <p className="muted chal-wait"><span className="spinner dim" aria-hidden="true" /> Ждём подтверждения · {mm}</p>
      {/* На телефоне QR самому себе не показать: кнопка открывает DVChat прямо по ссылке. */}
      <a className="btn ghost small chal-open" href={challenge.qr}>Открыть в DVChat</a>
    </div>
  );
}
