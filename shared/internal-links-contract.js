// Shared UI/agent limits. These are research captures, not recurring monitor enrollment.
export const INTERNAL_LINK_VERSION = 'internal-links-v1';
export const INTERNAL_LINK_LIMITS = Object.freeze({inventoryPages:100,pagesPerRequest:3,pageBytes:2*1024*1024,
  pageTimeoutMs:20_000,requestTimeoutMs:65_000,edgesPerPage:1000,evidenceBytesPerPage:1024*1024,workspacePagesPerDay:300,
  retainedSnapshotsPerProject:20,retentionDays:30,pageSize:100,leaseMs:90_000});
export const INTERNAL_LINK_SOURCES = Object.freeze(['sitemap_discovery','url_list','sitemap_export','cms_export','repository_export','search_export']);
export const INTERNAL_LINK_VIEWS = Object.freeze(['pages','edges','findings','diff','summary','graph','actions']);
export const INTERNAL_LINK_SCAN_VIEWS = Object.freeze(['pages','edges','findings','summary','graph','actions','opportunities','changes','map','inventory']);
export const INTERNAL_LINK_SCAN_SORTS = Object.freeze(['url','incoming','outgoing','score','impressions']);
export const INTERNAL_LINK_PAGE_HEALTH_BUCKETS = Object.freeze(['no_observed_issues','needs_review','no_incoming','broken_outgoing','unknown','pending','excluded','unassessed']);
export const INTERNAL_LINK_SCAN_CADENCES = Object.freeze(['off','weekly','monthly']);
export const INTERNAL_LINK_REGIONS = Object.freeze(['main','navigation','footer','header','aside','unknown']);

import {z} from 'zod';
const id=z.string().min(1).max(200),n=z.number().int().nonnegative(),time=z.string();
export const internalLinkPageHealthSummary=z.strictObject({version:z.literal('observed-page-health-v1'),readiness:z.enum(['ready','not_ready']),
 scope:z.strictObject({kind:z.literal('saved_scan_observations'),completeSiteCensus:z.literal(false),incomingBasis:z.literal('distinct_other_pages_all_link_regions'),
  eligibleBasis:z.literal('complete_indexable_html_at_own_canonical_address'),frontierTruncated:z.boolean().nullable(),allInventoryPagesComplete:z.boolean().nullable()}),
 pages:n.nullable(),assessedPages:n.nullable(),counts:z.strictObject(Object.fromEntries(INTERNAL_LINK_PAGE_HEALTH_BUCKETS.map(key=>[key,n]))).nullable(),
 reasons:z.record(z.string(),n).nullable(),brokenOutgoingPairs:n.nullable()});
const limits=z.strictObject(Object.fromEntries(Object.entries(INTERNAL_LINK_LIMITS).map(([key,value])=>[key,z.literal(value)])));
const snapshotCoverage=z.strictObject({inventory:z.enum(['declared_complete','partial']),representation:z.literal('raw_html'),completeSiteCensus:z.literal(false),allInventoryPagesComplete:z.boolean(),renderedVisibility:z.literal(false),iframes:z.literal(false),shadowRoots:z.literal(false),canonicalAliasesMerged:z.literal(false)});
export const INTERNAL_LINK_DISCOVERY_LIMITS=Object.freeze({sitemapDocuments:3,indexDepth:2,timeoutMs:20_000,documentBytes:2*1024*1024,offeredUrls:100,inventoryUrlBytes:128*1024,requests:10,retentionMs:15*60_000,startsPerMinute:3});
const discoveryLimits=z.strictObject(Object.fromEntries(Object.entries(INTERNAL_LINK_DISCOVERY_LIMITS).map(([key,value])=>[key,z.literal(value)])));
const discoveryDocument=z.strictObject({requestedUrl:z.string(),finalUrl:z.string().nullable(),checkedAt:time,sha256:z.string().nullable(),status:n.nullable(),reason:z.string().nullable(),kind:z.enum(['robots','index','urlset','unknown'])});
const discoveryCoverage=z.strictObject({completeSiteCensus:z.literal(false),truncated:z.boolean(),reasons:z.array(z.string())});
export const internalLinkInventoryProvenance=z.strictObject({previewId:id,discoveredAt:time,domain:z.string(),documents:z.array(discoveryDocument).max(13),coverage:discoveryCoverage,selectedUrls:z.array(z.string()).max(100)});
export const internalLinkPreviewOutput=z.strictObject({preview:z.strictObject({id,projectId:id,domain:z.string(),createdAt:time,expiresAt:time,state:z.enum(['pending','complete']),urls:z.array(z.string()).max(100),documents:z.array(discoveryDocument).max(13),coverage:discoveryCoverage}),limits:discoveryLimits});
export const internalLinkSnapshot=z.strictObject({id,projectId:id,createdAt:time,expiresAt:time,completedAt:time.nullable(),
 inventoryProvenance:internalLinkInventoryProvenance.optional(),state:z.enum(['pending','running','complete']),inventoryCount:n,processedCount:n,completeCount:n,unknownCount:n,pendingCount:n,edgeCount:n,revision:n,
 busy:z.boolean(),retryAfterSeconds:n,scope:z.strictObject({domain:z.string(),hostPolicy:z.literal('exact_hostname'),seeds:z.array(z.string())}),coverage:snapshotCoverage,version:z.literal(INTERNAL_LINK_VERSION)});
