# INVECK Lead Engine

A web app that finds, researches and drafts outreach for INVECK India's prospects.
Everything happens in one run. Nobody needs Airtable or n8n.

1. **Find prospects** (optional): the AI plans Google searches from the target segments
   and existing clients, then picks real companies. Existing clients and known leads
   are skipped.
2. **Research**: for each new company it reads the website and checks it against the one
   active ICP its segment names (no segment, an unknown one or a switched-off ICP is
   flagged, never swapped for another ICP). It skips existing clients by name and by domain.
   The ICP's must-haves, deal-breakers and size, geography and industry targets become
   numbered criteria; the AI answers each one met / not met / unknown with a quote and the
   page it came from, and code checks every quote against its page. The decision follows
   fixed rules (see `src/lib/pipeline/fit.ts`): a company is **Disqualified** only when a quote
   shows a must-have failing or a deal-breaker applying (and a second look confirms the quote
   shows it); anything unconfirmed after one more search, a malformed or self-contradicting AI
   answer, or a low score with nothing against the company goes to **Needs Review**.
   Commercial risk (insolvency, liquidation) is recorded separately and rules a company out only
   when an ICP deal-breaker names it. A ruled-out or reviewed company can be reassessed, confirmed
   as a fit or marked not a fit from its page or the Leads list; the earlier assessment stays on
   its timeline.
3. **Contact**: it searches LinkedIn (via Google) and the company's own pages, and the AI picks the best
   person and their LinkedIn profile. Emails and phone numbers aren't looked up (see below).
4. **Score and draft**: every qualified lead that can be reached gets a personalised
   email draft.

### How contacts are matched

A person found on LinkedIn (via Google) is a candidate only when all three hold:

- **Same company**: their employer is the company's name, its website name, or the name on the
  company's own LinkedIn page (found once by the website it lists, so a similarly named company never
  counts). The search uses these names too.
- **Based in India**: any Indian city counts; the lead's own city is no longer required. People whose profile
  places them abroad are left out, and someone at the lead's city is ranked ahead within the same tier.
