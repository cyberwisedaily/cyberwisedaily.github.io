# CyberWiseDaily — Setup

This site is **100% free to run**. No paid plans, no Anthropic enterprise keys, no SendGrid.
The moving parts:

| Layer            | Service          | Why it's free                                            |
| ---------------- | ---------------- | -------------------------------------------------------- |
| Hosting          | GitHub Pages     | Free for public repos                                    |
| Daily cron + CI  | GitHub Actions   | Free minutes on public repos                             |
| Threat data      | CISA KEV + NVD   | Public US-gov APIs, no auth                              |
| Subscriber DB    | Google Sheet     | Free                                                     |
| Email sending    | Gmail via Apps Script (`MailApp`) | ~100 recipients/day on consumer Gmail, free |
| Web backend      | Google Apps Script web app | Free                                          |

End-to-end flow every morning at 06:00 UTC:

```
GitHub Actions cron
   ├── runs scripts/fetch_intel.py
   │      └── pulls CISA KEV + NVD → writes data/intel.json → commits
   └── POSTs intel.json to your Apps Script /exec endpoint
          └── reads Subscribers sheet → MailApp.sendEmail → done
```

The static page reads `data/intel.json` on every load, so it always shows the latest brief.

---

## 1. Drop the files into your repo

```
cyberwisedaily/
├── index.html
├── data/intel.json
├── scripts/
│   ├── fetch_intel.py
│   └── requirements.txt
├── apps-script/
│   ├── Code.gs
│   └── appsscript.json
├── .github/workflows/daily-intel.yml
└── SETUP.md
```

Commit and push. Then in repo **Settings → Pages**, set **Source = `main` branch / root**.
Your site goes live at `https://<user>.github.io/<repo>/`.

At this point the page already works — it'll show the seed data in `data/intel.json` and the
subscribe form will say "Subscribe endpoint not configured." Now wire up the backend.

---

## 2. Create the Google Sheet (subscriber DB)

1. Open [sheets.new](https://sheets.new).
2. Rename the first tab to **`Subscribers`**.
3. In row 1 add headers: `email | subscribed_at | status`
4. From the URL, copy the long ID:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

---

## 3. Deploy the Apps Script web app

1. Open [script.new](https://script.new). Name the project "CyberWiseDaily".
2. Replace the contents of `Code.gs` with `apps-script/Code.gs` from this repo.
3. Click ⚙ **Project Settings → Show "appsscript.json" manifest file in editor**, then paste
   `apps-script/appsscript.json` over the existing one.
4. In `Code.gs`, set the two constants at the top:
   ```js
   const SHEET_ID = "...your sheet id from step 2...";
   const SITE_URL = "https://<your-user>.github.io/<your-repo>/";
   ```
5. **Project Settings → Script properties → Add property**:
   - Name: `BROADCAST_SECRET`
   - Value: any long random string — e.g. `openssl rand -hex 32` output. **Save it**, you'll
     paste it into GitHub in step 5.
6. **Deploy → New deployment**:
   - Type: **Web app**
   - Description: `cyberwisedaily v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then **Authorize access** (grant the Gmail + Sheets scopes).
7. Copy the **Web app URL** — it looks like
   `https://script.google.com/macros/s/AKfycb.../exec`.

> Every time you change `Code.gs` you must redeploy ("Manage deployments → ✎ → New version").
> Otherwise the live URL keeps serving the old code.

---

## 4. Wire the subscribe form to Apps Script

Open `index.html`, find the `CONFIG` block near the bottom, and paste your URL:

```js
const CONFIG = {
  SUBSCRIBE_URL: "https://script.google.com/macros/s/AKfycb.../exec",
  INTEL_JSON_PATH: "data/intel.json"
};
```

Commit and push. The Subscribe button now writes to your Google Sheet **and** sends a real
welcome email from your Gmail account.

---

## 5. Wire the daily broadcast (GitHub Actions → Apps Script)

In the repo **Settings → Secrets and variables → Actions → New repository secret**, add **two**
secrets:

| Name                | Value                                                          |
| ------------------- | -------------------------------------------------------------- |
| `BROADCAST_URL`     | Same Apps Script `/exec` URL from step 3                       |
| `BROADCAST_SECRET`  | Exactly the value you saved in Apps Script Properties          |

That's it. The workflow at `.github/workflows/daily-intel.yml` already reads these.

---

## 6. Smoke test

1. Go to **Actions → Daily Intel Refresh → Run workflow** (manual dispatch). It should:
   - Refresh `data/intel.json` with live CISA KEV + NVD data.
   - Commit the change to `main`.
   - POST to your Apps Script and email every active subscriber.
2. Open your GitHub Pages URL — the briefing cards now show real CVE IDs and the threat
   counter is non-zero.
3. Subscribe with your own email through the form. You should:
   - Land a row in the `Subscribers` sheet within a couple of seconds.
   - Receive a welcome email from your Gmail address.

If any step fails, the Actions log and the Apps Script "Executions" panel both have full
stack traces.

---

## Notes, limits, gotchas

- **Email cap.** Consumer Gmail allows ~100 recipients per day from Apps Script's `MailApp`.
  Google Workspace accounts get ~1500/day. For larger lists, either switch to a Workspace
  account or replace `MailApp.sendEmail` in `Code.gs` with a free transactional provider's
  HTTP API (Mailgun, Brevo, Resend — all have free tiers).
- **Apps Script URL changes after every deployment** unless you redeploy as a new *version*
  of the **same** deployment. Use "Manage deployments → ✎" to keep the URL stable.
- **CORS.** The frontend uses `application/x-www-form-urlencoded`, which Apps Script handles
  cleanly without preflight. Don't switch to `application/json` — it'll fail in the browser.
- **NVD rate limits.** The fetcher uses the free unauthenticated endpoint (~5 req/30s).
  Plenty for one daily call. If you scale up, get a free NVD API key.
- **GitHub Actions cron drift.** Scheduled workflows on free runners can be delayed up to
  ~10 min. Your "06:00 brief" may actually land 06:00–06:10. That's the trade-off for free.
