import {z} from 'zod';
export const LIFECYCLE_LIMITS=Object.freeze({costMinor:1_000_000_000_000,reportRows:1000,renewalRows:100,eventsPerWatch:100});
// Supported ISO 4217 subset; unsupported currencies are refused, never guessed or converted.
export const LIFECYCLE_CURRENCIES=Object.freeze(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF','CNY','HKD','SGD','INR','KRW','BRL','MXN','SEK','NOK','DKK','PLN','CZK','HUF','ZAR','AED','SAR','ILS','THB','TRY','IDR','MYR','PHP','VND','KWD','BHD','OMR']);
export function validCalendarDate(value){return typeof value==='string'&&/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export const lifecycleDate=z.string().refine(validCalendarDate,'Expected a real YYYY-MM-DD calendar date');
const id=z.string().min(1).max(200),clean=max=>z.string().max(max).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Control characters are not allowed');
export const lifecycleDeal=z.object({costMinor:z.number().int().min(0).max(LIFECYCLE_LIMITS.costMinor).nullable(),currency:z.enum(LIFECYCLE_CURRENCIES).nullable(),acquiredOn:lifecycleDate.nullable(),expiresOn:lifecycleDate.nullable(),renewalWindowDays:z.number().int().min(1).max(365).nullable(),contactRef:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,119}$/).nullable(),contactLabel:clean(120).refine(v=>!/@|https?:\/\/|\+?\d[\d\s().-]{7,}\d/.test(v),'Use a display label, not contact details').nullable(),dealNote:clean(1000).nullable()}).strict().refine(d=>(d.costMinor===null)===(d.currency===null),'Cost and currency travel together').refine(d=>d.contactLabel===null||d.contactRef!==null,'A contact label needs an opaque contact reference').refine(d=>!d.acquiredOn||!d.expiresOn||d.acquiredOn<=d.expiresOn,'Expiry cannot precede the supplied acquisition date');
export const lifecyclePatch=z.object(lifecycleDeal.shape).partial().strict();
export const lifecycleUpdateInput=z.object({projectId:id,watchId:id,revision:z.number().int().nonnegative(),deal:lifecyclePatch}).strict().refine(v=>Object.keys(v.deal).length>0,'A metadata patch is required');
export const lifecycleGetInput=z.object({projectId:id,watchId:id}).strict();
export const lifecycleReportInput=z.object({projectId:id,from:lifecycleDate.optional(),to:lifecycleDate.optional()}).strict().refine(v=>!v.from||!v.to||v.from<=v.to,'Date range is reversed');
export const lifecycleRenewInput=z.object({projectId:id,limit:z.number().int().min(1).max(LIFECYCLE_LIMITS.renewalRows).default(100)}).strict();
export const lifecycleOutput=z.object({watchId:id,projectId:id,revision:z.number().int().nonnegative(),deal:lifecycleDeal,createdAt:z.string().nullable(),updatedAt:z.string().nullable()}).strict();
export function emptyDeal(){return {costMinor:null,currency:null,acquiredOn:null,expiresOn:null,renewalWindowDays:null,contactRef:null,contactLabel:null,dealNote:null};}
export function mergeDeal(previous,patch){
 if(('costMinor' in patch)!==('currency' in patch))throw new Error('Set or clear costMinor and currency together');
 return lifecycleDeal.parse({...previous,...patch});
}

export const lifecycleRenewOutput=z.object({emitted:z.number().int().nonnegative(),evaluated:z.number().int().nonnegative(),more:z.boolean(),asOf:lifecycleDate,delivery:z.literal('retained_only')}).strict();
export const lifecycleReportOutput=z.object({projectId:id,periodBasis:z.literal('customer_supplied_acquired_on'),buckets:z.array(z.object({website:z.string(),state:z.string(),period:z.string(),currency:z.enum(LIFECYCLE_CURRENCIES),placements:z.number().int().nonnegative(),costMinor:z.number().int().nonnegative(),confirmedMissingCostMinor:z.number().int().nonnegative(),lostBeforeExpiryCostMinor:z.number().int().nonnegative()}).strict()),noCost:z.number().int().nonnegative(),excludedUndated:z.number().int().nonnegative(),scope:z.string()}).strict();
