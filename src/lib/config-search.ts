import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { clients, products, type Icp, type Product } from './db/schema';
import { listIcps } from './config';
import { plannerInputs, queryPlannerPrompt } from './pipeline/prospects';
import { PROSPECT_QUERIES_BASE_PROMPT } from './pipeline/prompts';
import { isCaSegment } from './tasks';
import { getSettings } from './settings';

/**
 * What a prospecting run would ask for a product, before it runs: the effective planner prompt (the shared prompt, or
 * the built-in one, then each active ICP's own instructions), the product description the AI is told, and the ICP and
 * client text it is asked about. The same builders the run uses, so the preview is what would really be sent.
 */
export type PlannerPreview = {
  product: Product;
  mode: 'people_first' | 'ai_planner';
  icps: Icp[];
  systemPrompt: string;
  productDescription: string;
  inputs: string;
  /** Number of the configuration version a run would record. */
  version: number;
};

export async function plannerPreview(db: Db, productId: number): Promise<PlannerPreview | null> {
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) return null;
  const active = (await listIcps(db, productId)).filter((i) => i.active && !isCaSegment(i.segment));
  const settings = await getSettings(db);
  const clientRows = await db.select().from(clients);
  return {
    product,
    mode: product.searchMode,
    icps: active,
    systemPrompt: queryPlannerPrompt(active, product.searchPrompt),
    productDescription: product.description.trim() || settings.productDescription,
    inputs: plannerInputs(active, clientRows),
    version: product.configVersion,
  };
}

export const BUILT_IN_SEARCH_PROMPT = PROSPECT_QUERIES_BASE_PROMPT;