const capture=z.strictObject({version:z.literal(1),representation:z.enum(['raw_html','rendered_dom','document']),requestedUrl:z.string(),finalUrl:z.string(),httpStatus:n,acquiredAt:time,
 body:z.strictObject({complete:z.boolean(),truncated:z.boolean(),bytes:n,sha256:z.string(),decodedSha256:z.string(),charset:z.string().nullable().optional()}),
 transport:z.strictObject({id:z.string(),version:z.string(),qualified:z.boolean()}),coverage:z.strictObject({mainDocument:z.literal(true),iframes:z.boolean(),shadowRoots:z.boolean()})});
const pageCoverage=z.strictObject({representation:z.enum(['raw_html','rendered_dom']),documentComplete:z.boolean(),linksObserved:n,linksRetained:n,renderedVisibility:z.boolean(),iframes:z.literal(false),shadowRoots:z.literal(false),canonicalAliasesMerged:z.literal(false)});
export const internalLinkPage=z.strictObject({url:z.string(),source:z.enum(INTERNAL_LINK_SOURCES),important:z.boolean(),excluded:z.boolean(),state:z.enum(['pending','complete','unknown']),reason:z.string().nullable(),checkedAt:time.nullable(),finalUrl:z.string().nullable(),httpStatus:n.nullable(),
 title:z.string().nullable().optional(),canonicalUrl:z.string().nullable().optional(),noindex:z.boolean().optional(),nofollow:z.boolean().optional(),
 capture:capture.optional(),redirects:z.array(z.strictObject({from:z.string(),to:z.string(),status:n})).optional(),extractorVersion:z.literal(INTERNAL_LINK_VERSION).optional(),coverage:pageCoverage.optional(),
 incomingContextual:n,outgoingContextual:n,depth:n.nullable()});
export const internalLinkEdge=z.strictObject({id:z.string(),sourceUrl:z.string(),sourceDocumentUrl:z.string(),targetUrl:z.string(),targetHref:z.string(),anchor:z.string(),passage:z.string(),region:z.enum(INTERNAL_LINK_REGIONS),contextual:z.boolean(),regionEvidence:z.literal('html_landmark'),rel:z.array(z.string()),locator:z.strictObject({line:n,column:n,offset:n}).nullable(),checkedAt:time,captureSha256:z.string()});
const findingEvidence=z.strictObject({checkedAt:time.nullable(),captureSha256:z.string().nullable(),inventorySource:z.enum(INTERNAL_LINK_SOURCES),inventoryCompleteDeclared:z.boolean(),allInventoryPagesComplete:z.boolean(),reason:z.string().nullable().optional(),incomingContextual:n.optional(),outgoingContextual:n.optional(),importanceSource:z.literal('user').optional(),finalUrl:z.string().optional(),seeds:z.array(z.string()).optional(),targetUrl:z.string().optional(),targetCheckedAt:time.nullable().optional(),httpStatus:n.optional()});
export const internalLinkFinding=z.strictObject({id:z.string(),kind:z.enum(['coverage_unknown','redirected_page','orphan_candidate','no_contextual_outgoing','underlinked_priority','unreachable_from_seeds','broken_destination']),pageUrl:z.string(),priority:z.enum(['high','medium','low']),message:z.string(),evidence:findingEvidence});
export const internalLinkDifference=z.strictObject({kind:z.enum(['added','newly_observed','no_longer_observed','unknown']),edge:internalLinkEdge,comparison:z.literal('snapshot_observation'),reason:z.string().nullable().optional(),confirmedLoss:z.literal(false).optional()});
const healthCoverage=z.strictObject({inventory:z.enum(['declared_complete','partial']),allInventoryPagesComplete:z.boolean(),orphanStatus:z.literal('candidates_only'),depthScope:z.literal('explicit_seeds_and_supplied_inventory'),representation:z.literal('raw_html'),classification:z.literal('html_landmark'),semanticGroups:z.literal('not_assessed'),renderedVisibility:z.literal(false)});
export const internalLinkSnapshotOutput=z.strictObject({snapshot:internalLinkSnapshot,limits,retryAt:time.nullable().optional()});
export const internalLinkListOutput=z.strictObject({items:z.array(internalLinkSnapshot).max(100),total:n,nextCursor:z.string().nullable(),limits});
export const internalLinkSummary=z.strictObject({coverage:z.strictObject({pages:n,complete:n,unknown:n,pending:n,edges:n}),
 unknownByReason:z.array(z.strictObject({reason:z.string().nullable(),count:n})).max(50),
 findingsByKind:z.array(z.strictObject({kind:z.string(),priority:z.enum(['high','medium','low']),count:n})).max(50),
 findingsTotal:n,findingsReady:z.boolean()});
