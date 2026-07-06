# Backlog — 2026-07-05 — SSH GitHub Cloudflare Bootstrap

**Сессия:** настройка SSH-доступа к GitHub, клонирование 10 репозиториев dasexperten, встраивание CF Cloud Master в AGENTS.md для авто-загрузки в каждой новой сессии.

---

## ✅ Выполнено в этой сессии

### 1. SSH-ключ для GitHub
- [x] Найден приватный ключ `id_ed25519_github_pc` в `Downloads\Telegram Desktop\` (оригинальный путь `Desktop\` не сработал — файла там не было)
- [x] Перемещён в `~/.ssh/id_ed25519_github`
- [x] Записан публичный ключ в `~/.ssh/id_ed25519_github.pub` (97 байт, формат `ssh-ed25519 ... dasexperten@pc`)
- [x] NTFS-права ограничены: `icacls /inheritance:r` + `/grant:r "$USER:(R)"` на оба файла (private + public + config)
- [x] Проверена аутентификация: `ssh -T git@github.com` → `Hi dasexperten! You've successfully authenticated`

### 2. SSH config для GitHub
- [x] Создан `~/.ssh/config` с блоком:
  ```
  Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_github
    IdentitiesOnly yes
  ```
- [x] Права read-only на config
- [x] Проверка: `ssh -T git@github.com` (без `-i`) работает через config

### 3. Git → Windows OpenSSH (критичный фикс)
- [x] **Проблема:** git использует собственный ssh (`C:\Program Files\Git\usr\bin\ssh.exe`, OpenSSL 3.5.5), который выбрасывает `error in libcrypto` на этом ключе. Windows OpenSSH 9.5p1 (LibreSSL) читает ключ нормально.
- [x] **Решение:** `git config --global core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"`
- [x] Проверка: `git ls-remote git@github.com:dasexperten/SKILLS.git` отдаёт SHA — соединение живое.

### 4. Клонирование 10 репозиториев в `C:\Users\user\Projects\`
- [x] das-architektura
- [x] dasoperator
- [x] dasexperten.com
- [x] SKILLS
- [x] das-coder
- [x] yandex-pay-watcher
- [x] imager-bridge
- [x] emailer
- [x] dasexperten-tg
- [x] das-agents

**Команда для воспроизведения** (если папка потеряна):
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\Projects" | Out-Null
Set-Location "$env:USERPROFILE\Projects"
$repos = 'das-architektura','dasoperator','dasexperten.com','SKILLS','das-coder','yandex-pay-watcher','imager-bridge','emailer','dasexperten-tg','das-agents'
foreach ($r in $repos) { git clone "git@github.com:dasexperten/$r.git" }
```

### 5. CF Cloud Master inline в AGENTS.md
- [x] В `AGENTS.md` добавлена секция **00. SESSION BOOT** — обязательный стартовый шаг в каждой сессии
- [x] CF Cloud Master вшит прямо в AGENTS.md как inline fallback (Account ID + Token + Auth Header + API base + Dashboard URL)
- [x] Правило: если `SECRETS/cloudflare.md` доступен — приоритет у файла, расхождение → сообщаю Aram-у для обновления AGENTS.md
- [x] Правило: AGENTS.md **не коммитить** в git-репозитории (dasexperten/das-architektura и пр.) — только локальный файл в CoWork
- [x] Сверены 5 точек отказа:
  1. AGENTS.md существует (25 640 байт) ✅
  2. CF Cloud Master в строках 14-15 ✅
  3. Токен в AGENTS.md совпадает с `SECRETS/cloudflare.md` ✅
  4. `SECRETS\index.md` и `SECRETS\cloudflare.md` существуют ✅
  5. Токен живой на сервере CF: `GET /accounts/{id}` → `success: True`, аккаунт `Dasexperten@gmail.com's Account` ✅

---

## ⚠️ Не сделано / TODO на будущие сессии

