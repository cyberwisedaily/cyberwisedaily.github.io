/**
 * CyberWiseDaily — backend, free tier.
 *
 * Endpoints (application/x-www-form-urlencoded):
 *
 *   POST ?action=subscribe   & email=foo@bar.com
 *   POST ?action=broadcast   & secret=<shared> & data=<json>
 *   GET  ?action=unsubscribe & email=foo@bar.com  ← one-click from email button
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SHEET_ID   = "";           // Leave empty when bound via Extensions → Apps Script
const SHEET_NAME = "Subscribers";
const SITE_URL   = "https://cyberwisedaily.github.io/";
const FROM_NAME  = "CyberWiseDaily";

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "";

  // One-click unsubscribe link from email
  if (action === "unsubscribe") return unsubscribe_(e.parameter);

  // Default: status page
  return HtmlService.createHtmlOutput(htmlPage_("CyberWiseDaily", `
    <h2>⌬ CyberWiseDaily</h2>
    <p>Backend is running.</p>
    <p><a href="${SITE_URL}">← Back to site</a></p>
  `));
}

function doPost(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "";
    if (action === "subscribe")   return subscribe_(e.parameter);
    if (action === "broadcast")   return broadcast_(e.parameter);
    if (action === "unsubscribe") return unsubscribe_(e.parameter);
    return jsonOut({ ok: false, error: "Unknown action." });
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
  const data  = sheet.getDataRange().getValues();

  // Check for existing row
  let existingRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      existingRow = i + 1;
      break;
    }
  }

  if (existingRow > 0) {
    sheet.getRange(existingRow, 3).setValue("active");
    return jsonOut({ ok: true, message: "You're already subscribed — see you at 06:00." });
  }

  sheet.appendRow([email, new Date().toISOString(), "active"]);

  // Send welcome email with unsubscribe button
  try {
    const unsubUrl = unsubscribeUrl_(email);
    MailApp.sendEmail({
      to:       email,
      name:     FROM_NAME,
      subject:  "Welcome to CyberWiseDaily",
      htmlBody: htmlEmail_("Welcome to CyberWiseDaily", `
        <p>Welcome.</p>
        <p>You'll start receiving the CyberWiseDaily brief at <strong>06:00 UTC</strong> each day.<br>
           Plain text, five-minute read, zero tracking.</p>
        <p style="margin-top:24px;">
          <a href="${SITE_URL}" style="color:#4ade80;">Visit CyberWiseDaily →</a>
        </p>
      `, email, unsubUrl),
      headers: {
        "List-Unsubscribe":      `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Mailer":              "CyberWiseDaily/1.0",
      },
    });
  } catch (err) {
    return jsonOut({
      ok: true,
      message: "Subscribed. (Welcome email queued.)",
      warn: String(err && err.message || err),
    });
  }

  return jsonOut({ ok: true, message: "Subscribed — check your inbox." });
}

// ---------------------------------------------------------------------------
// Unsubscribe (one-click GET from email button)
// ---------------------------------------------------------------------------

function unsubscribe_(params) {
  const email = String(params.email || "").trim().toLowerCase();
  if (!isValidEmail_(email)) {
    return HtmlService.createHtmlOutput(htmlPage_("Invalid link",
      "<p>That unsubscribe link doesn't look right.</p><p><a href=\"" + SITE_URL + "\">← Back to site</a></p>"
    ));
  }

  const sheet = getSheet_();
  const data  = sheet.getDataRange().getValues();

  let found = false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      sheet.getRange(i + 1, 3).setValue("inactive");
      found = true;
      break;
    }
  }

  if (!found) {
    return HtmlService.createHtmlOutput(htmlPage_("Already unsubscribed",
      `<p>${escapeHtml_(email)} wasn't found — you may already be unsubscribed.</p>
       <p><a href="${SITE_URL}">← Back to site</a></p>`
    ));
  }

  // Send confirmation email
  try {
    MailApp.sendEmail({
      to:      email,
      name:    FROM_NAME,
      subject: "You've been unsubscribed from CyberWiseDaily",
      htmlBody: htmlEmail_("You've been unsubscribed", `
        <p>This confirms that <strong>${escapeHtml_(email)}</strong> has been removed from CyberWiseDaily.</p>
        <p>You will not receive any further emails from us.</p>
        <p style="margin-top:24px;">
          Changed your mind? You can re-subscribe any time at:<br>
          <a href="${SITE_URL}" style="color:#4ade80;">${SITE_URL}</a>
        </p>
      `, email, null),  // no unsubscribe button on the confirmation email itself
    });
  } catch (_) {
    // Non-critical — unsubscribe already succeeded in the sheet
  }

  // Show confirmation page
  return HtmlService.createHtmlOutput(htmlPage_("Unsubscribed", `
    <p><strong>${escapeHtml_(email)}</strong> has been removed from CyberWiseDaily.</p>
    <p>You will not receive any more emails from us.</p>
    <p>A confirmation has been sent to your inbox.</p>
    <p style="margin-top:24px;"><a href="${SITE_URL}">← Back to site</a></p>
  `));
}

// ---------------------------------------------------------------------------
// Broadcast (daily, called by GitHub Actions)
// ---------------------------------------------------------------------------

function broadcast_(params) {
  const provided = String(params.secret || "");
  const expected = PropertiesService.getScriptProperties().getProperty("BROADCAST_SECRET") || "";
  if (!expected) return jsonOut({ ok: false, error: "BROADCAST_SECRET not configured." });
  if (provided !== expected) return jsonOut({ ok: false, error: "Forbidden." });

  let intel;
  try {
    intel = JSON.parse(params.data || "{}");
  } catch (err) {
    return jsonOut({ ok: false, error: "Invalid JSON in 'data': " + err.message });
  }

  const subscribers = getActiveSubscribers_();
  const subject     = `CyberWiseDaily — ${intel.generated_date_display || todayString_()}`;

  let sent = 0;
  const errors = [];
  for (const email of subscribers) {
    try {
      const unsubUrl = unsubscribeUrl_(email);
      MailApp.sendEmail({
        to:       email,
        name:     FROM_NAME,
        subject,
        htmlBody: renderDigest_(intel, email),
        body:     renderDigestPlainText_(intel, email),  // plain-text fallback
        headers: {
          "List-Unsubscribe":       `<${unsubUrl}>`,
          "List-Unsubscribe-Post":  "List-Unsubscribe=One-Click",
          "Precedence":             "bulk",
          "X-Mailer":               "CyberWiseDaily/1.0",
        },
      });
      sent++;
    } catch (err) {
      errors.push({ email, error: String(err && err.message || err) });
      if (/quota/i.test(String(err))) break;
    }
  }

  return jsonOut({ ok: true, subscribers: subscribers.length, sent, errors: errors.slice(0, 5) });
}

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

function renderDigest_(intel, email) {
  const unsubUrl = unsubscribeUrl_(email);
  const date     = intel.generated_date_display || todayString_();

  // Status lines
  let statusBlock = "";
  if (intel.terminal && Array.isArray(intel.terminal.lines)) {
    const rows = intel.terminal.lines.map((l) => {
      const color = l.level === "CRIT" ? "#f87171" : l.level === "WARN" ? "#fbbf24" : "#4ade80";
      return `<tr>
        <td style="padding:3px 12px 3px 0;font-family:monospace;color:${color};white-space:nowrap;">[${l.level}]</td>
        <td style="padding:3px 0;font-family:monospace;color:#7a9080;">${escapeHtml_(l.text)}</td>
      </tr>`;
    }).join("");
    statusBlock = `
      <div style="background:#0d120d;border:1px solid #1f2e1f;padding:16px 20px;margin-bottom:24px;">
        <div style="font-family:monospace;font-size:11px;color:#4a5a4a;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.1em;">// Status — ${date}</div>
        <table style="border-collapse:collapse;">${rows}</table>
      </div>`;
  }

  // Briefing cards
  let cards = "";
  if (Array.isArray(intel.briefings) && intel.briefings.length) {
    cards = intel.briefings.map((b) => {
      const tagColor = b.tag_class === "crit" ? "#f87171" : b.tag_class === "warn" ? "#fbbf24" : "#4ade80";
      const readMore = b.source_url
        ? `<a href="${b.source_url}" style="color:#4ade80;font-family:monospace;font-size:12px;text-decoration:none;">Read more →</a>`
        : "";
      return `
        <div style="border:1px solid #1f2e1f;border-left:3px solid ${tagColor};padding:16px 20px;margin-bottom:12px;background:#111611;">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
            <span style="color:${tagColor};font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;">⬢ ${escapeHtml_(b.tag || "INTEL")}</span>
            <span style="color:#4a5a4a;font-family:monospace;font-size:11px;">${escapeHtml_(b.date || "")}</span>
          </div>
          <div style="font-family:Georgia,serif;font-size:16px;color:#d4e8d4;line-height:1.4;margin-bottom:8px;">${escapeHtml_(b.title || "")}</div>
          <div style="font-family:monospace;font-size:13px;color:#7a9080;line-height:1.6;margin-bottom:10px;">${escapeHtml_(b.excerpt || "")}</div>
          ${readMore}
        </div>`;
    }).join("");
  }

  const content = `
    <p style="font-family:monospace;font-size:13px;color:#7a9080;margin:0 0 24px;">
      Threats tracked today: <strong style="color:#4ade80;">${intel.threats_tracked ?? "?"}</strong>
    </p>
    ${statusBlock}
    <div style="font-family:monospace;font-size:11px;color:#4ade80;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:14px;">// Today's Briefings</div>
    ${cards}
    <div style="margin-top:28px;">
      <a href="${SITE_URL}" style="display:inline-block;background:#4ade80;color:#0a0e0a;font-family:monospace;font-size:13px;font-weight:700;text-decoration:none;padding:12px 24px;text-transform:uppercase;letter-spacing:0.05em;">Read on the web →</a>
    </div>
  `;

  return htmlEmail_(`CyberWiseDaily — ${date}`, content, email, unsubUrl);
}

// Plain-text fallback — improves spam score (multipart/alternative signals legit sender).
function renderDigestPlainText_(intel, email) {
  const lines = [];
  const date  = intel.generated_date_display || todayString_();
  lines.push(`CyberWiseDaily — ${date}`);
  lines.push("=".repeat(48));
  lines.push(`Threats tracked today: ${intel.threats_tracked ?? "?"}`);
  lines.push("");
  if (intel.terminal && Array.isArray(intel.terminal.lines)) {
    lines.push("STATUS");
    intel.terminal.lines.forEach((l) => lines.push(`  [${l.level}] ${l.text}`));
    lines.push("");
  }
  if (Array.isArray(intel.briefings) && intel.briefings.length) {
    lines.push("TODAY'S BRIEFINGS");
    lines.push("-".repeat(32));
    intel.briefings.forEach((b, i) => {
      lines.push(`${i + 1}. [${b.tag}] ${b.title}`);
      if (b.excerpt)    lines.push(`   ${b.excerpt}`);
      if (b.source_url) lines.push(`   ${b.source_url}`);
      lines.push("");
    });
  }
  lines.push(`Read on the web: ${SITE_URL}`);
  lines.push(`Unsubscribe: ${unsubscribeUrl_(email)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared HTML helpers
// ---------------------------------------------------------------------------

/**
 * Full email shell with header, body content, and optional unsubscribe button.
 * Pass unsubUrl=null to omit the unsubscribe button (e.g. confirmation emails).
 */
