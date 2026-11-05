import {z} from 'zod';

export const initialOnboarding = () => ({version:1,revision:0,step:'website',projectId:null,gsc:null,returnTo:null,completedAt:null});
export const onboardingState = z.object({
  version:z.literal(1),revision:z.number().int().nonnegative(),step:z.enum(['website','google','finish','complete']),
  projectId:z.string().nullable(),gsc:z.enum(['connected','later']).nullable(),returnTo:z.string().nullable(),completedAt:z.string().nullable(),
});
export const onboardingResponse = z.object({required:z.boolean(),state:onboardingState.nullable()});

// Keep only the two existing account-return destinations. Never persist an OAuth code,
// bearer, arbitrary URL or user-supplied permission scope in workspace metadata.
export function onboardingReturnTo(value) {
  if(typeof value!=='string'||!value.startsWith('#/'))return null;
  const [route,query]=value.slice(2).split('?'),params=new URLSearchParams(query);
  if(route==='workspace'&&params.get('section')==='invitations')return '#/workspace?section=invitations';
  const clientId=params.get('clientId');
  if(route==='access'&&params.get('section')==='grants'&&params.getAll('clientId').length===1&&clientId&&clientId.length<=2048&&!/[\s\u0000-\u001f\u007f]/.test(clientId))
    return `#/access?${new URLSearchParams({section:'grants',clientId})}`;
  return null;
}
