# Orange-inspired Botswana application demo

Independent demonstration portal; not an official Orange or Max it service. It must not be used to collect OTPs, PINs, passwords, or private account messages.

## Features
- Compact, single-page application form: full name, Botswana phone number, 4-digit non-secret application reference ID, and amount requested in pula.
- Initial Telegram review message contains only the application phone number and 4-digit reference ID, with Approve/Reject actions.
- Rejection returns the applicant to a cleared form for a fresh attempt.
- Approval reveals a separate box for non-secret application reference text. Admin approval then shows a congratulations page.
- Super Admin commands: `/addadmin CHAT_ID ADMIN003`, `/revokeadmin CHAT_ID`, `/admins`, `/stats`.
- Admin commands: `/mylink`, `/pending`, `/stats`, `/myinfo`.
- Personal links use `?admin=ADMIN003`, e.g. `https://your-service.onrender.com/?admin=ADMIN003`.
- Telegram webhook is configured automatically at startup using `APP_BASE_URL` and `TELEGRAM_BOT_TOKEN`; endpoint is `/telegram/webhook`. Callback queries are acknowledged immediately so slow database updates are less likely to trigger Telegram’s “try again later” message. Successful decisions remove the inline buttons and confirm the saved status. Do not run another service that sets a webhook for the same bot token.
- Uses uniquely named `orange_demo_*` database tables.

## Render environment
Set `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `SUPER_ADMIN_CHAT_ID`, and `APP_BASE_URL` to this portal's own public HTTPS Render URL. `ADMIN_CHAT_IDS` is optional. `TELEGRAM_WEBHOOK_SECRET` is optional; when omitted, the app derives a stable secret from the bot token. Deploy/restart after setting these values, then check `/health` and Render logs for `Telegram webhook configured`.

The `?admin=ADMIN003` parameter must match an active admin code in the database. The base domain in each personal link must be the URL where this portal is actually deployed; do not point it at a different service unless this project is deployed there.


Branding note: this is an independent demonstration interface and is not affiliated with or endorsed by MTN or MTN MoMo. Never enter PINs, passwords, or one-time passcodes. The reference step accepts only a non-sensitive four-digit reference number.
