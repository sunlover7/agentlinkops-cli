import {z} from 'zod';

const id=z.string().min(1).max(200);
const text=max=>z.string().trim().min(1).max(max).refine(v=>!/[\u0000-\u001f\u007f]/.test(v),'Control characters are not allowed');
// External references are opaque record keys, never contact methods or credentials.
export const contactExternalRef=text(200).refine(v=>!/@|https?:\/\//i.test(v),'Use an opaque source record reference');
const contactUrl=z.url().max(2000).refine(value=>{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;},'Use an HTTP contact page without credentials');
export const contactFields=z.object({externalRef:contactExternalRef,name:text(120),email:z.email().max(254).nullable(),contactUrl:contactUrl.nullable()}).strict();
const recordRevision=z.uuid().describe('Revision of this saved contact. Supply it as revision when updating or deleting the contact.');
const expectedRevision=z.union([z.literal(0),recordRevision]).describe('Current contact revision from list_contacts or save_contact; 0 creates.');
export const contactRecord=contactFields.extend({id,projectId:id,revision:recordRevision,createdAt:z.string(),updatedAt:z.string(),attention:z.unknown().nullable().optional(),relatedRecords:z.array(z.object({watchId:id,sourceUrl:z.string().nullable(),publisherUrl:z.string(),targetUrl:z.string(),progress:z.string().nullable(),monitoring:z.boolean(),participationId:id.optional(),campaign:z.string().optional(),lastContactedAt:z.string().nullable().optional()}).strict()).optional(),hasMoreRelatedRecords:z.boolean().optional()}).strict();
export const CONTACT_TERMS_VERSION='publisher-contacts-v1';
export const CONTACT_TERMS_URL='https://agentlinkops.com/terms/#your-data';
export const saveContactInput=z.object({projectId:id,revision:expectedRevision,contact:contactFields,acceptTermsVersion:z.string().min(1).max(80).optional().describe('Supply the current terms version only after an owner or administrator explicitly agrees for everyone saving contacts on this website. Never infer agreement from an import or contact read.')}).strict();
export const saveContactOutput=z.object({contact:contactRecord,replayed:z.boolean()}).strict();
// An opaque association revision prevents a stale editor from matching a new association
// after a contact deletion cascades the old row. Zero means no association exists yet.
const linkRevisionDescription='Current association revision from list_contacts; 0 creates the first association.';
const linkRevision=z.union([z.literal(0).describe(linkRevisionDescription),z.uuid().describe(linkRevisionDescription)]).describe(linkRevisionDescription);
export const contactLink=z.object({watchId:id,contactId:id.nullable(),revision:linkRevision}).strict();
export const listContactsInput=z.object({projectId:id,externalRef:contactExternalRef.optional(),contactId:id.optional(),watchId:id.optional(),after:id.optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const contactTermsState=z.object({version:z.string(),accepted:z.boolean(),canAcknowledge:z.boolean(),ready:z.boolean(),url:z.literal(CONTACT_TERMS_URL)}).strict();
export const listContactsOutput=z.object({items:z.array(contactRecord),nextAfter:id.nullable(),link:contactLink.nullable(),terms:contactTermsState.optional()}).strict();
export const deleteContactInput=z.object({projectId:id,contactId:id,revision:recordRevision,onlyIfUnlinked:z.boolean().default(false)}).strict();
export const deleteContactOutput=z.object({contactId:id,deleted:z.boolean()}).strict();
export const setLinkContactInput=z.object({projectId:id,watchId:id,contactId:id.nullable(),revision:linkRevision}).strict();
export const contactResponses={list_contacts:listContactsOutput,save_contact:saveContactOutput,delete_contact:deleteContactOutput,set_link_contact:contactLink};