export const internalLinkCluster=z.strictObject({segment:z.string(),pages:n,complete:n,unknown:n,pending:n,
 broken:n,orphanCandidates:n,topPage:z.strictObject({url:z.string(),title:z.string().nullable(),incomingContextual:n}).nullable()});
export const internalLinkNeighborhood=z.strictObject({pageUrl:z.string(),incomingTotal:n,outgoingTotal:n,
 incoming:z.array(z.string()).max(100),outgoing:z.array(z.string()).max(100),contextualOnly:z.boolean()});
export const internalLinkAction=z.strictObject({id:z.string(),kind:z.enum(['retarget_broken','retarget_redirected','add_contextual_candidate','add_link_at_mention']),
 priority:z.enum(['high','medium','low']),targetUrl:z.string(),sourceUrl:z.string().nullable(),anchor:z.string().nullable(),
 passage:z.string().nullable(),message:z.string(),evidence:z.strictObject({findingKind:z.string(),httpStatus:n.optional(),
  finalUrl:z.string().optional(),checkedAt:time.nullable().optional(),signals:z.array(z.string()).max(10),score:n.optional(),
  // Mention opportunities: where the words came from and their place in the passage.
  phraseSource:z.enum(['search_query','title','address']).optional(),phrase:z.string().optional(),matchStart:n.optional(),matchEnd:n.optional()})});
export const internalLinkQueryOutput=z.strictObject({snapshot:internalLinkSnapshot,limits,items:z.array(z.union([internalLinkPage,internalLinkEdge,internalLinkFinding,internalLinkDifference,internalLinkSummary,internalLinkCluster,internalLinkNeighborhood,internalLinkAction])).max(100),total:n,nextCursor:z.string().nullable(),coverage:z.union([snapshotCoverage,healthCoverage]),baselineSnapshot:internalLinkSnapshot.optional()});

// Initial scan-v1 admission ceiling, not a whole-site or paid-plan allocation.
export const INTERNAL_LINK_SCAN_LIMITS=Object.freeze({pagesPerRun:300,workspacePagesPerDay:300,retainedRunsAndSnapshotsPerProject:20,
 retentionDays:30,pageBytes:2*1024*1024,pageTimeoutMs:20_000,leaseMs:90_000,maxAttempts:3,edgesPerPage:1000,pageSize:100});
