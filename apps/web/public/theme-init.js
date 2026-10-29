// Применяет сохранённую тему до отрисовки страницы (без вспышки). Отдельный файл: встроенные скрипты запрещены политикой.
(function () {
  try {
    var t = localStorage.getItem("dvmail-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) { /* хранилище может быть недоступно: тогда тема по настройке системы */ }
})();
