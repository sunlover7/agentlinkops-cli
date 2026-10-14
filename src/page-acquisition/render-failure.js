// Error messages, page text and provider diagnostics never enter this contract.
// Only the signed client records provenance; copying fields onto an Error cannot
// manufacture an authenticated renderer failure for the verifier.
const failures = new WeakMap();
const executorReasons = new Set([
  'executor_failed','executor_busy','mode_not_enabled_on_endpoint','browser_not_enabled',
  'browser_failed','browser_unit_failed','browser_namespace_failed','browser_render_failed',
  'browser_request_failed','browser_controller_failed','browser_controller_not_configured',
  'browser_controller_response_unverified','browser_controller_response_too_large',
  'browser_controller_url_not_qualified','browser_cancelled','browser_cancel_unverified',
  'browser_authority_denied','browser_authority_expired','browser_authority_not_configured',
  'browser_authority_unavailable','browser_authority_unverified','browser_cleanup_unverified',
  'browser_insufficient_deadline','browser_resource_admission_failed','browser_job_setup_failed',
  'browser_native_result_unverified','browser_result_too_large','browser_receipt_too_large',
  'browser_uid_wrapper_unqualified','browser_executable_unqualified','browser_egress_unqualified',
  'browser_namespace_escape_probe_failed','browser_namespace_unqualified','browser_not_configured',
  'browser_access_challenge','browser_html_too_large','browser_navigation_changed',
  'browser_redirect_limit','browser_request_limit','browser_resource_bytes_exceeded',
  'browser_resource_concurrency_exceeded','browser_unsafe_redirect','browser_unsafe_navigation',
  'browser_unsupported_content_type','browser_websocket_interception_unavailable',
  'robots_access_challenge','robots_crawl_delay_requires_scheduler','robots_invalid_encoding',
  'robots_not_plain_text','robots_redirect_limit','robots_redirect_loop','robots_unsafe_redirect',
  'robots_disallowed','robots_fetch_failed','robots_unavailable','robots_too_complex',
  'deadline_exceeded','body_too_large','incomplete_body','content_encoding_unsupported',
  'dns_destination_not_public','dns_resolution_failed','response_headers_too_large',
  'origin_connection_failed','socket_destination_changed','socket_destination_unverified',
  'socket_hostname_changed','byte_meter_failed','ipc_body_too_large','ipc_tunnel_unverified',
  'ipc_authentication_failed','ipc_body_unverified','ipc_destination_unsafe',
  'ipc_invalid_request','ipc_request_too_large','ipc_response_unverified','ipc_route_not_found',
  'expired_or_invalid_request','request_replayed','replay_store_full','replay_journal_unavailable',
  'invalid_request','invalid_request_json','invalid_request_identity','invalid_binding',
  'invalid_browser_binding','invalid_limits','invalid_mode','invalid_request_header',
  'unrecognized_user_agent','unsupported_request_headers','unsupported_accept',
  'native_admission_closed','native_admission_epoch_retired','native_admission_state_invalid',
  'native_custody_journal_full','native_custody_journal_unavailable','native_custody_journal_invalid',
  'native_custody_identity_missing','native_custody_identity_changed','native_custody_dispatch_changed','native_custody_session_invalid',
]);
const urlReasons = '(?:invalid_url|unsupported_protocol|url_credentials|unsupported_port|ip_literal_not_supported|non_public_hostname)';
const dynamicReason = new RegExp(`^(?:unsafe_url|browser_unsafe_resource):${urlReasons}$`, 'u');
const localReasons = new Set(['timeout','acquisition_scope_revoked','acquisition_not_configured',
  'acquisition_failed','acquisition_request_invalid','acquisition_receipt_invalid',
  'acquisition_receipt_limit','body_too_large','incomplete_body','unsupported_or_invalid_encoding']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const session = value => typeof value === 'string' && /^alo-page-browser-job-[a-f0-9]{24}\.service$/u.test(value);
export function safeExecutorFailureReason(value) {
  return executorReasons.has(value) || typeof value === 'string' && (dynamicReason.test(value) || /^robots_http_[1-5][0-9]{2}$/u.test(value)) ? value : 'executor_failed';
}
function safeReason(value) {
  if(localReasons.has(value))return value;
  if(typeof value === 'string' && value.startsWith('acquisition_')
    && safeExecutorFailureReason(value.slice(12)) === value.slice(12))return value;
  return 'acquisition_failed';
}
function custody(closure) {
  if(closure?.browserClosed !== true)return {state:'unknown'};
  if(['signed_executor','signed_executor_lookup'].includes(closure.cleanupSource) && session(closure.sessionId)
    && closure.cleanup?.unitStopped === true && closure.cleanup.cgroupEmpty === true
    && closure.cleanup.namespaceDestroyed === true)return {state:'closed',source:closure.cleanupSource,sessionId:closure.sessionId,
      cleanup:{unitStopped:true,cgroupEmpty:true,namespaceDestroyed:true}};
  if(closure.browserDispatched === false && ['signed_no_launch','signed_no_launch_lookup','local_no_dispatch'].includes(closure.cleanupSource)
    && closure.sessionId === undefined && closure.cleanup === undefined)return {state:'not_launched',source:closure.cleanupSource};
  return {state:'unknown'};
}
export function recordRenderFailure(error, {reason,stage,durationMs,closure,receipt,reservationId} = {}) {
  if(!(error instanceof Error))return;
  const trace = {version:1,method:'node_browser',reason:safeReason(reason),
    stage:['admission','transport','response_validation','executor','capture_validation','postflight'].includes(stage)?stage:'transport',
    durationMs:Number.isFinite(durationMs)?Math.max(0,Math.min(60000,Math.ceil(durationMs))):null,custody:custody(closure)};
  if(token(reservationId))trace.reservationId=reservationId;
  if(receipt && token(receipt.requestId) && /^[a-f0-9]{64}$/u.test(receipt.sha256 ?? '')
    && Number.isInteger(receipt.httpStatus) && receipt.httpStatus >= 200 && receipt.httpStatus <= 599) {
    trace.receipt={requestId:receipt.requestId,sha256:receipt.sha256,httpStatus:receipt.httpStatus,keyId:'version1',authenticated:true};
    if(receipt.executorReason !== undefined)trace.executorReason=safeExecutorFailureReason(receipt.executorReason);
    if(['admission','execution'].includes(receipt.executorStage))trace.executorStage=receipt.executorStage;
    if(typeof receipt.retryable === 'boolean')trace.retryable=receipt.retryable;
  }
  failures.set(error, trace);
}
export function readRenderFailure(error) {
  const value = error instanceof Error ? failures.get(error) : null;
  return value ? structuredClone(value) : null;
}
