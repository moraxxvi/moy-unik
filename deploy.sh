#!/bin/sh
# Заливает изменения в Apps Script (учебный аккаунт, вход "uni") и обновляет веб-приложение.
# Ссылка при этом не меняется.
cd "$(dirname "$0")"
npx -y @google/clasp@3.4.1 --user uni push --force &&
npx -y @google/clasp@3.4.1 --user uni update-deployment AKfycby-Ww6pXreoO-F4dpcBei7p4X3oklc11Y8vd3jqa8zkyIA8hGajjMEU1PA8iUyVxwICBQ --description "${1:-update}"