- **A role the ICP wants**: a title on the ICP's lists, or one in a function the lists name
  (operations, supply chain, finance) at head, manager or lead level ("Senior Manager, Site
  Operations"). Engineers, associates, analysts and HR are left out; someone whose profile names no
  role isn't picked automatically (the team can add them by hand).

### Emails and phone numbers

Neither is looked up. The app finds the right person and their LinkedIn profile; an email or phone
number is kept only when the sales team types it in (Edit point of contact), labelled "entered by the
team". Drafts are still written for every qualified lead, to send from LinkedIn or once the team has
an address.

The one human step is **approval**. A person reads the draft, edits it if needed, and sends it.
Nothing is ever sent automatically: every email goes out because someone clicked Send mail.

### Sending email from Outlook

Each team member connects their own INVECK Outlook (Microsoft 365) once, on the **Account** page.
After that, the email step on **Today** has a **Send mail** button: one click sends the draft from
the mailbox of the person the company belongs to (it shows in their Sent Items), and the arrow
beside it opens the email to review and edit first: the address, the subject and the text. Nobody
can send from someone else's mailbox, and if the owner hasn't connected Outlook the button says so
instead of sending. The step is logged as sent only once Microsoft Graph accepts the email (HTTP 202),
and the lead's activity records the sender, recipient, subject, time and Graph's request id. One send
per step: a second click, or a second tab, can't send it twice; if Microsoft never answers, the step
is held for ten minutes and the person is told to check Sent Items. Drafts are signed with the sender
name in Settings; sent from someone's mailbox, that name becomes theirs. A follow-up is a new email
with "Re:" and the last email quoted below it (Graph's `Mail.Send` permission can't reply in a thread);
if no follow-up is written yet, **Write it for me** drafts one. "Mark sent" is still there for emails
sent by hand.

The product profile PDF is attached to every email, chosen by the company's segment, from the
`assets/` folder (up to 3 MB each):

- `assets/inveck-profile-manufacturing.pdf` for Manufacturing
- `assets/inveck-profile-3pl.pdf` for 3PL & Logistics / warehousing
- `assets/inveck-product-profile.pdf` (optional) for any other segment, CA firms included

With no file for a segment, that email goes without an attachment.

One-time setup by an administrator:

1. In the Microsoft Entra admin center (entra.microsoft.com), **App registrations → New
   registration**: name it "INVECK Lead Engine", **Accounts in this organizational directory only**,
   and a **Web** redirect URI of exactly
   `https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback`.
2. **API permissions → Add → Microsoft Graph → Delegated**: `Mail.Send`, `User.Read`,
   `offline_access`, `openid`, `email`. If your tenant doesn't let people consent to apps
   themselves, click **Grant admin consent for INVECK**.
3. **Certificates & secrets → New client secret**; copy its **Value** (shown once).
4. In Vercel (Project → Settings → Environment Variables), add (server-side only, never committed):
   - `MICROSOFT_CLIENT_ID`: the app's Application (client) ID
   - `MICROSOFT_TENANT_ID`: the Directory (tenant) ID
   - `MICROSOFT_CLIENT_SECRET`: the secret's value
   - `MICROSOFT_REDIRECT_URI`: `https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback`
     (must match Entra exactly; for local testing leave it out and register
     `http://localhost:3000/api/auth/microsoft/callback` as well)
   - `MICROSOFT_TOKEN_ENCRYPTION_KEY`: a random string of 32+ characters; stored connections
     (refresh tokens, AES-256-GCM) are encrypted with it. Changing it later means everyone connects
     Outlook again.

   Then redeploy. Never paste these anywhere else. These replace the earlier `MS_*` and
   `MAIL_TOKEN_KEY` names.
5. Each team member: **Account → Connect Outlook**, sign in with their own INVECK account. The
   connection is tied to the CRM login that started it (checked against a one-time `state` held in
   an httpOnly cookie), and one mailbox can only be linked to one CRM user.

The secret expires (Entra shows when): make a new one before then and update `MICROSOFT_CLIENT_SECRET`.

### WhatsApp from INVECK's number

WhatsApp only allows a business to message people who agreed to hear from it, so the app keeps
that record and sends from INVECK's own business number (Meta's WhatsApp Cloud API) only to them:

- **Agreeing.** On a connected call, tick **They agreed to get WhatsApp messages from INVECK**: it is
  saved with the date, the call and who logged it, and a WhatsApp step to send the details appears
  for today (undoing the call takes both back). It can also be marked on the company page (how they
  agreed: on a call, by email, in person, on a form). Someone who messages INVECK's number counts as
  agreeing. A number found online is not agreement: those contacts keep the manual **Open
  WhatsApp** from the team member's own phone.
- **Sending.** For someone who agreed, the WhatsApp step on Today has **Send WhatsApp**, with an arrow
  to review it first. Until they write back, WhatsApp only allows the template Meta approved (set in
  **Settings → WhatsApp template**), filled in with their first name, the sender's name and the
  company. For 24 hours after their last message, anything can be written. The template doesn't go
  again to someone who hasn't replied for a week (repeats get a number reported and limited by
  Meta); until then the step says so and offers the BDA's own phone.
- **Replies.** Messages to INVECK's number show on Today under **WhatsApp replies** and on the company
  page, where the whole conversation is, with delivery ticks and the reason when one isn't
  delivered. A reply moves the lead to Replied.