function htmlEmail_(title, contentHtml, email, unsubUrl) {
  const footer = unsubUrl ? `
    <tr>
      <td style="border-top:1px solid #1f2e1f;padding:24px 28px;text-align:center;">
        <p style="font-family:monospace;font-size:11px;color:#4a5a4a;margin:0 0 16px;">
          You're receiving this because you subscribed at
          <a href="${SITE_URL}" style="color:#4a5a4a;">${SITE_URL}</a>
        </p>
        <!-- Unsubscribe button -->
        <a href="${unsubUrl}"
           style="display:inline-block;background:transparent;color:#f87171;font-family:monospace;font-size:12px;font-weight:600;text-decoration:none;padding:9px 22px;border:1px solid #f87171;text-transform:uppercase;letter-spacing:0.05em;">
          Unsubscribe
        </a>
        <p style="font-family:monospace;font-size:10px;color:#4a5a4a;margin:12px 0 0;">
          One click removes ${escapeHtml_(email)} immediately — no confirmation required.
        </p>
      </td>
    </tr>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0e0a;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e0a;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0a0e0a;border:1px solid #1f2e1f;">

      <!-- Header -->
      <tr>
        <td style="background:#0d120d;border-bottom:1px solid #1f2e1f;padding:18px 28px;">
          <span style="font-family:monospace;font-size:16px;font-weight:700;color:#d4e8d4;">
            ⌬ cyberwise<span style="color:#4ade80;">.daily</span>
          </span>
        </td>
      </tr>

      <!-- Title -->
      <tr>
        <td style="padding:28px 28px 8px;">
          <h1 style="margin:0;font-family:Georgia,serif;font-weight:300;font-size:22px;color:#d4e8d4;letter-spacing:-0.01em;">
            ${escapeHtml_(title)}
          </h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:16px 28px 28px;">
          ${contentHtml}
        </td>
      </tr>

      <!-- Footer / Unsubscribe -->
      ${footer}

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Minimal HTML page for browser responses (unsubscribe confirmation etc.) */
function htmlPage_(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <title>${escapeHtml_(title)} — CyberWiseDaily</title>
  <style>
    body{font-family:monospace;background:#0a0e0a;color:#d4e8d4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .box{border:1px solid #1f2e1f;padding:2.5rem 3rem;text-align:center;max-width:480px;}
    h2{color:#4ade80;margin:0 0 1rem;}
    a{color:#4ade80;}
  </style></head>
  <body><div class="box"><h2>⌬ ${escapeHtml_(title)}</h2>${bodyHtml}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function unsubscribeUrl_(email) {
  const base = ScriptApp.getService().getUrl();
  return `${base}?action=unsubscribe&email=${encodeURIComponent(email)}`;
}

function escapeHtml_(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function getSheet_() {
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
  const data  = sheet.getDataRange().getValues();
  const out   = [];
  for (let i = 1; i < data.length; i++) {
    const email  = String(data[i][0] || "").trim().toLowerCase();
    const status = String(data[i][2] || "active").trim().toLowerCase();
    if (email && status === "active" && isValidEmail_(email)) out.push(email);
  }
  return out;
}

function isValidEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function todayString_() {
  const d  = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}.${mm}.${dd}`;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Manual test — run from Apps Script editor to test subscribe flow
// ---------------------------------------------------------------------------
function _selfTestSubscribe() {
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error("Run this from the Apps Script editor while signed in.");
  Logger.log(subscribe_({ email }).getContent());
}
