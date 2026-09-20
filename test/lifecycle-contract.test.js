import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDeal,mergeDeal,lifecycleUpdateInput,lifecycleReportInput,validCalendarDate} from '../shared/lifecycle-contract.js';
test('deal fields preserve zero minor units, paired clears, real dates and opaque contact references',()=>{
 const deal=mergeDeal(emptyDeal(),{costMinor:0,currency:'JPY',expiresOn:'2028-02-29',contactRef:'crm_ab12',contactLabel:'Publisher A'});assert.equal(deal.costMinor,0);assert.equal(deal.renewalWindowDays,null);
 assert.equal(mergeDeal(deal,{costMinor:null,currency:null,contactRef:null,contactLabel:null}).currency,null);
 for(const patch of [{costMinor:1},{costMinor:1.1,currency:'USD'},{costMinor:-1,currency:'USD'},{costMinor:1,currency:'ZZZ'},{expiresOn:'2027-02-29'},{expiresOn:'2026-04-31'},{renewalWindowDays:0},{contactRef:'owner@example.com'},{contactRef:'https://crm.test/id'},{contactLabel:'x@y.test'},{contactLabel:'+1 212 555 1234'}])assert.throws(()=>mergeDeal(deal,patch));
 assert.equal(validCalendarDate('0000-01-01'),false);assert.equal(validCalendarDate('2026-09-20'),true);
 assert.equal(lifecycleUpdateInput.safeParse({projectId:'p',watchId:'w',revision:0,deal:{}}).success,false);
 assert.equal(lifecycleUpdateInput.safeParse({projectId:'p',watchId:'w',revision:0,deal:{tags:['other-system']}}).success,false);
 assert.equal(lifecycleReportInput.safeParse({projectId:'p',from:'2026-10-01',to:'2026-09-01'}).success,false);
});
