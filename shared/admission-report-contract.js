import {z} from 'zod';
import {admissionDecision,admissionSummary,admissionRecordedOutput} from './admission-contract.js';
const id=z.string().min(1).max(200);
export const admissionReevaluateInput=z.object({projectId:id,source:z.enum(['watches','candidates']),limit:z.number().int().min(1).max(100).optional(),cursor:z.string().max(1024).optional()}).strict();
export const admissionReevaluateOutput=z.object({project_id:id,source:z.enum(['watches','candidates']),rows:z.array(z.object({subject_id:id,decision:admissionDecision}).strict()),page_summary:admissionSummary,policy_revision:z.number().int().nonnegative(),disavow_revision:z.number().int().nonnegative(),next_cursor:z.string().nullable(),has_more:z.boolean(),report_only:z.literal(true),snapshot:z.literal(false),domain_cap_applied:z.literal(false)}).strict();
export const admissionReceiptInput=z.object({projectId:id,operationId:id}).strict();
export const admissionReceiptOutput=admissionRecordedOutput;
export const admissionReportResponses={reevaluate_admission:admissionReevaluateOutput.passthrough(),get_admission_decisions:admissionReceiptOutput.passthrough()};
