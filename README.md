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
  places them abroad are left out, and someone at the lead's city is ranked ahead within the same tier. The main
  contact must be shown in India (from 29 Oct 2026): one whose result shows no location is looked up, and isn't the
  contact when that shows them abroad or still nowhere. Leads given out before with a contact never placed were
  checked on LinkedIn again, once.
- **The company's website**: the one its own LinkedIn page lists is kept, even when it can't be read (from 29 Oct
  2026); one found by a search for the name is used only when its pages name the company (a shared word isn't
  enough: nordicglobal.net, Nordic Shipping's, had been taken for Nordic Logistics and Warehousing's).
- **A role the ICP wants**: a title on the ICP's lists, or one in a function the lists name
  (operations, supply chain, finance) at head, manager or lead level ("Senior Manager, Site
  Operations"). Engineers, associates, analysts and HR are left out; someone whose profile names no
  role isn't picked automatically (the team can add them by hand).

Among the candidates, each segment's most wanted contact comes first (from 28 Oct 2026, `contactPriority` in
`tiers.ts`): the plant head for Manufacturing (plant, factory and works managers count as plant heads), the warehouse
manager for 3PL & Logistics (not an assistant or deputy one; on 3PL leads made before 29 Oct 2026); then plant heads
and supply chain heads and managers, regional, national and warehouse heads, the other heads, the COO and finance. A
lead nobody has started on gets that contact as its main contact when they are on file at the site and the current one
ranks well below.

The 3PL & Logistics P1 list is INVECK's new one from 29 Oct 2026 (their requirement): National Head – Operations,
Regional Head – Warehouse Operations, Head – Supply Chain, VP – Operations, VP – Logistics (their "VP – Operations /
Logistics", searched as two designations), Logistics Head and Head – Contract Logistics. It was set once on the live
database; Configuration can change it. Heads in operations, warehousing, logistics and supply chain written other ways
are still P1; managers (warehouse and operations managers) aren't contacts for new 3PL leads, and the COO is the last
resort. 3PL leads made before it keep the contacts they were given: their people are ranked with the list it replaced
as well (`LOGISTICS_P1_SINCE` in `tiers.ts`).

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
2. **API permissions → Add → Microsoft Graph → Delegated**: `Mail.Send`, `Calendars.ReadWrite`, `User.Read`,
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

### Teams meetings

When a connected call is saved as **Demo scheduled**, a dialog shows the prospect, company and saved email with a date, time
and length (India time) and the title "Demo for [Company] - Inveck". Nothing is created, and the lead doesn't move, until
**Approve and Schedule**. Then an event with a Microsoft Teams meeting is created in the lead owner's own Microsoft 365
calendar through Graph, with the prospect as a required attendee; Microsoft's calendar sends the invitation (the app sends
no separate email). Only once Graph returns the event and its Teams link is the call logged and the lead moved to Meeting
Booked. Scheduling again with the same details never makes a second meeting. On the meeting's date it shows at the top of
the BDA's Today page with its time and a **Join meeting** button that opens the Teams link in a new tab.

Calendar permission (`Calendars.ReadWrite`) is asked for at sign-in. Everyone who connected Outlook before it was added:
**Account → Allow calendar access** (or Connect again), then agree on Microsoft's page. If your tenant requires it, click
**Grant admin consent** in Entra once. Existing email sending keeps working until they do.

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
- **Pipeline**: a board from Approved to Won/Lost; drag cards or use their menu. There is no approval step: a company that passes the ICP check after research, with a reachable contact, is Approved straight away (Awaiting Approval was removed on 20 Oct 2026, and leads still in it were moved to Approved, with a note on their timeline).
- **Timeline**: every lead shows what happened and when, and the team can add notes, calls and meetings.
- **Dashboard**: the funnel with conversion rates, weekly emails and replies, the best segment and lead source, and follow-ups due.

### Sourcing test

**Dashboard → Sourcing test** (administrators) tries new ways of finding companies, without touching
the pipeline. It uses Serper only (no AI) and saves nothing but its report: no leads, no prospect
history, nothing sent.

