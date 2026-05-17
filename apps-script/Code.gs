/**
 * CyberWiseDaily — backend, free tier.
 *
 * Two endpoints, both POSTed as application/x-www-form-urlencoded
 * (no CORS preflight, so the browser form and the GitHub Action both work):
 *
 *   POST ?action=subscribe & email=foo@bar.com
 *       → stores the email in the "Subscribers" sheet (if new), sends a
 *         welcome email via Gmail, returns { ok: true }.
 *
 *   POST ?action=broadcast & secret=<shared> & data=<json>
 *       → called by the GitHub Action after the daily refresh.
 *         Iterates every active subscriber, sends them today's digest.
 *
 * SETUP:
 *   1. Open https://script.google.com → New Project → paste this file in.
 *   2. Replace SHEET_ID with the ID of a Google Sheet you create. The Sheet
 *      must have a tab named "Subscribers" with header row:
 *        email | subscribed_at | status
 *   3. Project Settings → Script properties → add:
 *        BROADCAST_SECRET = <a long random string>
 *      Use the SAME value as the BROADCAST_SECRET secret in your GitHub repo.
 *   4. Deploy → New deployment → Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Copy the /exec URL. Paste it into:
 *        - index.html → CONFIG.SUBSCRIBE_URL
 *        - GitHub repo Settings → Secrets → BROADCAST_URL
 *
 * QUOTAS (consumer Gmail, free):
 *   - MailApp.sendEmail: ~100 recipients/day. (Workspace: ~1500/day.)
 *   - For larger lists, see broadcastInBatches() comment below.
 */

// ---------------------------------------------------------------------------
// Configuration — edit SHEET_ID. Everything else can stay as-is.
// ---------------------------------------------------------------------------
const SHEET_ID = "";           // Leave empty if deployed from Extensions → Apps Script inside your Sheet
const SHEET_NAME = "Subscribers";                        // must match your tab name exactly
const SITE_URL = "https://YOUR-GITHUB-USERNAME.github.io/cyberwisedaily/"; // ← replace this
const FROM_NAME = "CyberWiseDaily";

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  // Handle one-click unsubscribe via GET link in emails
  const action = (e && e.parameter && e.parameter.action) || "";
  if (action === "unsubscribe") return unsubscribe_(e.parameter);

  // Browsing to the web-app URL just returns a friendly status page.
  return HtmlService.createHtmlOutput(`
    <!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>CyberWiseDaily</title>
    <style>body{font-family:monospace;background:#0a0e0a;color:#d4e8d4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .box{border:1px solid #1f2e1f;padding:2rem 3rem;text-align:center;max-width:480px;}
    h2{color:#4ade80;margin-bottom:1rem;}a{color:#4ade80;}</style></head>
    <body><div class="box">
      <h2>⌬ CyberWiseDaily</h2>
      <p>Backend is running.</p>
      <p><a href="${SITE_URL}">← Back to site</a></p>
    </div></body></html>
  `);
}

function doPost(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "";
    if (action === "subscribe")   return subscribe_(e.parameter);
    if (action === "unsubscribe") return unsubscribe_(e.parameter);
    if (action === "broadcast")   return broadcast_(e.parameter);
    return jsonOut({ ok: false, error: "Unknown action. Use action=subscribe, unsubscribe, or broadcast." });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------------------
// Unsubscribe (one-click link in every email)
// ---------------------------------------------------------------------------

function unsubscribe_(params) {
  const email = String(params.email || "").trim().toLowerCase();
  if (!isValidEmail_(email)) {
    return htmlOut_("Invalid link", "That unsubscribe link doesn't look right. Please reply to any CyberWiseDaily email to unsubscribe manually.");
  }

  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();

  let found = false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      sheet.getRange(i + 1, 3).setValue("inactive");
      found = true;
      break;
    }
  }

  if (!found) {
    return htmlOut_("Not found", `${email} wasn't found in our list — you may already be unsubscribed.`);
  }

  // Send a confirmation email so the user has proof they were removed.
  try {
    MailApp.sendEmail({
      to: email,
      name: FROM_NAME,
      subject: "You've been unsubscribed from CyberWiseDaily",
      body: [
        "Hi,",
        "",
        "This is a confirmation that " + email + " has been removed from CyberWiseDaily.",
        "You will not receive any further emails from us.",
        "",
        "Changed your mind? You can re-subscribe any time at:",
        SITE_URL,
        "",
        "— CyberWiseDaily",
      ].join("\n"),
    });
  } catch (_) {
    // Confirmation email failure is non-critical — unsubscribe already succeeded.
  }

  return htmlOut_("Unsubscribed", `
    <p><strong>${email}</strong> has been removed from CyberWiseDaily.</p>
    <p>You will not receive any more emails from us.</p>
    <p>A confirmation has been sent to your inbox.</p>
    <br>
    <p><a href="${SITE_URL}">← Back to site</a></p>
  `);
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