### Поддержка / обслуживание
- [ ] **Ротация токенов** — проверить в `SECRETS/index.md` секцию **Token Rotation**, сверить сроки с сегодняшней датой (2026-07-05). CF Workers Edit уже мёртв с 2026-06-12 — пометить как revoked или удалить строку из `cloudflare.md`.
- [ ] **`gh` CLI не залогинен** — `gh auth status` возвращает «not logged in». Если понадобится `gh repo clone` / `gh pr` / `gh issue` → запустить `gh auth login` (браузерный OAuth) или подсунуть PAT через `gh auth login --with-token`.
- [ ] **Backup SSH-ключа** — `~/.ssh/id_ed25519_github` существует только на этой машине. Если переустанавливаешь Windows / переезжаешь — ключ нужно перенести вместе с папкой CoWork. Альтернатива: положить копию в зашифрованный backup (НЕ в публичный репо).

### Безопасность
- [ ] **Master-токен в plain text** — CF Cloud Master имеет account-wide scope (создание/удаление Workers, R2, D1, DNS, Pages). В AGENTS.md + `SECRETS/cloudflare.md` лежит в открытом виде. Защита = NTFS-права на папку CoWork + Windows-логин. Рассмотреть узкие scoped-токены под каждую задачу (Workers-deploy-only, R2-only, D1-only) через `curl /user/tokens` — дольше, но риск ниже.
- [ ] **Зона dasexperten.com удалена Cloudflare-ом** (2026-07-02 — nameservers не переключены с Wix за 4 недели). Если понадобится CF email routing на .com — зону re-add и переключить NS (конфликт с Wix-хостингом, решать отдельно).

### Проектные TODO (не из этой сессии, но выявлены попутно)
- [ ] Сверить список Workers в `SECRETS/cloudflare.md` с актуальным `GET /accounts/{id}/workers/scripts` — есть ли дрейф (новые/удалённые).
- [ ] Проверить, что `dasoperator`-репо в `Projects/` синхронизируется с `git pull` без конфликтов (репозиторий большой — 1801+ файлов).

---

## 🔑 Ключевые артефакты этой сессии

| Файл | Путь | Назначение |
|---|---|---|
| Приватный SSH-ключ | `C:\Users\user\.ssh\id_ed25519_github` | Доступ к GitHub как `dasexperten` |
| Публичный SSH-ключ | `C:\Users\user\.ssh\id_ed25519_github.pub` | Для добавления на новые хосты/GitHub-аккаунты |
| SSH config | `C:\Users\user\.ssh\config` | Авто-подстановка ключа для `git@github.com` |
| Git global config | `~/.gitconfig` → `core.sshCommand` | Использовать Windows OpenSSH, не собственный git-ssh |
| AGENTS.md (обновлён) | `C:\Users\user\Documents\CoWork\AGENTS.md` | SESSION BOOT + inline CF Cloud Master |
| 10 клонированных репо | `C:\Users\user\Projects\` | Локальные копии всех репозиториев dasexperten |

---

## 📌 Воспроизведение всей сессии с нуля (disaster recovery)

Если переустанавливаешь Windows / переезжаешь на новую машину:

```powershell
# 1. Положить приватный ключ в ~/.ssh/id_ed25519_github (ASCII, 412 байт, OpenSSH format)
# 2. Положить публичный ключ в ~/.ssh/id_ed25519_github.pub
# 3. Ограничить права
icacls "$env:USERPROFILE\.ssh\id_ed25519_github" /inheritance:r
icacls "$env:USERPROFILE\.ssh\id_ed25519_github" /grant:r "$($env:USERNAME):(R)"
icacls "$env:USERPROFILE\.ssh\id_ed25519_github.pub" /inheritance:r /grant:r "$($env:USERNAME):(R)"

# 4. Создать ~/.ssh/config с GitHub-блоком
Add-Content -Path "$env:USERPROFILE\.ssh\config" -Value @"

Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
"@
icacls "$env:USERPROFILE\.ssh\config" /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null

# 5. Переключить git на Windows OpenSSH (иначе error in libcrypto)
git config --global core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"

# 6. Проверка
ssh -T git@github.com  # → Hi dasexperten!

# 7. Клонировать 10 репо (см. блок 4 выше)

# 8. Убедиться, что CoWork-папка на месте (включая AGENTS.md с секцией 00 и SECRETS/)
#    — токен CF Cloud Master автоматически в контексте каждой новой сессии opencode
```

---

**Сессия закрыта:** 2026-07-05
**Статус:** ✅ полностью выполнено, TODO зафиксированы