- **People first** (the default): searches LinkedIn, through Google, for people with the ICP's P1/P2
  titles in the segment's industries and clusters ("Plant Head" "forging" Pune). Each person's current
  employer is read as strictly as the contact search reads it (current job there, in India, title on
  the P1/P2/P3 lists); then each of those companies' LinkedIn pages is screened on size, industry,
  headquarters and whether INVECK already has it. A company that passes comes with its contacts.
  You say how many prospects you want, and it keeps searching until it has exactly that many, however
  many companies it has to look through (carrying on in a new server invocation when one runs out of
  time). It stops short only at 1,500 Google searches, or when 120 searches in a row find nobody new
  on the lists, and says so.
- **Companies first**: searches for companies' LinkedIn pages, screens them the same way, then searches
  the staff of that many companies that pass to see whether anyone on the lists works there.

In both, a company passes only when it is shown to be in the ICP's industries: its LinkedIn industry
is one the ICP covers (for Manufacturing: auto components, machinery, engines and power transmission,
metals, defence and aerospace, railroad and transportation equipment), or, when LinkedIn shows none or
only "Manufacturing", its own page describes what it makes in the ICP's words (forgings, castings,
bearings, machine tools...). A missing industry is looked up once more; still missing, the company is out.

Each report shows the funnel, every company with its outcome, and each search with what it found.

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

**Long runs and Vercel's limit on hand-offs.** A run (or a Sourcing test or Morning Sample Run) longer than
one invocation (300 s) hands itself to the next by calling the app's own address. Vercel ends such a chain
after a few hand-offs (`508 INFINITE_LOOP_DETECTED`), so the run then pauses, with everything it did saved,
and the next fresh request picks it up again: a page opened (Dashboard, Leads, Today, Team, or the Sourcing
page while a test runs), the 8 am draw, or the checks every 10 minutes from 06:10 to 11:00 IST on weekdays
(`/api/cron/resume` in `vercel.json`). A Morning Sample Run stopped that way before this existed can be carried
on from where it got to ("Carry on from here"). A paused Sourcing test or Morning Sample Run is picked up again
however long it waited (the 6 am job, the 8 am draw, the checks, the outside five-minute timer calling
`/api/cron/inbound-demos`, or the Dashboard, Sourcing or Today page opened, as Today starts the CA draw); only
after 6 hours with nothing waking it is it closed as stopped, and it can still carry on from there. The Sourcing
page shows when each kind of wake-up last came (`src/lib/sourcing/wake.ts`): the outside timer should show a time
within the last 5 minutes.

A scheduled run starts at 06:00 IST on weekdays (`vercel.json`). It researches new leads and, on every
working day (not holidays marked in Settings; on the live database, from Thursday 22 October 2026, the
`morningStartsOn` setting, which holds the 8 am draw back until then too), finds new prospects **people first**
(`src/lib/sourcing/morning.ts`): Google searches of LinkedIn profiles with the ICP's P1 and P2 titles (plant
heads first), each with an industry word and a town (`PEOPLE_KEYWORDS` in `people-first.ts`, `SEGMENT_SEARCH` in
`linkedin-pages.ts`; from 28 Oct 2026, 39 words for Manufacturing and 14 for 3PL, all for the ICP's own industries,
and every industrial town across India, 134 and 60, the ICP being all of India; the titles unchanged); then each
person's company page on LinkedIn, screened
on size, industry, headquarters and whether INVECK already has it (by name, website or LinkedIn page). Each
company that passes becomes one lead with the people found there, and research makes the ICP check:
Approved or Disqualified. It finds what the morning draw is short of in each segment (active associates times
their quota, less the researched leads waiting), with a quarter more for those research rules out, and
searches again (three rounds at most, none after 07:30) while the draw is still short. A search made in the
last 30 days isn't made again. Every Google search the app makes is counted per day, and the Dashboard shows
the day's Serper credits (`src/lib/search-budget.ts`). There is no daily limit unless one is set in Settings
("Google searches a day"); with one, research of companies already found comes first, then the 8 am contact
checks, then finding more companies, and whatever is left waits for the next day. People searches ask for 10
results (1 credit). Research is the same for every company: the search for its people on LinkedIn (the
company's staff, then the ICP's designations one at a time until 4 acceptable contacts with a P1 among them),
its LinkedIn page, evidence and news, about 30-50 searches a company. For a company found people first, the
people the morning search found there are checked like anyone the search finds, and the acceptable ones count
towards those 4, so it stops sooner; all of them are kept as candidates. CA firms are
never searched for: they come from their sheet. The Dashboard's "This morning" card shows the run, what each
segment has ready for the draw, and warns when the searches are running thin.