- **STOP.** A reply of STOP (or Meta's "Stop promotions" button) stops everything to that number,
  open WhatsApp steps included, until they send START or agree again.

One-time setup, by whoever manages INVECK's Meta (Facebook) business account:

1. **Meta Business portfolio** (business.facebook.com) for INVECK, with **business verification**
   done (Security centre; it asks for registration documents such as GST).
2. **developers.facebook.com → My apps → Create app**, type **Business**, linked to that portfolio;
   add the **WhatsApp** product.
3. **WhatsApp → API setup → Add phone number**: a number not in use on WhatsApp (or INVECK's WhatsApp
   Business app number, if Meta offers to connect it with the app kept: "coexistence"). Verify it and
   set the display name. Copy its **Phone number ID**.
4. **Business settings → Users → System users → Add** (admin); **Assign assets**: the app and the
   WhatsApp account. **Generate token** for the app with `whatsapp_business_messaging` and
   `whatsapp_business_management`, expiring **Never**.
5. **App settings → Basic → App secret**: copy it.
6. In Vercel (Project → Settings → Environment Variables), add, then redeploy:
   - `WHATSAPP_PHONE_NUMBER_ID`: the phone number ID
   - `WHATSAPP_TOKEN`: the system user token
   - `WHATSAPP_APP_SECRET`: the app secret
   - `WHATSAPP_VERIFY_TOKEN`: any long random string you choose
7. **WhatsApp → Configuration → Webhook**: callback URL
   `https://<the app's address>/api/whatsapp/webhook`
   (e.g. `https://inveck-lead-engine.vercel.app/api/whatsapp/webhook`), verify token the same string
   as `WHATSAPP_VERIFY_TOKEN`; **Verify and save**, then subscribe to the **messages** field. Switch
   the app to **Live**.
8. **WhatsApp Manager → Message templates → Create**: category **Marketing**, name
   `inveck_details`, language English, a body like the one below, and the "Stop promotions" quick
   reply button if offered. Once approved, copy its name, language code (`en` or `en_US`, as shown)
   and body text exactly into **Settings → WhatsApp template**.

   > Hi {{1}}, this is {{2}} from INVECK, following up on our call. INVECK lets your team count stock
   > and verify assets on mobile and reconcile against ERP records without Excel, with audit-ready
   > reports. Would a short demo for {{3}} be useful? Reply with a convenient time, or STOP to stop
   > these messages.

9. **WhatsApp Manager → Payment settings**: add a payment method (Meta charges per marketing
   message).

To test: on a company with your own number as the contact, mark that you agreed, then send from its
page or its Today step.

### After the first email

- **Follow-ups**: five rounds, every other working day, started only by a call saved on Today as No answer, Busy or voicemail, or Wrong number. The day of that call is Day 1; Follow-up 1 to 5 fall 2, 4, 6, 8 and 10 working days later (Saturdays, Sundays and the holidays set in **Settings → Holidays** never count). Each round is a call, a WhatsApp and an email; the AI drafts the round's email when it is due, the team edits it and marks it sent (nothing is sent automatically). A connected call stops the sequence for good. When all five rounds are done (every step done or skipped), the lead moves to **Deleted** as junk: it is only archived, and **Leads → Deleted** lists it with a Restore button. Existing records follow the same rules, from their saved call outcomes (see `src/lib/follow-up-reconcile.ts`).
- **Buying signals**: qualified leads get a Google News check for new plants, expansions, acquisitions, funding or audit news. The best one opens the draft, and each links to its article.
- **Pipeline**: a board from Awaiting Approval to Won/Lost; drag cards or use their menu.
- **Timeline**: every lead shows what happened and when, and the team can add notes, calls and meetings.
- **Dashboard**: the funnel with conversion rates, weekly emails and replies, the best segment and lead source, and follow-ups due.

### Sourcing test

**Dashboard → Sourcing test** (administrators) tries a different way of finding companies, without
touching the pipeline. It searches Google for companies' LinkedIn pages in a segment's industries and
clusters, screens each on what the page shows (headquarters in India, size against the ICP, an
industry the ICP covers, not already a lead, client or on INVECK's lists), then searches the staff of
the ones that pass on LinkedIn to see whether anyone on the ICP's P1/P2/P3 lists works there. It uses
Serper only (no AI), saves nothing but its report (no leads, no prospect history, nothing sent) and
shows the funnel, every company with its outcome, and each search with what it found.

## Deploy on Vercel

1. Import this repository at [vercel.com/new](https://vercel.com/new).
2. In the project, open **Storage → Create Database → Neon (Postgres)** and connect it.
   That sets `DATABASE_URL` / `POSTGRES_URL`. Tables are created automatically on first use.
3. Add these under **Settings → Environment Variables**:

   | Variable | Required | What it is |
   |---|---|---|
   | `APP_PASSWORD` | yes | The administrator password (log in with the username left empty) |
   | `CRON_SECRET` | yes | Any long random string (protects the scheduled run) |
   | `DEEPSEEK_API_KEY` | yes* | DeepSeek key (the default AI) |
   | `ANTHROPIC_API_KEY` | optional* | Only needed if you switch the AI to Claude in Settings |
   | `SERPER_API_KEY` | yes | serper.dev key for Google / LinkedIn search |
   | `APP_URL` | optional | Your public URL, if you use a custom domain |

   \* You need the key for whichever AI provider is selected in Settings.
4. Redeploy so the variables take effect, then open the site and log in.

A scheduled run starts at 06:00 IST on weekdays (`vercel.json`). It researches new
leads and runs the prospect search on the day chosen in Settings.

At 08:00 IST on weekdays the **morning draw** (`/api/cron/draw`) hands each active associate 20 leads:
12 Manufacturing + 8 3PL & Logistics (Settings, "Manufacturing leads per associate" and "3PL & Logistics
leads per associate"), so 80 a day for four associates (48 + 32). Each segment is drawn separately, at random,
from researched leads nobody has been given yet and dealt round the team, so everyone gets the same mix. A
shortage in one segment is shown per associate on the Team page and never filled from the other segment or
from CA firms (CA firms are not part of this draw); leads that turn up later the same day top up each
associate's missing segment. A lead is drawn only once. Inbound leads still go out in turn the moment they
arrive, and a lead a BDA adds by hand stays theirs. If the schedule runs late, the first page opened after
08:00 runs the draw. Long runs continue
in the background automatically, within Vercel's 300-second function limit.

### CA firms from the Google Sheet

CA firms come from one master Google Sheet (tab **Firms**; columns Firm, Phone, Email, Services, Website, a
location column headed `.`, and ICAI profile URL). Every working day (from 08:00 IST) **Anchal and Puja are
each given 10 firms**, 20 in all, picked at random among firms never given before that aren't already a lead or
a client. Only those firms become leads (the sheet is read, never copied in); they are researched like any other
CA firm and don't go through the company-discovery search. With fewer than 20 eligible firms the ones there are
go out and the shortfall is shown per associate on the **Team** page; it is checked again about every half hour
that day, and the admin's **Top up the shortfalls** button runs it at once. A firm is identified by its ICAI firm
number (the profile URL), recorded in the `sheet_firms` table with who got it and when, so a retried run can't pick
it again.

Setup: share the sheet with the service account as Viewer, then add the key on the server (never in the repo):

- Vercel: `GOOGLE_SERVICE_ACCOUNT_JSON` = the whole contents of the key file (Project → Settings → Environment Variables), then redeploy.
- Local: `GOOGLE_SERVICE_ACCOUNT_FILE` = the path to the key file, in `.env.local` (ignored on Vercel).
- Optional: `CA_SHEET_ID` and `CA_SHEET_TAB` (default to the master sheet and `Firms`).

A CA firm starts with a LinkedIn request on day 1: **Request sent**, **Already sent a request** (no new request; the
wait for acceptance starts and round 1 shows today), or **Not on LinkedIn: call instead**. Then three follow-up
rounds, each a call, a WhatsApp and an email, on consecutive working days (round 1 the next working day after a
request sent now, or today otherwise); weekends and the holidays in Settings are skipped. Accepted ends it; when all
three rounds are done the firm is done.

### Marketing: the content calendar

Marketing has its own login, separate from the sales team: **marketing@inveck**, with the starting password
`marketinginveck` (it asks to change it at first login; do that on **Account**). It has its own role, created
automatically on first start, and sees only three pages: **Content Calendar** (its landing page), **Overview** and
**Account**. Every other page, action and API is refused for it on the server (the proxy, the pages and each
action check), so typing a Lead Engine address does nothing. Administrators can open the Marketing pages too.

- **Calendar:** month or week view with previous/next and Today. Unscheduled drafts are in the side list: drag a
  card onto a day to schedule it, drag a card to another day to move it, or open it and pick a date (the keyboard
  and screen-reader way). **New content** (or the + on a day) opens the editor: title, platform (Instagram or
  LinkedIn), format, caption, status, date, and a dependency note.
- **Statuses:** Draft, Pending approval, Approved, Scheduled, Waiting for dependency, Posted. The date and the status are
  separate: moving a post never changes its status, and changing its status never removes its date. Scheduled needs a date;
  Posted records when (and takes today's date if it had none), and a posted post's date is fixed until it is marked not posted.
- **Overview:** posted in total and per platform, scheduled, draft, pending approval and waiting for dependency.
- Everything is saved in the database (`content_posts`), not in the browser.

## The team

Each BDA has their own login: `name@inveck` (for example `parimal@inveck`) with the starting password
`inveck123`, which the app asks them to change on first use (**Account**). Administrators log in with
the username empty and the `APP_PASSWORD`, and can reset a team member's password on the Account page.

- **Owners**: every lead has an owner. New leads, whether found by the engine or inbound, are shared out
  in turn (Parimal, Anuradha, Anchal, Puja, and round again). **Leads** opens on "My leads".
- **Inbound leads**: tick "Inbound lead" when adding companies. One nobody has touched after two hours is
  flagged at the top of the owner's Today list.
- **Today**: each person's work list, one card per company with every step at once: call, WhatsApp,
  email and LinkedIn request on day 1; the follow-up rounds come from the follow-up sequence once a
  call is saved as no answer, busy or wrong number. Steps already logged today stay on the card, ticked, with Undo. A connected call needs a note and
  an outcome: Not interested, No requirement right now or Already using a solution ticks off everything
  else for that company; any other outcome keeps today's WhatsApp, email and LinkedIn and stops the later
  rounds. When every step is ticked the company is done for the day. Counters show leads assigned (20: 12 + 8), companies done (target 20), calls
  attempted (target 20 a day, per associate), connected calls, WhatsApp, emails and LinkedIn requests.
- **P2 flow**: after 5 unanswered calls to the point of contact, or a connected call logged as "Not the
  right person", the lead switches to the next person already found at the company (a P2 process owner
  after a P1, then P3; never HR, admin or quality), shown with a P2 badge, with a fresh plan from that day
  and the email rewritten for them. When nobody else is on file, Today asks for the next contact; naming
  them under Edit point of contact starts their plan.
- **Team** (administrators): companies completed, calls, connect rate, messages, LinkedIn requests,
  meetings and attendance per person, for today, yesterday, 7 or 30 days, plus the morning draw.
- **Attendance**: first and last time seen each day, plus Clock in and Clock out. Administrators can read
  it at `/api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD` until the admin dashboard exists.

## Using it

- **Targets**: edit the segments (ICPs) and paste the current client list, so no one
  who's already a client gets contacted.
- **Add companies**: add one company, or paste many as `Company, website, city, segment`.
- **Dashboard → Find prospects & research**: starts a run you can watch live on the **Runs** page.
- **Leads**: filter by status, open a lead, edit the draft, then **Approve** and **Mark as sent**.
- **Settings**: AI provider/model, sender details and the
  product description the AI is allowed to use.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000 with an embedded database in ./.data (no Postgres needed)
npm test           # pipeline tests with fake APIs
npm run lint && npm run typecheck
```

Put the API keys in `.env.local` to run real research locally. Without `APP_PASSWORD`,
login is off in local development only.
