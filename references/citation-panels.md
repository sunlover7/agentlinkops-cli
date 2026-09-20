# Citation panels

A panel records the questions, target sites, engines and sample budget for a citation check. Start with questions your audience has actually asked. Keep each question's source and collection date in your own research notes. Search Console queries, support conversations and public discussion threads can help when you already have access; the panel builder does not fetch or validate them.

Create an editable draft without calling a provider:

```sh
agentlinkops citation panel --domain example.com --brand Example --topic "backlink monitoring" --out panel.json
```

This command defaults to the mock engine. Its suggested questions are writing prompts, not measured search demand. Replace them with the questions you chose. Repeat `--prompt "Your question"` to supply your own questions directly. The command refuses to overwrite an existing output file.

Use `--competitors competitors.json` to add domains to check beside your own. The file is an array of objects with `domain`, `brand` and optional `aliases` fields. Each target gets separate results for each question. A target missing from one answer is only missing from that sample; it does not establish absence from the engine.

Choose a live engine explicitly after checking access and budget. For accountless browser measurement, use `--engine chatgpt:web-own-browser` or `--engine grok:web-own-browser`. `--engine google-aio` requires your configured supplier access. This workflow does not create accounts or buy services.

Starting with CLI 0.6.7, browser authentication defaults to `AGENTLINKOPS_BROWSER_AUTH=accountless`. This mode does not load saved browser sessions, even if session files already exist. A login wall, blocked page or failed answer remains unknown; anonymous access is not guaranteed. Use accountless measurement for this workflow. The optional legacy `AGENTLINKOPS_BROWSER_AUTH=saved-session` mode is separate and requires an explicit opt-in; logging in is not a prerequisite for the default workflow.

Starting with CLI 0.6.5, browser measurement requires `AGENTLINKOPS_PROXY_URL`. Missing, failed or quarantined proxy admission never selects direct traffic. An explicitly authorized direct diagnostic requires `AGENTLINKOPS_BROWSER_EGRESS=direct-diagnostic` with no proxy configured. The standard URL proxy has no usage meter; estimated costs are not a provider invoice cap.

Set `--locale en-GB --country GB` for a British locale draft. The mock engine supports locale fixtures. The Google AIO supplier path supports US and GB location requests; other engine paths refuse non-default locale requests in this version. Legacy default browser observations do not prove US proxy egress. Reports disclose the requested context and its basis; they do not treat it as verified user geography.

After reviewing the draft, run the [local CLI workflow](cli.md) and inspect the retained evidence:

```sh
agentlinkops citation run panel.json --max-usd 1
agentlinkops citation report panel.json --last 2 --out report.html
```

Keep brand mentions separate from links. Retained answer text can mention a brand and cite it in the same observation. Unknown or failed answers remain unknown. Reports keep engine, question, target and non-default locale identities separate; they do not produce an engine-wide share-of-voice score.
