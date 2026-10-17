// Copyright 2026 Tymofii Pidlisnyi. Apache-2.0 license. See LICENSE.
//
// MCP tool annotations for every registered tool, in one table.
//
// The registerTool wrapper in index.ts looks each tool up here and attaches
// `title` and `annotations` to its registration, so the hints reach clients in
// tools/list. A tool registered without an entry in this table makes the wrapper
// throw at module load, which fails `npm run build` (the manifest step imports
// the module) and the test suite. tests/tool-annotations.test.mjs asserts over
// the wire that every listed tool carries a title and four boolean hints.
//
// How each hint is decided, from what the handler actually does:
//
//   readOnlyHint     true only if the handler writes no local file, calls no
//                    mutating remote endpoint, and changes no session or SDK
//                    state that a later tool call reads. Pure computation and
//                    signing that only RETURN an artifact are read-only: the
//                    caller decides whether to publish the artifact.
//                    Not counted: recordBehavior(), the post-issuance tool-call
//                    log a few handlers append to (telemetry, never consulted
//                    for authorization), and the SDK hybrid-clock counter that
//                    createHybridTimestamp advances.
//   destructiveHint  true if the handler deletes, revokes, supersedes,
//                    irreversibly consumes, or overwrites state it cannot get
//                    back. Always false for read-only tools.
//   idempotentHint   true if repeating the identical call has no further effect
//                    on the environment. Always true for read-only tools.
//   openWorldHint    true if the handler can contact any external network
//                    service, including conditionally (issue_passport only when
//                    AEOESS_GATEWAY_URL and AEOESS_GATEWAY_KEY are set).
//
// State locations referred to below:
//   task store   ~/.agent-passport-tasks.json            (saveTasks)
//   agora feed   $AGORA_PATH, default ~/aeoess_web/agora/messages.json and latest.json
//   comms        $COMMS_PATH, default ~/aeoess_web/comms/*.json
//   nullifiers   $APS_NULLIFIER_DIR, default ~/.agent-passport-nullifiers/
//   session      in-process maps on `state`, lost on restart
//   SDK store    module-level maps inside agent-passport-system (v2 delegation,
//                outcome, emergency), lost on restart

export interface ToolAnnotationEntry {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Read-only: no writes anywhere, so not destructive and trivially idempotent. */
function ro(title: string, openWorldHint = false): ToolAnnotationEntry {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint };
}

/** Mutating tool. Every hint is stated at the call site. */
function rw(
  title: string,
  h: { destructive: boolean; idempotent: boolean; openWorld: boolean },
): ToolAnnotationEntry {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: h.destructive,
    idempotentHint: h.idempotent,
    openWorldHint: h.openWorld,
  };
}

