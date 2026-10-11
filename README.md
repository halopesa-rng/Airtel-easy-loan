# Congo Loan application + Telegram approval system

Independent Congo Loan branding with red/white styling. This is not an official Airtel product. It provides customer application submission, persistent PostgreSQL storage, a password-protected admin dashboard, Telegram notifications, and Telegram Approve/Reject buttons. It does not request mobile-money PINs, passwords, or one-time authentication codes.

## Deploy on Render
1. Push this folder to a private GitHub repository.
2. In Render, create a Blueprint and select the repository; `render.yaml` creates a web service and PostgreSQL database.
3. Set `ADMIN_PASSWORD` to a strong unique password.
4. Create a Telegram bot with BotFather. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the Render service environment. The bot must be able to message the configured chat; for a group, add the bot and use the group chat ID.
5. Redeploy after setting environment variables. Check `/health`.

## Telegram callback setup
The webhook endpoint is `/telegram/webhook`. To use inline Telegram buttons, configure the bot webhook to `https://YOUR-SERVICE.onrender.com/telegram/webhook`. Optionally set `TELEGRAM_WEBHOOK_SECRET` and configure the same secret with Telegram's `secret_token`. Example (replace placeholders):

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR-SERVICE.onrender.com/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

If webhook is not configured, notifications still arrive but inline buttons will not complete decisions; use the admin dashboard. For production, restrict access to the admin portal further (VPN/IP allowlist or SSO), rotate secrets, and add rate limiting/monitoring.

## Flow
Customer submits full name, phone, amount and four-digit numeric reference → server saves as `PENDING` → Telegram and admin dashboard receive the application → authorized admin approves/rejects → customer status page refreshes every five seconds. Decision updates are idempotent.
