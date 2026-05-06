# CyberWiseDaily

The official site for **CyberWiseDaily** — daily cybersecurity intelligence for defenders.

🌐 **Live site:** https://cyberwisedaily.github.io

---

## 🚀 Deploy this to GitHub Pages

Follow these steps to get your site live:

### Option A: Organization Site (recommended for a company)

This gets you the clean URL `https://cyberwisedaily.github.io`.

1. **Create the GitHub Organization**
   - Go to https://github.com/organizations/new
   - Name it exactly: `cyberwisedaily`

2. **Create the special repository**
   - Inside the org, create a new repo named exactly: `cyberwisedaily.github.io`
   - Make it **public**
   - The repo name MUST match the org name + `.github.io`

3. **Upload these files**
   - Upload `index.html`, `404.html`, and `README.md` to the repo root
   - Or clone the repo locally and `git push` them up

4. **Enable Pages**
   - Repo → **Settings** → **Pages**
   - Under "Build and deployment," set **Source** to `Deploy from a branch`
   - Branch: `main`, folder: `/ (root)`
   - Save

5. **Wait ~1 minute** — your site will be live at `https://cyberwisedaily.github.io`

### Option B: Personal Account Site

If you don't want an organization, create the repo under your personal account:
- Repo name: `<your-username>.github.io`
- Same upload + Pages settings as above
- URL will be `https://<your-username>.github.io`

---

## 🌍 Custom Domain (e.g., cyberwisedaily.com)

1. Buy `cyberwisedaily.com` from any registrar (Namecheap, Cloudflare, Porkbun, etc.)
2. In **Settings → Pages**, enter `cyberwisedaily.com` under "Custom domain"
3. At your registrar's DNS panel, add these records:

   ```
   Type   Name   Value
   ────────────────────────────────
   A      @      185.199.108.153
   A      @      185.199.109.153
   A      @      185.199.110.153
   A      @      185.199.111.153
   CNAME  www    cyberwisedaily.github.io
   ```

4. Wait for DNS to propagate (a few minutes to a few hours)
5. Tick **Enforce HTTPS** in Pages settings once it's available

---

## ✏️ Editing the site

Just edit `index.html` and push the change. GitHub rebuilds automatically.

The site is a single self-contained HTML file with embedded CSS and JS — no build step, no dependencies. Easy to maintain.

### Connecting the subscribe form
The current form is a UI demo. To accept real signups, swap the `handleSubscribe` function for a service like:
- [Buttondown](https://buttondown.email) — newsletter-friendly
- [ConvertKit](https://convertkit.com) — creator-focused
- [Formspree](https://formspree.io) — generic form handler
- [Mailchimp](https://mailchimp.com) — classic option

---

## 📁 Files

| File | Purpose |
|------|---------|
| `index.html` | Main landing page |
| `404.html` | Custom not-found page |
| `README.md` | This file |
| `CNAME` | (optional) Custom domain config — auto-created when you add one in settings |

---

## 📜 License

Site content © 2026 CyberWiseDaily. All rights reserved.
