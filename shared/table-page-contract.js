import {z} from 'zod';
const filter=z.strictObject({column:z.string().min(1).max(80),operator:z.enum(['contains','is','is_not','empty']),value:z.string().max(500)});
export const browsePageInput={
 browse:z.boolean().optional().describe('Server-sorted authorized saved rows; omit for legacy paging.'),
 sort:z.string().min(1).max(80).optional().describe('Allowlisted saved-field identifier.'),
 order:z.enum(['asc','desc']).optional().describe('Sort direction; stable ID ties, nulls last.'),
 q:z.string().max(500).optional().describe('Literal search of supported saved fields.'),
 table_filters:z.union([z.string().max(8192),z.array(filter).max(12)]).optional().describe('Up to 12 allowlisted column filters before paging.'),
};
export const browseCursor=z.string().min(1).max(16384);
const count=z.number().int().nonnegative().nullable();
export const browsePageOutput={total:count.optional(),has_more:z.boolean().optional(),next_cursor:browseCursor.nullable().optional(),
 page:z.strictObject({limit:z.number().int().positive(),sort:z.string(),order:z.enum(['asc','desc']),total:count,query_scope:z.literal('server_dataset'),nulls:z.literal('last')}).optional()};