const grantTierLimit=z.union([z.literal(300),z.literal(1000),z.literal(10000),z.literal(100000)]);
const scanLimits=z.strictObject(Object.fromEntries(Object.entries(INTERNAL_LINK_SCAN_LIMITS).map(([k,v])=>[k,['pagesPerRun','workspacePagesPerDay'].includes(k)?grantTierLimit:z.literal(v)])));
const scanCoverage=z.strictObject({inventory:z.literal('partial'),completeSiteCensus:z.literal(false),representation:z.literal('raw_html'),frontierTruncated:z.boolean(),renderedVisibility:z.literal(false),canonicalAliasesMerged:z.literal(false)});
const inventoryCounts=z.strictObject({declared:n,excluded:n,checked:n,unknown:n,pending:n,overlapWithCrawl:n,declaredOnlyWithinObservedDiscovery:n,notAdmittedByReason:z.record(z.string(),n)});
const scanInventory=z.strictObject({snapshots:z.array(z.strictObject({snapshotId:id,revision:n.describe('Revision of the saved inventory represented in this scan.'),createdAt:time,expiresAt:time,declaredComplete:z.boolean(),rows:n,excluded:n,counts:inventoryCounts.optional()})).max(20),seeded:z.boolean(),crawlOnly:n.optional(),completeSiteCensus:z.literal(false)});
export const internalLinkScan=z.strictObject({version:z.enum(['internal-link-scan-v1','internal-link-scan-qualification-v2']),id,projectId:id,domain:z.string(),homepage:z.string(),
 state:z.enum(['queued','running','paused','cancelled','complete','limit_reached','failed']),reason:z.string().nullable(),createdAt:time,updatedAt:time,expiresAt:time,completedAt:time.nullable(),revision:n,controlRevision:n,
 discoveredCount:n,completeCount:n,unknownCount:n,pendingCount:n,admittedCount:n,edgeCount:n,excludedReferences:n,exclusions:z.record(z.string(),n),nextEligibleAt:time,
 discovery:z.strictObject({state:z.enum(['pending','complete']),coverage:discoveryCoverage.optional(),documents:z.array(discoveryDocument).max(13).optional(),inventory:scanInventory.optional()}),coverage:scanCoverage,
 usage:z.strictObject({unit:z.literal('admitted_page'),period:time,limit:grantTierLimit,used:n,resetsAt:time})});
export const internalLinkScanOutput=z.strictObject({scan:internalLinkScan,limits:scanLimits});
export const internalLinkScanSchedule=z.strictObject({cadence:z.enum(INTERNAL_LINK_SCAN_CADENCES),pageLimit:grantTierLimit.nullable(),nextRunAt:time.nullable(),updatedAt:time.nullable(),
 lastRunId:z.string().nullable(),lastStartedAt:time.nullable(),lastError:z.string().nullable()});
export const internalLinkScanScheduleOutput=z.strictObject({schedule:internalLinkScanSchedule});
export const internalLinkScanListOutput=z.strictObject({items:z.array(internalLinkScan).max(20),limits:scanLimits,schedule:internalLinkScanSchedule.optional()});
const scanSource=z.enum(['homepage','sitemap','link','search_console',...INTERNAL_LINK_SOURCES]);
const inventoryRef=z.strictObject({snapshotId:id,source:z.enum(INTERNAL_LINK_SOURCES),important:z.boolean(),excluded:z.boolean()});
const inventoryRow=inventoryRef.extend({url:z.string(),state:z.enum(['pending','complete','unknown','excluded','not_admitted']),reason:z.string().nullable(),observedState:z.enum(['pending','complete','unknown']).nullable(),observedReason:z.string().nullable(),observedInLinksOrSitemaps:z.boolean()});
const searchMetrics=z.strictObject({clicks:n,impressions:n,position:z.number().nonnegative().nullable()});
// linkScore: this site's internal link share on a 0-100 log scale; not Google PageRank.
const scanPage=internalLinkPage.extend({renderReason:z.string().optional(),source:scanSource,inventorySources:z.array(scanSource).min(1).max(10).optional(),inventoryRefs:z.array(inventoryRef).max(20).optional(),discoveredDepth:n,linkScore:n.max(100).nullable().optional(),search:searchMetrics.nullable().optional(),pageHealth:z.enum(INTERNAL_LINK_PAGE_HEALTH_BUCKETS).optional()});
const searchEvidence=z.strictObject({clicks:n,impressions:n,position:z.number().nonnegative().nullable(),startDate:z.string().nullable(),endDate:z.string().nullable(),source:z.enum(['live','stored'])});
const scanFinding=internalLinkFinding.extend({kind:z.enum([...internalLinkFinding.shape.kind.options,'search_orphan','search_page_missing','disconnected_section']),
 evidence:findingEvidence.extend({inventorySource:scanSource,search:searchEvidence.optional(),
  redirectChain:z.array(z.strictObject({from:z.string(),to:z.string(),status:n})).max(20).optional(),
  section:z.strictObject({segment:z.string(),pages:n,contextualLinksWithin:n,contextualLinksAcross:z.literal(0),classification:z.literal('url_path'),semanticGroups:z.literal('not_assessed')}).optional()})});
const searchOverlay=z.strictObject({state:z.enum(['live','stored','unavailable','not_connected']),reason:z.string().nullable(),property:z.string().nullable().optional(),
 startDate:z.string().nullable().optional(),endDate:z.string().nullable().optional(),pages:n.optional(),queries:n.optional(),seeded:n.optional()});