const ADD = { destructive: false, idempotent: false, openWorld: false } as const;
const SET = { destructive: false, idempotent: true, openWorld: false } as const;

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotationEntry> = {
  // ── Meta ──
  list_profiles: ro("List Tool Profiles"),
  list_tools_for_scope: ro("List Tools for Delegation Scope"),

  // ── Identity and issuance ──
  identify: rw("Identify Session Agent", ADD), // session: keys, role, new session passport each call
  generate_keys: ro("Generate Ed25519 Keypair"),
  issue_passport: rw("Issue Agent Passport", { destructive: false, idempotent: false, openWorld: true }), // session; POSTs to $AEOESS_GATEWAY_URL when configured
  verify_issuer: ro("Verify Passport Issuer Signature"),
  get_passport_grade: ro("Get Passport Grade"),
  list_issuance_records: ro("List Issuance Records"),
  get_behavioral_sequence: ro("Get Post-Issuance Behavior"),
  get_my_role: ro("Get My Coordination Role"),
  compute_action_ref: ro("Compute Action Reference"),
  is_evidence_fresh: ro("Check Evidence Freshness"),
  classify_evidence_quality: ro("Classify Evidence Quality"),
  rotate_key: ro("Rotate Agent Key"), // builds a rotated DID document and returns it; persists nothing, and no revocation callback is wired so delegation_ids_to_revoke only report errors
  verify_rotation_chain: ro("Verify Key Rotation Chain"),
  is_key_active: ro("Check Key Is Active"),

  // ── Coordination (task store on disk) ──
  create_task_brief: rw("Create Task Brief", ADD),
  assign_agent: rw("Assign Agent to Task Role", ADD),
  review_evidence: rw("Review Evidence Packet", ADD),
  handoff_evidence: rw("Hand Off Evidence", ADD),
  complete_task: rw("Complete Task", ADD), // sets the task's completion record; a later call replaces it
  accept_assignment: rw("Accept Task Assignment", ADD),
  submit_evidence: rw("Submit Evidence Packet", ADD),
  get_evidence: ro("Get Handed-Off Evidence"),
  submit_deliverable: rw("Submit Deliverable", ADD),
  list_tasks: ro("List Tasks"),
  get_task_detail: ro("Get Task Detail"),

  // ── Delegation (session) ──
  create_delegation: rw("Create Delegation", ADD),
  verify_delegation: ro("Verify Delegation"),
  revoke_delegation: rw("Revoke Delegation", { destructive: true, idempotent: true, openWorld: false }),
  sub_delegate: rw("Sub-Delegate Authority", ADD),

  // ── Agora ──
  post_agora_message: rw("Post Agora Message", ADD), // appends to the agora feed files on disk
  get_agora_topics: ro("List Agora Topics"),
  get_agora_thread: ro("Get Agora Thread"),
  get_agora_by_topic: ro("Get Agora Messages by Topic"),
  register_agora_agent: rw("Register Agent in Session Agora", SET), // upsert by public key
  register_agora_public: rw("Register Agent in Public Agora", { destructive: false, idempotent: false, openWorld: true }), // opens a GitHub issue via api.github.com when a token is available

  // ── Comms (files under $COMMS_PATH) ──
  send_message: rw("Send Agent Message", ADD),
  check_messages: rw("Check Agent Messages", SET), // writes only when mark_read is true
  broadcast: rw("Broadcast Agent Message", ADD),
  list_agents: ro("List Registered Agents"),

  // ── Values and policy ──
  load_values_floor: rw("Load Values Floor", SET), // session
  attest_to_floor: ro("Attest to Values Floor"),
  create_intent: rw("Create Action Intent", ADD), // session
  evaluate_intent: ro("Evaluate Action Intent"),

  // ── Commerce ──
  commerce_preflight: ro("Commerce Preflight (Moved to Gateway)"), // returns a deprecation notice, no network call
  get_commerce_spend: ro("Get Commerce Spend"),
  request_human_approval: ro("Build Human Approval Request"), // returns a request object; nothing is stored or sent

  // ── Removed in v3.0.0, stubs that return a migration notice ──
  create_agent_context: ro("Create Agent Context (Deprecated)"),
  execute_with_context: ro("Execute with Context (Deprecated)"),
  complete_action: ro("Complete Action (Deprecated)"),
  create_gateway: ro("Create Gateway (Deprecated)"),
  gateway_process_tool_call: ro("Gateway Process Tool Call (Deprecated)"),
  gateway_approve: ro("Gateway Approve (Deprecated)"),
  gateway_stats: ro("Gateway Stats (Deprecated)"),
  create_data_enforcement_gate: ro("Create Data Enforcement Gate (Deprecated)"),
  query_contributions: ro("Query Contributions (Deprecated)"),
  generate_settlement: ro("Generate Settlement (Deprecated)"),

  // ── Principal identity (session) ──
  // create_principal replaces the session principal and fleet. The previous
  // principal's private key was only ever returned truncated, so it is lost.
  create_principal: rw("Create Principal Identity", { destructive: true, idempotent: false, openWorld: false }),
  endorse_agent: rw("Endorse Agent", ADD),
  verify_endorsement: ro("Verify Endorsement"),
  revoke_endorsement: rw("Revoke Endorsement", { destructive: true, idempotent: false, openWorld: false }),
  create_disclosure: ro("Create Principal Disclosure"),
  get_fleet_status: ro("Get Fleet Status"),

  // ── Reputation-gated authority ──
  // resolve_authority and check_tier store a default reputation record when none
  // exists. That record equals what every other tool assumes for a missing key,
  // so the write has no observable effect.
  resolve_authority: ro("Resolve Authority Tier"),
  check_tier: ro("Check Tier Permits Action"),
  review_promotion: rw("Review Agent Promotion", ADD), // session promotion history
  update_reputation: rw("Update Agent Reputation", ADD),
  get_promotion_history: ro("Get Promotion History"),

  // ── Intent Network (api.aeoess.com or $INTENT_API_URL) ──
  search_matches: ro("Search Intent Network Matches", true),
  get_digest: ro("Get Intent Network Digest", true),
  request_intro: rw("Request Introduction", { destructive: false, idempotent: false, openWorld: true }),
  // Approving shares the disclosed fields with another party, which cannot be undone.
  respond_to_intro: rw("Respond to Introduction", { destructive: true, idempotent: false, openWorld: true }),
  remove_intent_card: rw("Remove Intent Card", { destructive: true, idempotent: true, openWorld: true }),

  // ── v2 constitutional governance ──
  create_policy_context: ro("Create Policy Context"),
  create_v2_delegation: rw("Create v2 Delegation", ADD), // SDK store
  supersede_v2_delegation: rw("Supersede v2 Delegation", { destructive: true, idempotent: false, openWorld: false }), // marks the original superseded in the SDK store
  create_outcome_record: rw("Create Outcome Record", ADD), // SDK store
  add_principal_report: rw("Add Principal Outcome Report", ADD), // SDK store
  define_emergency_pathway: rw("Define Emergency Pathway", ADD), // SDK store
  activate_emergency: rw("Activate Emergency Pathway", ADD), // SDK store
  create_artifact_provenance: ro("Create Artifact Provenance"),

  // ── Data governance ──
  register_data_source: rw("Register Data Source", ADD), // session
  create_derivation_receipt: rw("Create Derivation Receipt", ADD), // session derivation store
  resolve_lineage: ro("Resolve Data Lineage"),
  evaluate_revocation_impact: ro("Evaluate Revocation Impact"), // computes obligations; revokes nothing
  create_decision_lineage_receipt: ro("Create Decision Lineage Receipt"),
  check_purpose_permitted: ro("Check Purpose Permitted"),
  check_retention_expired: ro("Check Retention Expired"),
  check_aggregate_constraints: ro("Check Aggregate Constraints"),
  check_jurisdiction_transfer: ro("Check Jurisdiction Transfer"),
  compute_governance_taint: ro("Compute Governance Taint"),
  file_data_dispute: ro("Build Data Dispute Record"), // returns a signed dispute; not stored or sent anywhere
  check_combination_permitted: ro("Check Data Combination Permitted"),
  create_access_snapshot: ro("Create Access Snapshot"),
  detect_purpose_drift: ro("Detect Purpose Drift"),
  resolve_rights_propagation: ro("Resolve Rights Propagation"),
  declare_reidentification_risk: ro("Declare Re-identification Risk"),

  // ── Governance blocks and aps.txt (pure; content is passed in, nothing fetched) ──
  generate_governance_block: ro("Generate Governance Block"),
  verify_governance_block: ro("Verify Governance Block"),
  parse_governance_block_html: ro("Parse Governance Block from HTML"),
  check_usage_permitted: ro("Check Usage Permitted"),
  generate_aps_txt: ro("Generate aps.txt"),
  verify_aps_txt: ro("Verify aps.txt"),
  resolve_path_terms: ro("Resolve Path Terms"),
  create_chained_governance_block: ro("Create Chained Governance Block"),
  governance_360: ro("Run Governance 360 Loop"),
  create_access_receipt: ro("Create Access Receipt"),

  // ── Charter and institutional governance (session) ──
  create_charter: rw("Create Charter", ADD),
  verify_charter: ro("Verify Charter"),
  sign_charter: rw("Sign Charter", ADD),
  propose_amendment: rw("Propose Charter Amendment", ADD),
  sign_amendment: rw("Sign Charter Amendment", ADD),
  verify_amendment: ro("Verify Charter Amendment"),
  create_approval_request: rw("Create Approval Request", ADD),
  add_approval_signature: rw("Add Approval Signature", ADD),

  // ── Time, reserve, cross-gateway reputation (pure) ──
  create_hybrid_timestamp: ro("Create Hybrid Timestamp"),
  compare_timestamps: ro("Compare Hybrid Timestamps"),
  validate_temporal_rights: ro("Validate Temporal Rights"),
  create_reserve_attestation: ro("Create Reserve Attestation"),
  vouch_reputation: ro("Vouch Reputation"),
  apply_reputation_downgrade: ro("Apply Reputation Downgrade"),

  // ── v2 boundary primitives (pure; artifacts are returned, not stored) ──
  aps_create_attribution_receipt: ro("Create Attribution Receipt"),
  aps_sign_attribution_consent: ro("Sign Attribution Consent"),
  aps_verify_attribution_consent: ro("Verify Attribution Consent"),
  aps_check_artifact_citations: ro("Check Artifact Citations"),
  aps_attribution_receipt_id: ro("Compute Attribution Receipt ID"),
  aps_create_provisional: ro("Create Provisional Statement"),
  aps_promote_statement: ro("Promote Provisional Statement"),
  aps_verify_promotion: ro("Verify Statement Promotion"),
  aps_withdraw_provisional: ro("Withdraw Provisional Statement"), // returns the withdrawn statement; nothing stored
  aps_check_escalation_required: ro("Check Escalation Required"),
  aps_record_owner_confirmation: ro("Record Owner Confirmation"),

  // ── Attribution primitive, weights, settlement (pure) ──
  aps_construct_attribution_primitive: ro("Construct Attribution Primitive"),
  aps_project_attribution: ro("Project Attribution Axis"),
  aps_verify_attribution_projection: ro("Verify Attribution Projection"),
  aps_verify_attribution_primitive: ro("Verify Attribution Primitive"),
  aps_check_projection_consistency: ro("Check Projection Consistency"),
  aps_compute_attribution_action_ref: ro("Compute Attribution Action Ref"),
  aps_compute_data_axis_weights: ro("Compute Data Axis Weights"),
  aps_compute_compute_axis_weights: ro("Compute Compute Axis Weights"),
  aps_aggregate_settlement: ro("Aggregate Settlement Record"),
  aps_verify_settlement: ro("Verify Settlement Record"),
  aps_build_contributor_query: ro("Build Contributor Query Response"),

  // ── Mutual authentication (pure) ──
  mutualAuthBuildCertificate: ro("Build Mutual-Auth Certificate"),
  mutualAuthVerifyAttest: ro("Verify Mutual-Auth Attest"),
  mutualAuthDeriveSession: ro("Derive Mutual-Auth Session"),
  mutualAuthVerifyTrustBundle: ro("Verify Trust Anchor Bundle"),

  // ── Capability token v0.1 ──
  aps_capability_issue_challenge: ro("Issue Capability Sink Challenge"),
  aps_capability_evaluate_authority: ro("Build Authority Evaluation Request"),
  aps_capability_mint_receipt: ro("Mint Capability Challenge Receipt"),
  // Consumes the token preimage in the on-disk nullifier store, so the token can
  // never be redeemed again.
  aps_capability_sign_effect: rw("Sign Capability Effect Receipt", { destructive: true, idempotent: false, openWorld: false }),
};

/** Returns the annotation entry for a tool, or throws so a missing entry cannot ship. */
export function annotationsFor(name: string): ToolAnnotationEntry {
  const entry = TOOL_ANNOTATIONS[name];
  if (!entry) {
    throw new Error(
      `Tool "${name}" has no entry in src/toolAnnotations.ts. Every registered tool needs a title and explicit readOnly/destructive/idempotent/openWorld hints.`,
    );
  }
  return entry;
}