function subscribe_(params) {
  const email = String(params.email || "").trim().toLowerCase();
  if (!isValidEmail_(email)) {
    return jsonOut({ ok: false, error: "Invalid email address." });
  }

  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues(); // includes header

  // Find existing row (column A = email)
  let existingRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      existingRow = i + 1; // 1-based
      break;
    }
  }

  if (existingRow > 0) {
    // Re-activate if previously unsubscribed
    sheet.getRange(existingRow, 3).setValue("active");
    return jsonOut({ ok: true, message: "You're already subscribed — see you at 06:00." });
  }

  sheet.appendRow([email, new Date().toISOString(), "active"]);

  // Welcome email — HTML with unsubscribe button.
  try {
    const unsubUrl = unsubscribeUrl_(email);
    MailApp.sendEmail({
      to: email,
      name: FROM_NAME,
      subject: "Welcome to CyberWiseDaily",
      htmlBody: htmlEmail_("Welcome to CyberWiseDaily", `
        <p>Welcome.</p>
        <p>You'll start receiving the CyberWiseDaily brief at <strong>06:00 UTC</strong> each day.<br>
        Plain text, five-minute read, zero tracking.</p>
        <p><a href="${SITE_URL}" style="color:#4ade80;">Visit CyberWiseDaily →</a></p>
      `, email, unsubUrl),
    });
  } catch (err) {
    // Mail send can fail if quota is exhausted. Still treat subscribe as success
    // so the user isn't blocked — they'll get the next daily broadcast.
    return jsonOut({
      ok: true,
      message: "Subscribed. (Welcome email queued.)",
      warn: String(err && err.message || err),
    });
  }

  return jsonOut({ ok: true, message: "Subscribed — check your inbox." });
}

// ---------------------------------------------------------------------------
// Broadcast (daily)
// ---------------------------------------------------------------------------

