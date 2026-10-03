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
   person. It finds the email in a fixed order: the team's own, the person's published address,
   Prospeo, then Apollo, then the company's email format (see below).
4. **Score and draft**: every qualified lead that can be reached gets a personalised
   email draft.

### How emails are found

Emails only: phone numbers are never requested from any provider. In order, most trustworthy first:

1. An address the sales team typed in: always kept, never replaced (checked only to label it).
2. The person's own address published on the company website, the web or a people-search page,
   confirmed by the mail-server check.
3. **Prospeo**, then **Apollo** when Prospeo has nothing verified, for a contact already
   identified: their LinkedIn profile when known, name and employer. A reply is used only for the
   same person (name, and LinkedIn profile when both have one) at the same employer (domain, or the
   company's name in full) with an address on the company's domain. Prospeo is asked for verified
   emails only, with mobile numbers off, and charges only when it finds one. A provider's "verified"
   counts as verified; any other status goes through the mail-server check and otherwise stays
   labelled unverified.
4. A published address that couldn't be confirmed (catch-all server), then a provider's unconfirmed one.
5. Inferred from the company's proven format (published format data, or its people's published
   addresses), always labelled **inferred**, including on a catch-all domain. Plain guesses are kept
   only when the mail server confirms them, also labelled inferred.

Each address keeps its source, our verdict, the provider's own status and the date it was returned,
apart from one another. Hunter is no longer a source; its email verifier is the mail-server check.
The best-ranked others at a company go through the same chain, within **Email lookups per company**
(Settings, default 3, counting paid requests to either provider; the main contact first; 0 switches
both off). Provider results, including "no match", are cached in the database (90 days for an
address, 30 for no match), so a person is never paid for twice; failed lookups are not cached.
Prospeo requests are spaced a little over a second apart (its free plan allows one a second). After a
refused key, used-up credits or a long rate limit, that provider isn't asked again in the same run.
Contact checks upgrade an inferred or unconfirmed address when a provider has a verified one, never
touch the team's addresses, and log a conflict for review when a provider's verified address differs
from one on file.

Configuration: `PROSPEO_API_KEY` and/or `APOLLO_API_KEY` (server-side environment variables; never
sent to the browser or logged) and optionally `HUNTER_API_KEY` for the mail-server check.

The one human step is **approval**. A person reads the draft, edits it if needed, approves
it and marks it as sent. Nothing is ever sent automatically.

### After the first email

- **Follow-ups**: marking a lead as sent schedules follow-up 1 (day 3) and 2 (day 7). Each run drafts the ones that are due; the team approves and sends them like the first email. A reply, meeting, win or loss stops the sequence.
- **Buying signals**: qualified leads get a Google News check for new plants, expansions, acquisitions, funding or audit news. The best one opens the draft, and each links to its article.
- **Pipeline**: a board from Awaiting Approval to Won/Lost; drag cards or use their menu.
- **Timeline**: every lead shows what happened and when, and the team can add notes, calls and meetings.
- **Dashboard**: the funnel with conversion rates, weekly emails and replies, the best segment and lead source, and follow-ups due.

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
   | `PROSPEO_API_KEY` | yes** | prospeo.io key for email lookup, asked first (emails only) |
   | `APOLLO_API_KEY` | yes** | apollo.io key for email lookup after Prospeo (emails only; needs People Enrichment API access, not on Apollo's free plan) |
   | `HUNTER_API_KEY` | optional | hunter.io key, used only to verify addresses (mail-server check) |
   | `APP_URL` | optional | Your public URL, if you use a custom domain |

   \* You need the key for whichever AI provider is selected in Settings.
   \*\* At least one email provider; with both, Prospeo is asked first.
4. Redeploy so the variables take effect, then open the site and log in.

A scheduled run starts at 06:00 IST on weekdays (`vercel.json`). It researches new
leads and runs the prospect search on the day chosen in Settings.

At 08:00 IST on weekdays the **morning draw** (`/api/cron/draw`) hands out the day's leads: 100 by
default (Settings, "Leads handed out each morning"), picked at random from researched leads nobody has
been given yet, shuffled and split evenly across the active team (25 each for four people). A lead is
drawn only once. Inbound leads still go out in turn the moment they arrive, and a lead a BDA adds by
hand stays theirs. If the schedule runs late, the first page opened after 08:00 runs the draw. The
Team page shows today's draw and how many leads are left for tomorrow. Long runs continue
in the background automatically, within Vercel's 300-second function limit.

## The team

Each BDA has their own login: `name@inveck` (for example `parimal@inveck`) with the starting password
`inveck123`, which the app asks them to change on first use (**Account**). Administrators log in with
the username empty and the `APP_PASSWORD`, and can reset a team member's password on the Account page.

- **Owners**: every lead has an owner. New leads, whether found by the engine or inbound, are shared out
  in turn (Parimal, Anuradha, Anchal, Puja, and round again). **Leads** opens on "My leads".
- **Inbound leads**: tick "Inbound lead" when adding companies. One nobody has touched after two hours is
  flagged at the top of the owner's Today list.
- **Today**: each person's work list, one card per company with every step at once: call, WhatsApp,
  email and LinkedIn request on day 1, then call + WhatsApp + email on each of the next three working
  days. Steps already logged today stay on the card, ticked, with Undo. A connected call needs a note and
  an outcome: Not interested, No requirement right now or Already using a solution ticks off everything
  else for that company; any other outcome keeps today's WhatsApp, email and LinkedIn and stops the later
  rounds. When every step is ticked the company is done for the day. Counters show companies done, calls
  attempted (target 25 a day), connected calls, WhatsApp, emails and LinkedIn requests.
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
