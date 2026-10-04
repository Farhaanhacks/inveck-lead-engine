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
- **Same site**: their location is within 60 km of the lead's city, by Google Maps coordinates (each
  place looked up once and kept in the database, about 3 Serper credits per new place). A place the
  map doesn't know is "not known", never "another site".
- **A role the ICP wants**: a title on the ICP's lists, or one in a function the lists name
  (operations, supply chain, finance) at head, manager or lead level ("Senior Manager, Site
  Operations"). Engineers, associates, analysts and HR are left out; someone whose profile names no
  role isn't picked automatically (the team can add them by hand).

### Emails and phone numbers

Neither is looked up. The app finds the right person and their LinkedIn profile; an email or phone
number is kept only when the sales team types it in (Edit point of contact), labelled "entered by the
team". Drafts are still written for every qualified lead, to send from LinkedIn or once the team has
an address.

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
   | `APP_URL` | optional | Your public URL, if you use a custom domain |

   \* You need the key for whichever AI provider is selected in Settings.
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