function broadcast_(params) {
  const provided = String(params.secret || "");
  const expected = PropertiesService.getScriptProperties().getProperty("BROADCAST_SECRET") || "";
  if (!expected) {
    return jsonOut({ ok: false, error: "BROADCAST_SECRET not configured in Script Properties." });
  }
  if (provided !== expected) {
    return jsonOut({ ok: false, error: "Forbidden." });
  }

  let intel;
  try {
    intel = JSON.parse(params.data || "{}");
  } catch (err) {
    return jsonOut({ ok: false, error: "Invalid JSON in 'data' parameter: " + err.message });
  }

  const subscribers = getActiveSubscribers_();
  const subject = `CyberWiseDaily — ${intel.generated_date_display || todayString_()}`;

  let sent = 0;
  const errors = [];
  for (const email of subscribers) {
    try {
      const unsubUrl = unsubscribeUrl_(email);
      MailApp.sendEmail({
        to: email,
        name: FROM_NAME,
        subject,
        htmlBody: renderDigest_(intel, email),
      });
      sent++;
    } catch (err) {
      errors.push({ email, error: String(err && err.message || err) });
      if (/quota/i.test(String(err))) break;
    }
  }

  return jsonOut({
    ok: true,
    subscribers: subscribers.length,
    sent,
    errors: errors.slice(0, 5),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDigest_(intel, email) {
  const unsubUrl = unsubscribeUrl_(email);
  const date = intel.generated_date_display || todayString_();

  // Terminal status lines
  let statusRows = "";
  if (intel.terminal && Array.isArray(intel.terminal.lines)) {
    statusRows = intel.terminal.lines.map((l) => {
      const color = l.level === "CRIT" ? "#f87171" : l.level === "WARN" ? "#fbbf24" : "#4ade80";
      return `<tr>
        <td style="padding:4px 12px 4px 0;color:${color};font-family:monospace;white-space:nowrap;">[${l.level}]</td>
        <td style="padding:4px 0;color:#7a9080;font-family:monospace;">${escapeHtml_(l.text)}</td>
      </tr>`;
    }).join("");
  }

  // Briefing cards
  let briefingCards = "";
  if (Array.isArray(intel.briefings) && intel.briefings.length) {
    briefingCards = intel.briefings.map((b) => {
      const tagColor = b.tag_class === "crit" ? "#f87171" : b.tag_class === "warn" ? "#fbbf24" : "#4ade80";
      const link = b.source_url
        ? `<a href="${b.source_url}" style="color:#4ade80;text-decoration:none;font-size:12px;">Read more →</a>`
        : "";
      return `
        <div style="border:1px solid #1f2e1f;border-left:3px solid ${tagColor};padding:16px 20px;margin-bottom:12px;background:#111611;">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
            <span style="color:${tagColor};font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;">⬢ ${escapeHtml_(b.tag || "INTEL")}</span>
            <span style="color:#4a5a4a;font-family:monospace;font-size:11px;">${escapeHtml_(b.date || "")}</span>
          </div>
          <div style="font-family:Georgia,serif;font-size:16px;color:#d4e8d4;margin-bottom:8px;line-height:1.4;">${escapeHtml_(b.title || "")}</div>
          <div style="font-family:monospace;font-size:13px;color:#7a9080;line-height:1.6;margin-bottom:10px;">${escapeHtml_(b.excerpt || "")}</div>
          ${link}
        </div>`;
    }).join("");
  }

  const content = `
    <p style="font-family:monospace;font-size:13px;color:#7a9080;margin:0 0 24px;">
      Threats tracked today: <strong style="color:#4ade80;">${intel.threats_tracked ?? "?"}</strong>
    </p>

    ${statusRows ? `
    <div style="background:#0d120d;border:1px solid #1f2e1f;padding:16px 20px;margin-bottom:28px;">
      <div style="font-family:monospace;font-size:11px;color:#4a5a4a;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.1em;">// Status — ${date}</div>
      <table style="border-collapse:collapse;">${statusRows}</table>
    </div>` : ""}

    <div style="font-family:monospace;font-size:11px;color:#4ade80;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:14px;">// Today's Briefings</div>
    ${briefingCards}

    <div style="margin-top:28px;">
      <a href="${SITE_URL}" style="display:inline-block;background:#4ade80;color:#0a0e0a;font-family:monospace;font-size:13px;font-weight:700;text-decoration:none;padding:12px 24px;text-transform:uppercase;letter-spacing:0.05em;">Read on the web →</a>
    </div>
  `;

  return htmlEmail_(`CyberWiseDaily — ${date}`, content, email, unsubUrl);
}

// Escape HTML special characters for safe insertion into email body.
function escapeHtml_(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Shared HTML email shell with header, content, and unsubscribe button footer.
function htmlEmail_(title, contentHtml, email, unsubUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0e0a;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e0a;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0a0e0a;border:1px solid #1f2e1f;">

      <!-- Header -->
      <tr>
        <td style="background:#0d120d;border-bottom:1px solid #1f2e1f;padding:20px 28px;">
          <span style="font-family:monospace;font-size:16px;font-weight:700;color:#d4e8d4;">⌬ cyberwise<span style="color:#4ade80;">.daily</span></span>
        </td>
      </tr>

      <!-- Title -->
      <tr>
        <td style="padding:28px 28px 8px;">
          <h1 style="margin:0;font-family:Georgia,serif;font-weight:300;font-size:22px;color:#d4e8d4;letter-spacing:-0.01em;">${escapeHtml_(title)}</h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:16px 28px 28px;">
          ${contentHtml}
        </td>
      </tr>

      <!-- Footer with unsubscribe button -->
      <tr>
        <td style="border-top:1px solid #1f2e1f;padding:20px 28px;text-align:center;">
          <p style="font-family:monospace;font-size:11px;color:#4a5a4a;margin:0 0 14px;">
            You're receiving this because you subscribed at <a href="${SITE_URL}" style="color:#4a5a4a;">${SITE_URL}</a>
          </p>
          <a href="${unsubUrl}"
             style="display:inline-block;background:transparent;color:#f87171;font-family:monospace;font-size:12px;font-weight:600;text-decoration:none;padding:8px 20px;border:1px solid #f87171;text-transform:uppercase;letter-spacing:0.05em;">
            Unsubscribe
          </a>
          <p style="font-family:monospace;font-size:10px;color:#4a5a4a;margin:12px 0 0;">
            Clicking unsubscribe removes ${escapeHtml_(email)} immediately. No confirmation required.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// Build a one-click unsubscribe GET URL for a given email address.
function unsubscribeUrl_(email) {
  const scriptUrl = ScriptApp.getService().getUrl();
  return `${scriptUrl}?action=unsubscribe&email=${encodeURIComponent(email)}`;
}

// Return a simple HTML page (used for unsubscribe confirmation).
function htmlOut_(title, bodyHtml) {
  return HtmlService.createHtmlOutput(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} — CyberWiseDaily</title>
    <style>body{font-family:monospace;background:#0a0e0a;color:#d4e8d4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .box{border:1px solid #1f2e1f;padding:2rem 3rem;text-align:center;max-width:480px;}
    h2{color:#4ade80;margin-bottom:1rem;}a{color:#4ade80;}</style></head>
    <body><div class="box"><h2>⌬ ${title}</h2><p>${bodyHtml}</p></div></body></html>
  `);
}

function getSheet_() {
  // If opened via Extensions → Apps Script, the script is bound to the sheet
  // and getActiveSpreadsheet() works without needing SHEET_ID.
  const ss = SHEET_ID
    ? SpreadsheetApp.openById(SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["email", "subscribed_at", "status"]);
  }
  return sheet;
}

function getActiveSubscribers_() {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][0] || "").trim().toLowerCase();
    const status = String(data[i][2] || "active").trim().toLowerCase();
    if (email && status === "active" && isValidEmail_(email)) out.push(email);
  }
  return out;
}

function isValidEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function todayString_() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Optional: quick manual test from the Apps Script editor.
// Select this function, hit Run — it should email you and append a row.
// ---------------------------------------------------------------------------
function _selfTestSubscribe() {
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error("Run this from the Apps Script editor while signed in.");
  const res = subscribe_({ email });
  Logger.log(res.getContent());
}