From Monday 26 October 2026 that 6 am run no longer starts (`OLD_RUN_UNTIL` in `sample-run.ts`): Monday has no
run, and from Tuesday 27 October a **daily Morning Sample** (`DAILY_SAMPLE`) starts at 06:00 IST instead, on the
same days the morning search would run (a working day, not a holiday or a paused day, the search on in
Settings), started once by the first wake-up between 06:00 and 14:00. It is for that day's lists (what anyone
already has for the day left out), uses the sample's rules below (4,000 credits at most), and gives its leads out
itself when it finishes, never more than anyone's list for the day (a lead over it stays in the pool for the
next draw). The 8 am draw then fills only what is still missing.

From Tuesday 27 October each working day's run happens **the evening before, from 9 pm IST** (`EVENING_SAMPLE`): a
Morning Sample for the next day's lists, its leads approved and given out when it finishes, on the evening just before
a working day the morning search runs (Sunday's for Monday; none on Friday or Saturday evenings, before a holiday or a
paused day). In the evening the outside timer starts and wakes it. The 6 am daily run then fills only what is still
missing (nothing when the lists are full). There is no 6 am run on Tuesday 27 October (`DAILY_SAMPLE.skip`). A
one-off top-up (`TOP_UP_SAMPLES`) ran at 10:15 pm IST on 28 October for Thursday 29 October's lists, what each person
already had left out, to try that evening's rules, and another at 12:30 am on 29 October with the new industry words
and towns.

