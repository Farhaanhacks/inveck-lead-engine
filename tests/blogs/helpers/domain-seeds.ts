// Test fixtures only: generic profiles for exercising the engine (including its stricter health and finance rules). The Inveck blog
// area has none of these: it has the single Inveck profile.


type Seed = {
  slug: string;
  name: string;
  audience: string;
  geography: string;
  locale: string;
  tone: string;
  defaultArticleLength: number;
  config: Record<string, unknown>;
};

const common = {
  internalLinking: { minLinks: 2, maxLinks: 6, rules: ['Link only to published ArticleBasket articles that are directly relevant', 'Use descriptive anchor text, never "click here"'] },
  seoRules: [
    'One H1 that contains the primary keyword naturally',
    'Descriptive H2/H3 headings; no keyword stuffing',
    'Meta description of 120-160 characters that matches the article',
    'Headline must not promise more than the article delivers',
  ],
};

export const DOMAIN_SEEDS: Seed[] = [
  {
    slug: 'business',
    name: 'Business',
    audience: 'Founders, managers and professionals following companies, markets and industry change',
    geography: 'Global',
    locale: 'en',
    tone: 'Clear, analytical and neutral. Explain the why behind the news.',
    defaultArticleLength: 1400,
    config: {
      researchSources: { preferred: ['Company filings and press releases', 'Reuters', 'Bloomberg', 'Financial Times', 'Official statistics bodies'], avoid: ['Anonymous forums as a sole source'], notes: 'Verify announcements, dates, statistics and market claims against a primary or major-outlet source.' },
      articleFormats: ['Explainer', 'Industry analysis', 'How-to guide', 'Listicle with context'],
      ...common,
      restrictedClaims: ['Unverified rumours about named companies', 'Claims of imminent acquisition without a credible source'],
      restrictedTopics: [],
      evidenceStandards: ['Every statistic names its source and year', 'Company claims are attributed to the company'],
      publishing: { categories: ['Business'], defaultTags: [] },
      validation: { requireHumanReview: false, blockPatterns: [], notes: ['Check company names, dates and figures for contradictions'] },
    },
  },
  {
    slug: 'technology',
    name: 'Technology',
    audience: 'Readers following software, AI, gadgets and the companies building them',
    geography: 'Global',
    locale: 'en',
    tone: 'Accurate, practical and plain-spoken. Define jargon the first time it appears.',
    defaultArticleLength: 1400,
    config: {
      researchSources: { preferred: ['Vendor documentation and release notes', 'Official changelogs', 'Ars Technica', 'The Verge', 'Peer-reviewed papers for AI claims'], avoid: [], notes: 'Verify product specifications, release dates, version numbers and compatibility claims.' },
      articleFormats: ['Explainer', 'Tutorial', 'Product comparison', 'News analysis'],
      ...common,
      restrictedClaims: ['Benchmark numbers without a cited source', 'Unreleased product specifications from leaks stated as fact'],
      restrictedTopics: [],
      evidenceStandards: ['Version numbers and dates come from official documentation', 'Leaks are labelled as unconfirmed'],
      publishing: { categories: ['Technology'], defaultTags: [] },
      validation: { requireHumanReview: false, blockPatterns: [], notes: ['Check versions, dates and compatibility statements'] },
    },
  },
  {
    slug: 'health',
    name: 'Health',
    audience: 'General readers looking for trustworthy health information',
    geography: 'Global',
    locale: 'en',
    tone: 'Careful, calm and plain. Never alarmist. Encourages talking to a qualified professional.',
    defaultArticleLength: 1500,
    config: {
      researchSources: { preferred: ['WHO', 'CDC', 'NHS', 'NIH / MedlinePlus', 'Peer-reviewed journals (PubMed)', 'Major medical centres'], avoid: ['Supplement vendors', 'Anecdotal forums', 'Press releases presented as evidence'], notes: 'Prefer systematic reviews and public health agencies.' },
      articleFormats: ['Explainer', 'Evidence summary', 'Symptom and condition overview', 'Lifestyle guide'],
      ...common,
      restrictedClaims: ['Cures or guaranteed outcomes', 'Specific diagnoses', 'Specific doses or treatment plans', 'Claims that replace medical advice'],
      restrictedTopics: ['Instructions to stop or change prescribed medication', 'Unproven cancer treatments'],
      evidenceStandards: ['Medical claims cite a named agency or peer-reviewed source', 'Studies are described accurately: population, design and limits', 'No invented studies or statistics'],
      publishing: { categories: ['Health'], defaultTags: [] },
      validation: {
        requireHumanReview: true,
        blockPatterns: ['\\bcures?\\b', '\\bguaranteed\\b', '\\bmiracle\\b', '\\bstop taking\\b', '\\bdosage of\\b'],
        notes: ['High-risk medical claims are blocked for human review', 'Include a clear "not medical advice" note'],
      },
    },
  },
  {
    slug: 'lifestyle',
    name: 'Lifestyle',
    audience: 'Readers looking for practical ideas on home, travel, food, relationships and everyday life',
    geography: 'Global',
    locale: 'en',
    tone: 'Warm, useful and specific. Avoids hype and unsupported promises.',
    defaultArticleLength: 1200,
    config: {
      researchSources: { preferred: ['Established publications', 'Official tourism and government bodies', 'Expert-authored guides'], avoid: ['Affiliate-driven listicles as sole sources'], notes: 'Verify factual claims; avoid unsupported promises about products or outcomes.' },
      articleFormats: ['How-to guide', 'Listicle with context', 'Explainer', 'Buyer guide'],
      ...common,
      restrictedClaims: ['Guaranteed results from a product or routine'],
      restrictedTopics: [],
      evidenceStandards: ['Product claims match the maker\'s published specifications', 'Prices and availability are dated or omitted'],
      publishing: { categories: ['Lifestyle'], defaultTags: [] },
      validation: { requireHumanReview: false, blockPatterns: [], notes: [] },
    },
  },
  {
    slug: 'finance',
    name: 'Finance',
    audience: 'Readers learning about money, markets, tax and personal finance',
    geography: 'Global',
    locale: 'en',
    tone: 'Precise and sober. Educational, never promotional.',
    defaultArticleLength: 1500,
    config: {
      researchSources: { preferred: ['Regulators (SEC, FCA, SEBI, RBI)', 'Central banks', 'Company filings', 'Official statistics', 'Reuters', 'Bloomberg'], avoid: ['Social media tips', 'Anonymous price targets'], notes: 'Verify numerical figures, dates and regulatory statements against primary sources.' },
      articleFormats: ['Explainer', 'Market analysis', 'Personal finance guide', 'Regulatory update'],
      ...common,
      restrictedClaims: ['Guaranteed returns', 'Personalised investment advice', 'Price predictions stated as fact', 'Unsupported "best stock to buy" claims'],
      restrictedTopics: ['Specific buy or sell recommendations'],
      evidenceStandards: ['Figures carry a source and a date', 'Regulatory statements link to the regulator'],
      publishing: { categories: ['Finance'], defaultTags: [] },
      validation: {
        requireHumanReview: true,
        blockPatterns: ['\\bguaranteed returns?\\b', '\\brisk[- ]free\\b', '\\byou should (buy|sell)\\b', '\\bcan\'t lose\\b'],
        notes: ['Block unsupported investment claims for human review', 'Include a clear "not financial advice" note'],
      },
    },
  },
];
