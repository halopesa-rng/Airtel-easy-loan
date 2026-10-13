# HaloPesa Loan Application Workflow

This build uses HaloPesa-related wording for the intended disbursement workflow, while clearly identifying the portal as an independent loan application portal. It must not be presented as an official HaloPesa/Halotel service without authorization.

Customer flow: phone number + application PIN → loan details → administrator approval → first verification code → second confirmation code → approved/disbursing confirmation.

Never collect or request a customer's real HaloPesa/mobile-money PIN or transaction OTP in this application.

# Loan Application Portal

The customer flow is:

1. Enter **phone number + application PIN** (a portal/application PIN only — never a HaloPesa PIN).
2. Select loan amount and repayment period.
3. Submit and **await authorized administrator approval**.
4. After approval, enter the first **portal verification code**.
5. Enter the second **final confirmation code**.
6. Show the congratulations/disbursement-processing screen.

The server stores PINs and codes as hashes and clears one-time codes after successful use.

## Important safety note

This application must not collect a real HaloPesa PIN, HaloPesa transaction PIN, or official financial-service OTP. Use an application-specific PIN and portal-generated codes only. For real disbursement, integrate the lender and payment provider's authorized APIs and follow their security requirements.

## Run

```bash
npm install
cp .env.example .env
npm start
```

For development only, `DEV_SHOW_CODES=true` can display generated portal codes in the UI. Set it to `false` in production and connect an authorized SMS provider.

## Telegram approval

Set `TELEGRAM_BOT_TOKEN` and comma-separated `TELEGRAM_ADMIN_IDS`. Authorized administrators receive an application notification with Approve/Reject buttons.

## Production checklist

- HTTPS
- `DEV_SHOW_CODES=false`
- Authorized SMS provider
- Strong admin authentication
- Proper audit logging
- Official lender/payment APIs for actual disbursement
- Never request or store a customer's HaloPesa PIN or transaction OTP


## Updated 3-page approval flow

1. Page 1: customer enters phone number + application PIN. The application is created using `DEFAULT_LOAN_AMOUNT` and `DEFAULT_TERM_MONTHS`, then waits for authorized admin approval.
2. After admin approval: Page 2 opens for the application code.
3. After the application code is verified: Page 3 shows the approved loan amount and asks for the loan amount confirmation code.
4. Successful confirmation changes the application to `DISBURSEMENT_PROCESSING`.

Environment variables:
- `DEFAULT_LOAN_AMOUNT` (default `1000000`)
- `DEFAULT_TERM_MONTHS` (default `3`)


## Fix for "Unable to create the application right now"

The application requires PostgreSQL in production. Set `DATABASE_URL` to the connection string for the PostgreSQL database attached to the deployment. The server now reports a clear configuration error instead of a generic failure.

For local testing only, set `DEMO_MODE=true`. This uses a local JSON file and is not suitable for real loan records or production disbursement. Keep `DEMO_MODE=false` in production.


## Deployment fixes

- Static assets are served from `public/`, so `styles.css` and `app.js` load correctly in production.
- The Telegram polling conflict (`ETELEGRAM 409`) means more than one process is polling the same bot token. Run polling in only one live service. Set `TELEGRAM_POLLING=false` on any duplicate/secondary service.
- Keep exactly one active Render service/worker using the bot token when using polling.


## Telegram admin roles
Set these Render environment variables for the Telegram approval bot:
- `TELEGRAM_BOT_TOKEN` — bot token.
- `TELEGRAM_BOT_USERNAME` — bot username without `@`, used to generate individual admin links.
- `TELEGRAM_ADMIN_IDS` — comma-separated initial administrator Telegram IDs.
- `TELEGRAM_SUPER_ADMIN_IDS` — comma-separated super-admin Telegram IDs.

The bot now assigns new applications to one active administrator and sends that administrator the approval buttons. Super-admins can use `/all` to see all applications, `/admins` to list admins, `/addadmin ID` to add an admin and receive an individual link, `/revoke ID` to disable an admin, `/restore ID` to restore one, and `/notify ID message` to send a notification. Admins can use `/mine` to see applications assigned to them.

Verification/security codes are not exposed to administrators.


## Telegram review buttons update

Each application notification now has two primary actions on the first row:
- **APPROVE**
- **REJECT**

A separate second row shows the error action appropriate to the current stage:
- Initial application: **WRONG ID**
- Code 1 review: **WRONG CODE 1**
- Code 2 review: **WRONG CODE 2**
- Final amount review: **WRONG AMOUNT**

The bot notification intentionally does not include the applicant's PIN or entered verification codes. This is an independent loan-application portal, not an official HaloPesa service. Only portal-specific PINs and codes should be entered; never request real mobile-money PINs or financial-service OTPs.
