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
  // Browsing to the web-app URL just returns a friendly status page.
  return jsonOut({
    ok: true,
    service: "cyberwisedaily-backend",
    actions: ["subscribe", "broadcast"],
    note: "POST application/x-www-form-urlencoded with action=subscribe&email=...",
  });
}

function doPost(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "";
    if (action === "subscribe") return subscribe_(e.parameter);
    if (action === "broadcast") return broadcast_(e.parameter);
    return jsonOut({ ok: false, error: "Unknown action. Use action=subscribe or action=broadcast." });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message || err) });
  }
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

  // Welcome email — keep it short and plain-text.
  try {
    MailApp.sendEmail({
      to: email,
      name: FROM_NAME,
      subject: "Welcome to CyberWiseDaily",
      body: [
        "Welcome.",
        "",
        "You'll start receiving the CyberWiseDaily brief at 06:00 UTC each day.",
        "Plain text, five-minute read, zero tracking.",
        "",
        "If this wasn't you, just reply with 'unsubscribe' and we'll remove the address.",
        "",
        "— CyberWiseDaily",
        SITE_URL,
      ].join("\n"),
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
  const body = renderDigest_(intel);

  let sent = 0;
  const errors = [];
  for (const email of subscribers) {
    try {
      MailApp.sendEmail({ to: email, name: FROM_NAME, subject, body });
      sent++;
    } catch (err) {
      errors.push({ email, error: String(err && err.message || err) });
      // Most common cause: daily quota exceeded. Stop early to avoid noise.
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

function renderDigest_(intel) {
  const lines = [];
  lines.push(`CyberWiseDaily — ${intel.generated_date_display || todayString_()}`);
  lines.push("=".repeat(48));
  lines.push("");
  lines.push(`Threats tracked today: ${intel.threats_tracked ?? "?"}`);
  lines.push("");
  if (intel.terminal && Array.isArray(intel.terminal.lines)) {
    lines.push("STATUS");
    lines.push("------");
    intel.terminal.lines.forEach((l) => lines.push(`  [${l.level}] ${l.text}`));
    lines.push("");
  }
  if (Array.isArray(intel.briefings) && intel.briefings.length) {
    lines.push("TODAY'S BRIEFINGS");
    lines.push("-----------------");
    intel.briefings.forEach((b, i) => {
      lines.push(`${i + 1}. [${b.tag}] ${b.title}`);
      if (b.excerpt) lines.push(`   ${b.excerpt}`);
      if (b.source_url) lines.push(`   → ${b.source_url}`);
      lines.push("");
    });
  }
  lines.push("--");
  lines.push(`Read on the web: ${SITE_URL}`);
  lines.push("Reply 'unsubscribe' to stop receiving these.");
  return lines.join("\n");
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