To see what tomorrow will look like first, the Sourcing page has a **Morning Sample Run**
(`src/lib/sourcing/sample-run.ts`): tomorrow's 6 am run and 8 am draw done now on paper. It searches and
researches exactly as the run does, deals each active associate their quota from the pool and what it found,
and shows each person's Today for the next working day (switch between the team). Nothing is saved as a lead,
nobody is given anything and the 6 am run's own search memory isn't touched, so tomorrow's run starts fresh.
CA firms aren't part of it. The sample is also where cheaper rules are tried before the 6 am run uses them
(`SAMPLE_RULES` in `sample-run.ts`): people searches of 10 results, a segment giving up after 60 searches in a row
find no new company (from 28 Oct 2026, 15 that morning; before, nobody new on the lists, so people at companies INVECK
already has kept it searching; a company ruled out in the last 90 days, or outside the ICP by its name, isn't a new
company), companies ruled out remembered for 90 days, companies outside the ICP by name not looked up and
up to six looked up in one search (from 28 Oct 2026), one that search doesn't show looked up on its own and a
company's size checked only while companies are still needed, the sample's own memory of its people searches
(`search-memory.ts`; and from 28 Oct 2026 a people search whose first page of ten was full and found new companies is
read on at once, its first hundred results for 2 credits: a search that found no new company isn't made again within
30 days, one made in the last 7
days that found companies is read further down rather than again: its first hundred results in one search (2
credits; its next ten if Serper refuses a hundred), then the next hundred, to 300, an industry word and
town where two searches found nobody isn't searched with other titles, a town where three industry words found nobody
and a word that found nobody in five towns aren't searched again (from 28 Oct 2026; and from 29 Oct during the run
itself, not only from the next one), and the pairs that found companies that passed go first; and the most wanted
title first, every word and town with the plant head (for 3PL, the head of supply chain from 29 Oct 2026) before the next title, so new
ground is tried with the titles likeliest to find someone), two contacts a company with the hunt for a P1 kept (the staff search
stops once two with a P1 are in hand), the designations searched in groups (from 28 Oct 2026, to spend fewer
credits: `groupedSearchPlan` in `contacts.ts`; up to five a search, `"Company" ("Plant Head" OR "Plant Manager" OR
...) Town`, every P1 designation still searched, a full page of ten followed by its second page while still short,
then three P1 designations one at a time when the contacts are still short (Plant Head, Plant Manager and Head of
Supply Chain for Manufacturing; for 3PL, the first three in the contact priority from 29 Oct 2026): at most 12 designation searches
a company instead of 28 for Manufacturing, plus any second pages), no repeat lookup of the company's LinkedIn page or of its officers in the
news and filings, a person's profile looked up in the last 14 days or the company's news checked in the last 7
not searched again, the people research found counted as checked on LinkedIn when a company is pushed into the
pipeline, 10% extra companies, 25 credits kept back for researching each company found, and 4,000 Google search
credits at most for a new sample (3,000 until 27 Oct 2026), a hard limit (a search that would go over it isn't made;
a company whose research reaches it is left for the next day). A company with no LinkedIn page, or whose page
doesn't show an ICP industry, isn't researched (from 27 Oct 2026 in both segments): research costs credits and it
would only be ruled out. From 28 Oct 2026 a Manufacturing company whose page shows no industry either way (no label,
or a catch-all one, and nothing on its page or website) is researched, and approved only if research confirms its
industry (`industryConfirmed`); one with no LinkedIn page still isn't (nothing shows its size). 3PL & Logistics, with fewer companies to find and more ruled out, searches longer
(`SAMPLE_3PL_RULES`): it gives up only after 50 searches in a row find no new company, asks for 25% extra and takes up
to five rounds (each only while its last one found companies). The report tallies why the companies it checked
weren't approved, per segment, and (from 27 Oct 2026) where its credits went: per step (finding companies, website,
contact search, contact checks, news, must-have checks and so on) and per company researched and per approved company,
and (from 28 Oct 2026) how many of each segment's people searches found a new company, and what the company check did
before research: how many passed, how many it dropped and why (no LinkedIn page, industry not on the ICP, too small,
already known and so on), and why each round stopped searching.
A sample carried on from where it stopped uses them too.

