"""Escaped, self-contained HTML reports from explicitly selected local CRM data."""
import datetime as dt
from decimal import Decimal, localcontext
from html import escape
import json
import re
import urllib.parse


def cost(amount, currency):
    if amount is None and currency is None:
        return None, None
    if not isinstance(amount, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,6})?", amount):
        raise ValueError("cost_amount must be a nonnegative decimal string with at most six decimal places")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("cost_currency must be an uppercase three-letter currency label paired with cost_amount")
    return decimal_text(Decimal(amount)), currency


def decimal_text(value):
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def escaped(value):
    return escape(str(value) if value is not None else "", quote=True)


def link(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password or any(ord(char) < 32 for char in value):
            raise ValueError()
    except (ValueError, TypeError):
        return escaped(value)
    return '<a href="' + escaped(value) + '" target="_blank" rel="noopener noreferrer">' + escaped(value) + '</a>'


def render(connection, title, brand, generated_at, project_id=None, include_notes=False, include_costs=False):
    for name, value in (("title", title), ("brand", brand)):
        if not isinstance(value, str) or not value.strip() or len(value) > 300 or any(ord(char) < 32 for char in value):
            raise ValueError(name + " must be a nonempty label of at most 300 characters")
    query = "SELECT * FROM placements" + (" WHERE project_id=?" if project_id else "") + " ORDER BY COALESCE(project_id,''),source_url,target_url,id"
    connection.execute("BEGIN")
    try:
        placements = [dict(row) for row in connection.execute(query, (project_id,) if project_id else ())]
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    counts, totals, rows, observed_dates = {}, {}, [], []
    for placement in placements:
        cloud = json.loads(placement["cloud_state"])
        if not isinstance(cloud, dict) or not isinstance(cloud.get("state", "unobserved"), str):
            raise ValueError("A placement has malformed cloud state; repair the CRM before reporting")
        state = cloud.get("state", "unobserved")
        counts[state] = counts.get(state, 0) + 1
        observed_at = placement["cloud_observed_at"]
        if observed_at:
            observed_dates.append(observed_at)
        columns = [link(placement["source_url"]), link(placement["target_url"]), escaped(str(state).replace("_", " ")), escaped(observed_at or "No observation")]
        if include_notes:
            columns.append(escaped(placement["notes"]))
        if include_costs:
            amount, currency = cost(placement["cost_amount"], placement["cost_currency"])
            if amount is not None:
                with localcontext() as context:
                    context.prec = 50
                    totals[currency] = totals.get(currency, Decimal(0)) + Decimal(amount)
                columns.append(escaped(currency + " " + amount))
            else:
                columns.append("Not recorded")
        rows.append("<tr>" + "".join("<td>" + column + "</td>" for column in columns) + "</tr>")
    headings = ["Source page", "Destination", "Observed state", "Observation time (UTC offset shown)"]
    if include_notes:
        headings.append("Local notes (included by request)")
    if include_costs:
        headings.append("Recorded local cost")
    if not rows:
        rows.append('<tr><td colspan="' + str(len(headings)) + '">No placements match this report selection.</td></tr>')
    privacy = "Includes source and destination URLs, observed states and observation times."
    privacy += " Local notes are included by request." if include_notes else " Local notes are excluded."
    privacy += " Recorded costs are included by request." if include_costs else " Recorded costs are excluded."
    scope = "Selected project" if project_id else "All local placements"
    coverage = "No cloud observations are available for these placements."
    if observed_dates:
        chronological = sorted(observed_dates, key=lambda value: dt.datetime.fromisoformat(value.replace("Z", "+00:00")))
        coverage = "Observed timestamps range from " + chronological[0] + " to " + chronological[-1] + "."
    totals_html = ""
    if include_costs:
        totals_html = '<section class="costs"><h2>Recorded costs</h2>'
        if totals:
            totals_html += '<ul>' + ''.join('<li>' + escaped(currency + " " + decimal_text(amount)) + '</li>' for currency, amount in sorted(totals.items())) + '</ul>'
        else:
            totals_html += '<p>No costs are recorded for the selected placements.</p>'
        totals_html += '<p>Totals combine recorded amounts within each currency. No currency conversion, market valuation or tax calculation is applied.</p></section>'
    document = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>''' + escaped(title) + '''</title>
<style>
*{box-sizing:border-box}body{margin:0;color:#192b36;background:#f7f9fb;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1400px;margin:auto;padding:48px 36px}.brand{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;color:#c4472d}h1,h2{font-weight:600;line-height:1.12;letter-spacing:-.04em}h1{font-size:44px;margin:18px 0 20px}h2{font-size:27px}.meta,.coverage,.disclosure{color:#566570;font-size:13px;max-width:1000px}.coverage{border-left:2px solid #c4472d;padding-left:16px;margin-top:24px}.metrics{display:flex;flex-wrap:wrap;margin:32px 0;border-block:1px solid #d8dfe5}.metric{flex:1;min-width:160px;padding:20px 24px 20px 0}.metric+.metric{border-left:1px solid #d8dfe5;padding-left:24px}.metric strong{display:block;font-size:32px;font-weight:550;letter-spacing:-.03em}.metric span{font-size:12px;color:#566570}.table-region{overflow-x:auto;max-width:100%}table{border-collapse:collapse;width:100%;min-width:760px;background:#fff;font-size:13px;table-layout:fixed}caption{text-align:left;font-size:19px;font-weight:600;letter-spacing:-.025em;padding:0 0 16px}th,td{text-align:left;border-bottom:1px solid #d8dfe5;padding:15px;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#eef2f5;color:#566570;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}a{color:#192b36;text-underline-offset:3px}a:focus-visible{outline:3px solid #c4472d;outline-offset:3px}footer{border-top:1px solid #d8dfe5;margin-top:36px;padding-top:20px;font-size:12px;color:#566570}.costs{margin-top:32px}.costs p{font-size:13px;color:#566570}ul{padding-left:20px}@media(max-width:700px){main{padding:32px 20px}h1{font-size:34px}.metric{min-width:50%;padding:16px 12px}.metric+.metric{padding-left:12px}.metric:nth-child(odd){border-left:0}.metric:nth-child(n+3){border-top:1px solid #d8dfe5}}@media print{body{background:white}main{padding:0;max-width:none}.metric,th{background:#eef2f5}.table-region{overflow:visible}table{min-width:0;font-size:10px}th,td{padding:9px}th{font-size:9px}tr{break-inside:avoid}thead{display:table-header-group}a{color:#192b36;text-decoration:none}@page{size:landscape;margin:12mm}}
</style></head><body><main>
<div class="brand">''' + escaped(brand) + '''</div><h1>''' + escaped(title) + '''</h1>
<p class="meta">Generated ''' + escaped(generated_at) + " · " + escaped(scope) + ''' · Local CRM snapshot</p>
<p class="coverage">''' + escaped(coverage) + ''' This report does not perform new checks. Unknown or unobserved results do not establish link loss.</p>
<div class="metrics"><div class="metric"><strong>''' + str(len(placements)) + '''</strong><span>Selected placements</span></div><div class="metric"><strong>''' + str(counts.get("present", 0)) + '''</strong><span>Observed present</span></div><div class="metric"><strong>''' + str(counts.get("confirmed_missing", 0)) + '''</strong><span>Confirmed missing</span></div><div class="metric"><strong>''' + str(counts.get("unknown", 0) + counts.get("unobserved", 0)) + '''</strong><span>Unknown or unobserved</span></div></div>
<div class="table-region" role="region" aria-label="Selected placement observations" tabindex="0"><table><caption>Selected placement observations</caption><thead><tr>''' + ''.join('<th scope="col">' + escaped(heading) + '</th>' for heading in headings) + '''</tr></thead><tbody>''' + ''.join(rows) + '''</tbody></table></div>
''' + totals_html + '''<footer><p>''' + escaped(privacy) + ''' Contacts, messages, API credentials, disavow rules and raw cloud event payloads are not included.</p><p>Created with the local AgentLinkOps toolkit. This is an HTML report; browser print options are separate from report generation.</p></footer>
</main></body></html>
'''
    return document, {"format": "html", "placements": len(placements), "project_id": project_id, "generated_at": generated_at, "included_local_notes": include_notes, "included_local_costs": include_costs}
