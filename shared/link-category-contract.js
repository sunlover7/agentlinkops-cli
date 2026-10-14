import {z} from 'zod';
import {LINK_TYPES} from './link-labels.js';
import {LINK_CATEGORY_CONTRACT} from './link-category.js';

const text=z.string().nullable(), amount=z.number().int().nonnegative().nullable();
const coverage=z.looseObject({assessed:amount,classified:amount,eligible:amount,retained:amount,excluded:amount,unassessed:amount,unclassified:amount,partial:z.boolean().nullable()})
  .describe('Occurrence counts for this watch. Null means unavailable. Assessed counts completed evaluations, including inconclusive ones. Classified counts occurrences with a determined role; partial describes type coverage. Retained includes excluded occurrences. Counts do not represent separate watched links.');
const role=z.looseObject({id:z.enum(LINK_TYPES),name:z.string(),standard_name:z.string(),count:z.number().int().nonnegative(),
  states:z.looseObject({suggested:z.number().int().nonnegative(),accepted_manual:z.number().int().nonnegative(),accepted_auto:z.number().int().nonnegative()})});
export const linkCategoryFields={
  category_contract:z.literal(LINK_CATEGORY_CONTRACT).optional().describe('Version of the shared table, API and export category projection.'),
  chosen_category:z.looseObject({intent:z.enum(['chosen','cleared','automatic']),id:z.enum(LINK_TYPES).nullable(),name:text,standard_name:text,
    actor_id:text,recorded_at:text,revision:z.number().int().nonnegative().describe('Saved label revision; pass as revision to set_link_type. Required for intent=automatic.'),deliberate_clear:z.boolean()}).optional()
    .describe('The team category and recorded author. Cleared keeps the type empty; automatic permits the page assessment to supply the displayed category. Neither action reviews or starts AI work.'),
  page_assessment:z.looseObject({status:z.enum(['ready','unavailable']),reason:z.string(),read_reason:text,explanation:z.string(),applicability:z.string(),
    binding:z.looseObject({workspaceId:z.string(),projectId:z.string(),watchId:z.string()}).nullable(),
    capture:z.looseObject({id:z.string(),manifest_id:text,observation_id:text,observed_at:text,expires_at:text}).nullable(),
    source:z.looseObject({state:text,observed_at:text,observation_id:text,pageUnavailable:z.boolean()}).nullable(),
    assessed_at:text,revision:z.number().int().nonnegative().describe('Highest retained eligible occurrence decision or review revision, or null. Evidence provenance, not a write token.').nullable(),
    model_revisions:z.array(z.looseObject({model:z.string(),revision:z.string().describe('Recorded model version or revision, or null. Evidence provenance, not a write token.').nullable()})),
    policy_revisions:z.array(z.looseObject({taxonomy_version:text,rubric_version:text,policy_revision:z.union([z.string(),z.number()]).nullable().describe('Recorded policy revision as a string or number, or null. Evidence provenance, not a write token.')})),
    roles:z.array(role),decision_state:z.enum(['suggested','accepted_manual','accepted_auto','mixed','none']),mixed:z.boolean(),coverage,
    pending_count:amount,failed_count:amount,job_count:amount,review_required_count:amount}).optional()
    .describe('What retained page evidence says about link occurrences. Applicability separates current, previous, expired and unavailable evidence. Suggested is provisional; accepted_manual requires a recorded review; accepted_auto requires a qualified saved policy.'),
  display_category:z.looseObject({source:z.enum(['chosen','page_assessment','none']),kind:z.enum(['category','mixed','cleared','unknown']),
    id:z.enum(LINK_TYPES).nullable(),name:z.string(),state:z.string(),reason:z.string(),applicability:z.string(),coverage}).optional()
    .describe('The category shown in the everyday table. A deliberate team choice takes precedence. Otherwise page evidence supplies a category or Mixed types, with its evidence state. Read the reason when no category is available.'),
};

// The same mutation receipts are consumed by command transports, REST clients
// and generated documentation. These are label changes, not occurrence reviews.
export const linkLabelledWatchResponse=z.looseObject({...linkCategoryFields,id:z.string(),type:z.string().nullable(),
  type_source:z.enum(['model','person']).nullable(),tags:z.array(z.looseObject({id:z.string(),name:z.string(),color:z.string()})),
  disavow:z.enum(['active','proposed']).nullable()});
export const linkLabelledWatchesResponse=z.looseObject({updated:z.number().int(),items:z.array(linkLabelledWatchResponse)});
