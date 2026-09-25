# INVECK Lead Engine

A web app that finds, researches and drafts outreach for INVECK India's prospects.
Everything happens in one run. Nobody needs Airtable or n8n.

1. **Find prospects** (optional): the AI plans Google searches from the target segments
   and existing clients, then picks real companies. Existing clients and known leads
   are skipped.
2. **Research**: for each new company it reads the website and scores the fit. It
   skips existing clients by name and by domain.
3. **Contact**: it searches LinkedIn (via Google) and Hunter, and the AI picks the best
   person. It finds the email cheapest-first: emails already known, emails on the
   website, the company's email pattern, then Hunter's finder.
4. **Score and draft**: reachable leads above the minimum score get a personalised
   email draft.

### How emails are found

Most trustworthy and cheapest first: an address the team typed in or Hunter already knows →
the person's address published on the company website or the web → the company's proven
email format (from Hunter, or the formats RocketReach/ZoomInfo/LeadIQ publish, read through
Google) → Hunter's email finder → common formats, kept only when Hunter confirms them.
Many company mail servers can't confirm single addresses; there, an address built from the
company's proven format is saved as **likely** (the way ZoomInfo shows business emails).
This can be switched off in Settings. Plain guesses are never saved.

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
   | `APP_PASSWORD` | yes | The shared login password |
   | `CRON_SECRET` | yes | Any long random string (protects the scheduled run) |
   | `DEEPSEEK_API_KEY` | yes* | DeepSeek key (the default AI) |
   | `ANTHROPIC_API_KEY` | optional* | Only needed if you switch the AI to Claude in Settings |
   | `SERPER_API_KEY` | yes | serper.dev key for Google / LinkedIn search |
   | `HUNTER_API_KEY` | yes | hunter.io key for emails |
   | `APP_URL` | optional | Your public URL, if you use a custom domain |

   \* You need the key for whichever AI provider is selected in Settings.
4. Redeploy so the variables take effect, then open the site and log in.

A scheduled run starts at 09:00 IST on weekdays (`vercel.json`). It researches new
leads and runs the prospect search on the day chosen in Settings. Long runs continue
in the background automatically, within Vercel's 300-second function limit.

## Using it

- **Targets**: edit the segments (ICPs) and paste the current client list, so no one
  who's already a client gets contacted.
- **Add companies**: add one company, or paste many as `Company, website, city, segment`.
- **Dashboard → Find prospects & research**: starts a run you can watch live on the **Runs** page.
- **Leads**: filter by status, open a lead, edit the draft, then **Approve** and **Mark as sent**.
- **Settings**: daily limit, minimum score, AI provider/model, sender details and the
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