**One capped engine wherever leads are found or researched** (INVECK's decision, 26 Oct 2026). Find new prospects on
the Dashboard (leads per segment, and who gets them) and the Configuration page's run start a prospect search on the
daily run's engine (`startProspectSearch` in `sample-run.ts`): its rules and its 4,000-credit limit, watched on the
Sourcing page. It deals nothing; when it finishes, its approved companies go into the pipeline as Approved, given to
the person or team chosen, or left for the morning draw. Research of any other lead (added by hand, imported, contacts
searched again) uses the same research rules (two contacts a company, no repeat look-ups; CA firms keep theirs) and
at most 4,000 credits a day (`RESEARCH_DAY_CREDITS` in `search-budget.ts`); what is left waits for the next day.

A Manufacturing or 3PL company whose website doesn't confirm a must-have ("holds physical inventory", "multiple
locations", "B2B") is approved, with what wasn't confirmed noted on the lead; only evidence against a must-have, or a
deal-breaker, rules it out, and no extra search is paid to settle one (`unconfirmedGoesAhead` in `fit.ts`; INVECK's
decisions, 3PL on 26 Oct 2026, Manufacturing on 27 Oct; the team's imported lists are treated the same way).

At 08:00 IST on weekdays the **morning draw** (`/api/cron/draw`) hands each active associate their own daily
list, per segment, set on the Team page: Anchal and Puja 40 Manufacturing each (their CA firms come apart, from
the sheet), Parimal and Anuradha 24 Manufacturing + 16 3PL & Logistics each (40 in the 12:8 ratio), so 160 a
day (128 + 32). Anyone without their own list gets the Settings defaults. Each segment is drawn separately, at
random, from researched leads nobody has been given yet and dealt round the team. A
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
  rounds. When every step is ticked the company is done for the day. Counters show leads assigned (their daily list), companies done (target 20), calls
  attempted (target 20 a day, per associate), connected calls, WhatsApp, emails and LinkedIn requests.
- **P2 flow**: after 5 unanswered calls to the point of contact, or a connected call logged as "Not the
  right person", the lead switches to the next person already found at the company (a P2 process owner
  after a P1, then P3; never HR, admin or quality), shown with a P2 badge, with a fresh plan from that day
  and the email rewritten for them. When nobody else is on file, Today asks for the next contact; naming
  them under Edit point of contact starts their plan. When nobody else is on file, the lead waits on its find step until someone is named: the person just ruled out never comes back as a fresh lead (fixed on 29 Oct 2026; leads that had, with nothing done on them since, were put back on the find step once, with a note).
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

### Inbound demo sheet

Demo requests from the website form land in a Google Sheet (default: the sheet ID in `INBOUND_DEMO_SHEET_ID`, tab
`INBOUND_DEMO_SHEET_TAB`, defaulting to the website form's sheet and its `Leads` tab). It is read with the same service
account as the CA firms sheet (`GOOGLE_SERVICE_ACCOUNT_JSON`): **share the sheet with that account's email as Viewer**. The
app never writes to it.

- **Who is imported.** Each valid row becomes a lead in the CRM as an inbound demo request (source "Inbound demo request
  (website form)", status Replied). Nothing is researched and no cold-call steps are planned. Formula-looking rows, rows marked
  "(ignore)" and rows with no name or email are not imported (they are listed on Settings).
- **Fields.** name, email, phone, company, location (city), persona (segment), plus the whole row is kept, including source,
  form type, answers, page, landing, referrer, UTM source/medium/campaign/term/content and the LinkedIn/Google click ids. They
  show on the lead page and as a source line on Today.
- **No duplicates.** A row's key is its `booking_id` (the form's booking id). Rows without one use submission time + email + form type. The same person
  submitting again is added to their one lead as a note; nothing is made twice however often the sync runs.
- **Who gets it.** A persistent rotation: Puja, Anuradha, Parimal, Anchal, then again. The place reached is saved, so later
  batches carry on. Names are matched to existing users by first name (a spelling such as "Pooja" or "Aanchal" also matches); a name with no
  user is reported, never created or guessed, and that turn is given to them once the user exists.
- **The meeting.** The slot the visitor chose on the form (`preferred_start_utc`, or `preferred_start_ist` such as "Sat 24 Oct
  2026, 10:00 IST"; a cancelled `status` books nothing), or a confirmed date/time column (`meeting_date`/`meeting_time`) books a Microsoft Teams meeting, titled "Demo for [Company] - Inveck", in
  that BDA's own calendar with the prospect as attendee; Microsoft sends the invitation. Then the lead becomes Meeting Booked
  and the meeting shows on the BDA's Today on its date with Join meeting. A row with no time, only a preferred time, an
  unconnected Outlook or no calendar permission is reported on Settings and tried again at the next sync. Nothing is booked
  by guesswork.
- **When it runs.** Whenever Today is open (every few minutes), a daily Vercel cron (`/api/cron/inbound-demos`; Hobby plans allow no more often than daily) and **Settings
  → Sync now**.

#### Syncing every five minutes without Vercel Pro

Vercel's free plan runs scheduled jobs once a day, so a free outside timer calls the sync every five minutes:

1. In Vercel (Settings → Environment Variables) add `INBOUND_SYNC_SECRET`: a random string of 24+ characters (for example from a password generator). Redeploy.
2. On cron-job.org (free), create a job: URL `https://inveck-lead-engine.vercel.app/api/cron/inbound-demos`, method GET, schedule every 5 minutes, and under Advanced add the header `Authorization` with the value `Bearer <your INBOUND_SYNC_SECRET>`.
3. The job's history should show status 200 and a short JSON result (`read`, `created`, `meetings`...). A 403 means the secret doesn't match.

This secret can only start the read-only sheet sync and wake the daily Morning Sample (start it when it is due, carry on
one that paused); it does not open anything else. Do not put it in the URL. With this timer live, the daily run needs
neither Vercel's scheduled jobs nor anyone opening a page.

## Configuration (administrators)

**Configuration** in the admin sidebar manages, per product (Inveck today; more can be added later and nothing about Movek exists yet):

| Section | What it holds | Notes |
| --- | --- | --- |
| Products | name, description, active, search mode | Deactivating stops new searches and allocation; nothing made is removed. |
| ICPs & Search | each ICP's industries, locations, company size, exclusions, titles and **search instructions**; the shared search-planning prompt; a preview of the effective prompt and what it is asked about; a button to start a run for the product | A new ICP is usable in Allocation, Templates and Follow-up rules at once. ICP names are used once across products (a lead's segment is its ICP's name). |
| Team Members | create/deactivate BDAs (BDA role only), assign each to several products | Login is the email; an existing email is refused. The random starting password is shown once and stored hashed. |
| Allocation | each BDA's daily total and an exact count per ICP | Counts must add up to the total or it won't save. |
| Templates | email subject/body and WhatsApp body per ICP, with `{{contact_name}}`, `{{first_name}}`, `{{greeting}}`, `{{company_name}}`, `{{bd_name}}` and a rendered preview | Editing a message while sending it never changes the template. |
| Follow-up Rules | number of follow-ups, working days apart, call outcomes that start them, per ICP (or the product default), with a schedule preview | Weekends and holidays never count. |

**Search mode.** *People first* is how Inveck searches today (LinkedIn job titles from the ICP) and is untouched. *AI planner* uses the shared prompt plus each active ICP's search instructions, sends them to DeepSeek to plan searches, and sends those to Serper. Inveck's built-in Manufacturing and 3PL & Logistics prompts are stored as the search instructions of those two ICPs (and the built-in shared prompt is used while the shared prompt is blank), so the AI planner builds exactly the prompt it always did. A product made later starts on the AI planner.

**What was carried forward (first start after deploying).** Inveck's ICPs, every BDA on Inveck, each BDA's allocation (their Team page numbers, else the Settings ones, plus CA firms for the CA associates: 10 each), the email and WhatsApp texts that used to be fixed, and the follow-up rules (5 every other working day; CA 3, a day apart). Existing leads, assignments, activities and follow-up history are not rewritten; leads only get a product and ICP label. Changes apply to future prospecting, allocation, messages and follow-ups.

**Allocation is not random.** Leads go out in a fixed order (those with a named decision-maker first, then oldest), dealt one at a time starting from where the last deal in that ICP stopped, so the extra lead of a remainder passes round the team. CA firms still come from their Google Sheet (the sheet's firms are picked as before; the per-BDA count is the CA Firms ICP's count in Allocation).

**Versions.** Every change to a product's configuration raises its configuration version. Each run records the product, that version and (on the AI planner) the exact prompt; leads record their product, ICP and the version in force when they were found or imported.

### Email and WhatsApp templates per step

Configuration → Templates: pick an ICP, write its email and WhatsApp templates, and assign one to each step: the first contact and every follow-up of that ICP's follow-up rule (the steps change with the rule). Email templates keep formatting (bold text, links, line breaks) as sanitized HTML, sent with the sender's signature; WhatsApp templates are plain text. Nothing is drafted by AI: a step with no template shows as Missing and nothing is written or sent for it until an administrator assigns one. Editing a message while sending it never changes its template. The earlier single email and WhatsApp template of each ICP became its "First contact" template, with the same wording.

## Blogs (the Inveck blog workspace)

A separate area at `/blogs`, built from the Article Basket project (topic discovery, approvals, article generation, scheduling and publishing, analytics) and reduced to Inveck alone: one profile, no domains to manage. It has its own login role (`blogs`), its own menu, and its own tables (`blog_*`, none linked to the CRM's). Nothing in the Lead Engine, Tracker or Marketing changes.

### Signing in

- Username `blogs@inveck`. The starting password is **not in the code**: it is read from the `BLOGS_INITIAL_PASSWORD` environment variable (8+ characters) when the app starts and the user does not exist yet, hashed like every other password, and never stored or shown. After the first login the app asks for a new password (Blogs → Account). Once the user exists the variable is ignored, so a changed password stays changed.
- Local: put `BLOGS_INITIAL_PASSWORD=<starting password>` in `.env.local` (gitignored). Production: add it under Vercel → Settings → Environment Variables, then redeploy. If the variable is missing the Blogs user simply isn't created.
- The Blogs user reaches only `/blogs` (the proxy and every page and action check the role); BDAs and the Marketing profile cannot reach it; the administrator (shared password) can reach everything.

### Where Inveck's prompts and settings go

**Blogs → Inveck Profile & Prompts** (`/blogs/profile`). Everything starts empty: audience, tone, rules, and one prompt box per stage (topic discovery, outline, writing, SEO, featured image). Each box is added to the end of that stage's built-in instructions, which only carry the grounding, honesty and output-format rules. Topic discovery and article writing stay off until the audience and tone are filled in. Authors are added under Settings & Integrations (none by default: no one is credited until you add them).

### Environment variables (names only)

| Variable | Used for | State |
|---|---|---|
| `BLOGS_INITIAL_PASSWORD` | Starting password of `blogs@inveck` | Set in the local `.env.local`; **add it in Vercel** |
| `DATABASE_URL` (or `POSTGRES_URL` / `SUPABASE_DB_URL`) | The database (Inveck's existing one) | Already configured |
| `APP_PASSWORD`, `SESSION_SECRET` | Logins and sessions (existing) | Already configured |
| `CRON_SECRET` | Bearer secret for `/api/cron/blogs` and `/api/cron/blogs/analytics` | Existing Inveck variable; must be set in Vercel |
| `GEMINI_API_KEY` | Writing, fact-checking, topic ideas (models `gemini-3.5-flash`, image `gemini-3.1-flash-image`) | **Missing** in Inveck |
| `EXA_API_KEY` | Research and news search (the "XA" connection) | **Missing** in Inveck |
| `WAVESPEED_API_KEY`, `WAVESPEED_IMAGE_MODEL` | Featured images (preferred; default model `google/nano-banana/text-to-image`) | **Missing** in Inveck |
| `POLLINATIONS_API_KEY`, `POLLINATIONS_IMAGE_MODEL` | Featured images (second choice; Gemini's image model is the fallback) | **Missing** in Inveck |
| `CMS_ADAPTER`, `CMS_BASE_URL`, `CMS_USERNAME`, `CMS_APP_PASSWORD` | Publishing to WordPress (`CMS_ADAPTER=mock` locally; production needs `wordpress`) | **Missing** in Inveck |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GSC_SITE_URL`, `GA4_PROPERTY_ID` | Search Console and GA4 (read-only). The service account is the one the CA sheet already uses; give its email access to the property | `GSC_SITE_URL` and `GA4_PROPERTY_ID` **missing** |
| `ALERT_WEBHOOK_URL`, `APP_URL` | Optional failure alerts and links | Optional |

The Gemini, Exa, WaveSpeed and Pollinations keys exist in Article Basket's own `.env.local`; they were not copied. Add them to Inveck's environment yourself.

### How it runs

Vercel calls `/api/cron/blogs` once an hour between 04:45 and 16:45 UTC (one daily entry per hour, because the Hobby plan runs a cron at most once a day; on Pro it can be every few minutes) for discovery, article jobs and publishing and `/api/cron/blogs/analytics` daily; both need `Authorization: Bearer <CRON_SECRET>` (Vercel adds it). Approving a topic also starts its job straight away. Locally, `CRON_SECRET=... npm run blogs:worker` calls the tick every 30 seconds. Featured images are kept in `blog_image_store` (no Supabase Storage) and shown only to Blogs users and the administrator.