export const INTERNAL_LINK_CHANGE_KINDS=Object.freeze(['page_new','page_gone','page_broken','page_fixed','page_redirected','lost_all_links_in','gained_first_link_in','links_in_changed','link_score_changed','finding_new','finding_resolved']);
const changesSummary=z.strictObject({state:z.enum(['ready','no_baseline','unavailable']),baselineScanId:z.string().nullable(),baselineCreatedAt:time.optional(),baselineCompletedAt:time.nullable().optional(),
 comparableInbound:z.boolean().optional(),reason:z.string().optional(),counts:z.array(z.strictObject({kind:z.enum(INTERNAL_LINK_CHANGE_KINDS),count:n})).max(20).optional()});
const scanSummary=internalLinkSummary.extend({search:searchOverlay.optional(),changes:changesSummary.optional(),pageHealth:internalLinkPageHealthSummary.optional(),
 render:z.strictObject({budget:n,used:n,failed:n,attempts:n.describe('Attempts counted against this scan\'s browser rendering budget, including failures, uncertain outcomes and conservative legacy counts.').optional(),unknown:n.optional(),legacyUncertain:z.boolean().optional()}).optional(),
 depths:z.array(z.strictObject({depth:n.nullable(),count:n})).max(50).optional(),linkScores:z.array(z.strictObject({from:n,to:n,count:n})).max(10).optional(),opportunities:n.optional()});
const changeFacts=z.strictObject({state:z.string().optional(),httpStatus:n.nullable().optional(),finalUrl:z.string().optional(),incomingAll:n.optional(),incomingContextual:n.optional(),linkScore:n.nullable().optional()});
export const internalLinkChange=z.strictObject({id:z.string(),kind:z.enum(INTERNAL_LINK_CHANGE_KINDS),url:z.string(),before:changeFacts.optional(),after:changeFacts.optional(),delta:z.number().int().optional(),
 finding:z.strictObject({id:z.string(),kind:z.string(),priority:z.enum(['high','medium','low']),message:z.string()}).optional()});
export const internalLinkSiteMap=z.strictObject({
 sections:z.array(z.strictObject({segment:z.string(),pages:n,complete:n,topLinkScore:n.nullable()})).max(60),
 sectionLinks:z.array(z.strictObject({source:z.string(),target:z.string(),links:n,contextualLinks:n})).max(2000),
 pages:z.array(z.strictObject({url:z.string(),title:z.string().nullable(),segment:z.string(),linkScore:n.nullable(),incomingContextual:n,depth:n.nullable()})).max(120),
 links:z.array(z.strictObject({sourceUrl:z.string(),targetUrl:z.string(),contextual:z.boolean()})).max(2000),linksTotal:n,pagesTotal:n});
export const internalLinkScanQueryOutput=z.strictObject({scan:internalLinkScan,limits:scanLimits,items:z.array(z.union([scanPage,internalLinkEdge,scanFinding,scanSummary,internalLinkCluster,internalLinkNeighborhood,internalLinkAction,internalLinkChange,internalLinkSiteMap,inventoryRow])).max(100),total:n,nextCursor:z.string().nullable(),coverage:scanCoverage});
// Selected changes (DP-0076-T05/T07): the customer or agent selects, the verifier confirms.
// The const casts keep literal types for the console, which infers its types from these schemas.
export const INTERNAL_LINK_CHANGE_STATES=Object.freeze(/** @type {const} */(['selected','published','verified','not_found','dismissed','resolved','stale']));
export const INTERNAL_LINK_DISMISS_REASONS=Object.freeze(/** @type {const} */(['intended','not_useful','wrong','other']));
export const INTERNAL_LINK_CHANGE_ACTIONS=Object.freeze(/** @type {const} */(['select','dismiss','published','reopen']));
const changeVerification=z.strictObject({checkedAt:time,method:z.enum(['page_check','scan']),scanId:z.string().optional(),requestId:z.string().optional(),state:z.enum(['present','absent','unknown']),
 reason:z.string().optional(),anchorFound:z.string().optional(),anchorMatches:z.boolean().optional(),finalUrl:z.string().nullable().optional(),captureSha256:z.string().nullable().optional(),
 targetHttpStatus:n.nullable().optional(),targetWorks:z.boolean().nullable().optional()});
