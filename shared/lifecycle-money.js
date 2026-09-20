import {LIFECYCLE_LIMITS} from './lifecycle-contract.js';
// SIX ISO 4217 List One, published2026-09-17, retrieved2026-09-20.
// https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
export const CURRENCY_MINOR_DIGITS=Object.freeze({"AED": 2, "AUD": 2, "BHD": 3, "BRL": 2, "CAD": 2, "CHF": 2, "CNY": 2, "CZK": 2, "DKK": 2, "EUR": 2, "GBP": 2, "HKD": 2, "HUF": 2, "IDR": 2, "ILS": 2, "INR": 2, "JPY": 0, "KRW": 0, "KWD": 3, "MXN": 2, "MYR": 2, "NOK": 2, "NZD": 2, "OMR": 3, "PHP": 2, "PLN": 2, "SAR": 2, "SEK": 2, "SGD": 2, "THB": 2, "TRY": 2, "USD": 2, "VND": 0, "ZAR": 2});
export function decimalCostToMinor(amount,currency){
 const scale=CURRENCY_MINOR_DIGITS[currency];
 if(scale===undefined||typeof amount!=='string'||amount.length>40||!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount))throw new Error('Cost requires an unsigned decimal string and supported currency');
 const [whole,fraction='']=amount.split('.');
 if(fraction.slice(scale).replaceAll('0',''))throw new Error('Cost has precision smaller than the currency minor unit');
 const minor=BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.slice(0,scale).padEnd(scale,'0')||'0');
 if(minor>BigInt(LIFECYCLE_LIMITS.costMinor))throw new Error('Cost exceeds the lifecycle amount limit');
 return Number(minor);
}
export function minorCostToDecimal(amount,currency){
 const scale=CURRENCY_MINOR_DIGITS[currency];
 if(scale===undefined||!Number.isSafeInteger(amount)||amount<0||amount>LIFECYCLE_LIMITS.costMinor)throw new Error('Invalid minor-unit cost');
 const digits=String(amount).padStart(scale+1,'0');return scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits;
}
export function legacyCostPatch(input){
 const {cost_amount,cost_currency,...deal}=input;
 if('costMinor' in deal||'currency' in deal)throw new Error('Do not combine legacy and minor-unit cost fields');
 if(cost_amount===null&&cost_currency===null)return {...deal,costMinor:null,currency:null};
 return {...deal,costMinor:decimalCostToMinor(cost_amount,cost_currency),currency:cost_currency};
}
