#!/bin/zsh
# Двойной клик по этому файлу запускает «Мой уник» и открывает его в браузере.
cd "$(dirname "$0")"

# Если Node не виден, подгружаем его из nvm.
if ! command -v node >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установи его с https://nodejs.org и запусти снова."
  read -k 1 "?Нажми любую клавишу, чтобы закрыть."
  exit 1
fi

# Если уже запущено — просто открываем страницу.
if curl -s -o /dev/null "http://localhost:8787/"; then
  open "http://localhost:8787/"
  exit 0
fi

(sleep 1 && open "http://localhost:8787/") &
echo "Не закрывай это окно, пока пользуешься страницей."
node server.js