const actorRef=z.strictObject({kind:z.enum(['member','agent']),id:z.string()});
export const internalLinkEdit=z.strictObject({id:z.string(),projectId:id,state:z.enum(INTERNAL_LINK_CHANGE_STATES),revision:z.number().int().positive().describe('Revision of this saved internal-link change.'),
 subject:z.strictObject({kind:z.enum(['suggestion','finding','action']),id:z.string(),findingKind:z.string().nullable(),sourceUrl:z.string().nullable(),targetUrl:z.string().nullable(),pageUrl:z.string(),
  message:z.string().max(1000).nullable().describe('The suggestion or finding message, captured when it was selected.'),goal:z.enum(['link','repair','unlink','page'])}),
 edit:z.strictObject({anchor:z.string().nullable(),passage:z.string().nullable(),matchStart:n.nullable(),matchEnd:n.nullable(),phraseSource:z.enum(['search_query','title','address']).nullable(),
  anchorBy:z.enum(['product','customer','agent']).nullable(),anchorRef:z.string().nullable()}),
 origin:z.strictObject({scanId:z.string(),sourceCheckedAt:time.nullable(),sourceCaptureSha256:z.string().nullable()}),
 dismissReason:z.enum(INTERNAL_LINK_DISMISS_REASONS).nullable(),note:z.string().nullable(),externalRef:z.string().nullable(),selectedBy:actorRef,updatedBy:actorRef,
 verification:changeVerification.nullable(),verifiedAt:time.nullable(),lastCheckedAt:time.nullable(),nextCheckAt:time.nullable(),createdAt:time,updatedAt:time});
export const internalLinkEditOutput=z.strictObject({change:internalLinkEdit});
const changeCounts=z.strictObject(Object.fromEntries(INTERNAL_LINK_CHANGE_STATES.map(s=>[s,n])));
export const internalLinkEditListOutput=z.strictObject({items:z.array(internalLinkEdit).max(100),total:n,nextCursor:z.string().nullable(),counts:z.strictObject({byState:changeCounts})});
const openFinding=z.strictObject({id:z.string(),kind:z.string(),priority:z.enum(['high','medium','low']),pageUrl:z.string(),targetUrl:z.string().optional(),message:z.string()});
const scanReport=z.strictObject({scanId:z.string(),completedAt:time,layout:n,pages:z.strictObject({total:n,checked:n,unknown:n}),linksTotal:n,truncated:z.boolean(),
 findings:z.record(z.string(),n),openFindings:z.array(openFinding).max(50),opportunitiesTotal:n,
 changes:z.strictObject({state:z.enum(['ready','no_baseline','unavailable']),baselineScanId:z.string().nullable(),reason:z.string().optional(),counts:z.array(z.strictObject({kind:z.string(),count:n})).max(20).optional()}).nullable(),
 search:z.strictObject({state:z.string(),reason:z.string().nullable(),pages:n.optional(),queries:n.optional(),seeded:n.optional()}).nullable()});
export const internalLinkReportOutput=z.strictObject({report:scanReport.nullable(),baseline:scanReport.nullable(),comparable:z.boolean(),reason:z.enum(['no_report','no_baseline','truncated']).nullable(),
 differences:z.array(z.strictObject({kind:z.string(),before:n,after:n,delta:z.number().int()})).max(50),
 unknown:z.strictObject({report:n.nullable(),baseline:n.nullable()}),
 changes:z.strictObject({window:z.strictObject({from:time.nullable(),to:time}),counts:changeCounts,
  dismissals:z.array(z.strictObject({reason:z.enum(INTERNAL_LINK_DISMISS_REASONS).nullable(),by:z.enum(['member','agent']),findingKind:z.string().nullable(),count:n})).max(100),
  // Outcome rows only; list_internal_link_changes has each change in full.
  items:z.array(z.strictObject({id:z.string(),state:z.enum(INTERNAL_LINK_CHANGE_STATES),goal:z.enum(['link','repair','unlink','page']),subjectKind:z.enum(['suggestion','finding','action']),findingKind:z.string().nullable(),
   message:z.string().nullable(),pageUrl:z.string(),sourceUrl:z.string().nullable(),targetUrl:z.string().nullable(),anchor:z.string().nullable(),
   dismissReason:z.enum(INTERNAL_LINK_DISMISS_REASONS).nullable(),note:z.string().nullable(),by:z.enum(['member','agent']),checkedBy:z.enum(['page_check','scan']).nullable(),verifiedAt:time.nullable(),updatedAt:time})).max(100),truncated:z.boolean()}),
 trend:z.array(z.strictObject({scanId:z.string(),completedAt:time,truncated:z.boolean(),pagesChecked:n,pagesUnknown:n,findings:z.record(z.string(),n)})).max(20)});
