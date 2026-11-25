# Cloudflare timer for the charger sites (about 10 minutes)

GitHub's own schedules run hours late or not at all, so a small free Cloudflare Worker starts the workflows instead:
- every 15 minutes: live plug status, plus the Portugal and France deploys
- every day at 04:17 UTC: Madeira's chargers and prices refresh

## 1. GitHub token (only allowed to start workflows)
1. Open https://github.com/settings/personal-access-tokens/new (a **fine-grained** token).
2. **Token name:** `charger-timer`. **Expiration:** the longest it offers (or "No expiration"). If it expires, set a calendar reminder to renew it.
3. **Resource owner:** PartyTrix.
4. **Repository access:** *Only select repositories*. Pick `madeira-chargers`, `chargeportugal` and `chargefrance`.
5. **Permissions → Repository permissions → Actions:** *Read and write*. Leave everything else as it is. Metadata turns on as read-only by itself.
6. **Generate token**, then copy it. It starts with `github_pat_`.

## 2. Create the Worker
1. Cloudflare dashboard, then **Workers & Pages → Create → Create Worker** ("Hello World").
2. Name it `charger-timer`, then **Deploy**.
3. **Edit code**: replace everything with the contents of [charger-timer.js](charger-timer.js), then **Deploy**.

## 3. Add the token as a secret
Worker → **Settings → Variables and Secrets → Add**:
- **Type:** Secret
- **Name:** `GITHUB_TOKEN`
- **Value:** the token from step 1

Then **Deploy**.

## 4. Add the two timers
Worker → **Settings → Trigger Events → Add → Cron Triggers**. Add each of these exactly as written:
- `*/15 * * * *`
- `17 4 * * *`

## 5. Check it works
After 15 minutes, open https://github.com/PartyTrix/chargefrance/actions. New runs should show **workflow_dispatch** as the trigger. You can also look in the Worker's **Logs**: each line should end in `204`.
- `401`: the token was pasted wrongly.
- `403` or `404`: the token is missing a repository or the Actions permission.

The workflows have no GitHub schedule of their own: this Worker is their only timer.
