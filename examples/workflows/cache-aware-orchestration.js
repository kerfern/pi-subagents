/**
 * cache-aware-orchestration.js — opt-in, bounded planning/implementation/review.
 *
 * Pass a redacted task summary; the plan and review are durable project artifacts.
 * Stage calls reuse args.taskId. No workflow call changes the parent model.
 */
export const meta = {
  name: 'cache-aware-orchestration',
  description: 'Run an approved plan through bounded implementation, advisor, and review stages',
  phases: [
    { title: 'Plan' },
    { title: 'Advisor' },
    { title: 'Implement' },
    { title: 'Review' },
  ],
}

const MODES = ['routine', 'complex']
const STAGES = ['plan', 'advisor', 'worker', 'review']
const ADVISOR_TRIGGERS = [
  'scope-change',
  'invariant-change',
  'interface-change',
  'schema-change',
  'security-change',
  'conflicting-evidence',
  'blocking-assumption',
  'two-failed-repairs',
]

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'invariants', 'files', 'steps', 'acceptance', 'assumptions'],
  properties: {
    objective: { type: 'string' },
    invariants: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'task', 'dependsOn', 'verify'],
        properties: {
          id: { type: 'string' },
          task: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          verify: { type: 'string' },
        },
      },
    },
    acceptance: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
}

const ADVISOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'evidence', 'recommendation', 'risks', 'escalate'],
  properties: {
    question: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    escalate: { type: 'boolean' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements', 'blockers', 'residualRisks'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'status', 'evidence'],
        properties: {
          item: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'unverified'] },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
    residualRisks: { type: 'array', items: { type: 'string' } },
  },
}

function fail(message) {
  throw new Error(message)
}

function safeText(value, max = 4096) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function stringList(value) {
  return Array.isArray(value) && value.every(item => safeText(item))
}

function validPlan(value) {
  return value !== null && typeof value === 'object'
    && safeText(value.objective)
    && stringList(value.invariants)
    && stringList(value.files)
    && Array.isArray(value.steps)
    && value.steps.every(step => step !== null && typeof step === 'object'
      && safeText(step.id) && safeText(step.task) && stringList(step.dependsOn) && safeText(step.verify))
    && stringList(value.acceptance)
    && stringList(value.assumptions)
}

function validState(state, taskId, mode) {
  return state !== null && typeof state === 'object'
    && state.taskId === taskId && state.mode === mode
    && Number.isSafeInteger(state.planVersion) && state.planVersion > 0
    && (state.approvedPlanVersion === null || state.approvedPlanVersion === state.planVersion)
    && Number.isSafeInteger(state.repairAttempts) && state.repairAttempts >= 0
    && Array.isArray(state.checks) && Array.isArray(state.blockers)
}

async function readState(taskId, mode) {
  const content = await artifacts.read('state.json')
  if (content === undefined) fail('No prior plan state exists for this taskId.')
  let state
  try {
    state = JSON.parse(content)
  } catch {
    fail('state.json is malformed; refusing to continue.')
  }
  if (!validState(state, taskId, mode)) fail('state.json taskId or mode does not match this stage.')
  return state
}

async function readPlan() {
  const content = await artifacts.read('plan.md')
  if (content === undefined) fail('No plan.md exists for this taskId.')
  let plan
  try {
    plan = JSON.parse(content)
  } catch {
    fail('plan.md is malformed; refusing to continue.')
  }
  if (!validPlan(plan)) fail('plan.md does not match the approved plan schema.')
  return plan
}

function newState(taskId, mode, originalRequestRef) {
  return {
    taskId,
    mode,
    stage: 'plan',
    originalRequestRef,
    planVersion: 1,
    approvedPlanVersion: null,
    agents: [],
    repairAttempts: 0,
    checks: [],
    blockers: [],
    reviewStatus: 'pending',
  }
}

function reviewContextIsComplete(context, savedPlan) {
  return context !== null && typeof context === 'object'
    && safeText(context.revisionId, 128)
    && safeText(context.originalRequest, 16_000)
    && context.approvedPlan === savedPlan
    && safeText(context.actualDiff, 32_000)
    && safeText(context.validationResults, 16_000)
    && (safeText(context.unresolvedIssues, 4096)
      || (Array.isArray(context.unresolvedIssues) && context.unresolvedIssues.every(item => safeText(item))))
}

function safeEvidence(reference) {
  return typeof reference === 'string'
    && (/^check:\d+$/.test(reference)
      || /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+:\d+(?:-\d+)?$/.test(reference))
}

if (args === null || typeof args !== 'object' || Array.isArray(args)) fail('args must be an object.')
if (typeof args.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.taskId) || args.taskId.includes('..')) {
  fail('args.taskId must be a safe project-local ID.')
}
if (!MODES.includes(args.mode)) fail('args.mode must be exactly "routine" or "complex".')
if (!STAGES.includes(args.stage)) fail('args.stage must be exactly plan, advisor, worker, or review.')
if (args.originalRequestRef !== undefined && args.originalRequestRef !== null && !safeText(args.originalRequestRef, 256)) {
  fail('args.originalRequestRef must be a short, non-empty reference.')
}

const taskId = args.taskId
const mode = args.mode
const stage = args.stage
const originalRequestRef = args.originalRequestRef ?? null

if (stage === 'plan') {
  if (args.trivial === true) return { handledByParent: true, reason: 'trivial task; no subagents spawned' }
  if (!safeText(args.task, 16_000)) fail('plan stage requires a redacted task summary.')
  if (await artifacts.exists()) fail('task directory already exists; choose a new taskId or continue at a later stage.')

  phase('Plan')
  const plan = await agent(
    `Create a bounded implementation plan for this redacted task summary. Do not quote the request, sensitive data, secrets, or source contents. Prefer stable file/line and check references.\n\n${args.task}`,
    { label: 'plan', agentType: 'Plan', effort: 'high', schema: PLAN_SCHEMA },
  )
  if (!validPlan(plan)) fail('Plan agent returned invalid structured data.')

  await artifacts.write('plan.md', JSON.stringify(plan, null, 2))
  await artifacts.write('state.json', JSON.stringify(newState(taskId, mode, originalRequestRef), null, 2))
  return { status: 'plan-ready', planVersion: 1, approvalRequired: true }
}

if (stage === 'advisor') {
  if (!ADVISOR_TRIGGERS.includes(args.trigger)) fail('advisor stage requires an explicit supported trigger.')
  if (!safeText(args.question, 4096) || !stringList(args.evidence)) {
    fail('advisor stage requires a question and evidence references.')
  }
  const state = await readState(taskId, mode)
  if (args.trigger === 'two-failed-repairs' && state.repairAttempts < 2) {
    fail('two-failed-repairs trigger requires two failed repair attempts.')
  }
  phase('Advisor')
  const advice = await agent(
    `Assess this explicit escalation trigger: ${args.trigger}. Answer the question using only supplied evidence. Do not repeat sensitive values.\nQuestion: ${args.question}\nEvidence: ${args.evidence.join('\n')}`,
    { label: 'advisor', agentType: 'advisor', effort: 'high', schema: ADVISOR_SCHEMA },
  )
  if (advice === null || typeof advice !== 'object' || !safeText(advice.recommendation)
    || !Array.isArray(advice.risks) || typeof advice.escalate !== 'boolean') {
    state.stage = 'advisor'
    state.blockers.push(`Advisor response unavailable for ${args.trigger}.`)
    await artifacts.write('state.json', JSON.stringify(state, null, 2))
    return { consulted: true, unavailable: true, trigger: args.trigger }
  }
  state.stage = 'advisor'
  if (advice.escalate && !state.blockers.includes(`Advisor escalation: ${args.trigger}`)) {
    state.blockers.push(`Advisor escalation: ${args.trigger}`)
  }
  await artifacts.write('state.json', JSON.stringify(state, null, 2))
  return { ...advice, handoffRequired: advice.escalate }
}

if (stage === 'worker') {
  const state = await readState(taskId, mode)
  const plan = await readPlan()
  if (args.approvedPlanVersion !== state.planVersion) fail('worker stage requires approved planVersion from the parent.')
  state.approvedPlanVersion = state.planVersion
  state.stage = 'worker'
  await artifacts.write('state.json', JSON.stringify(state, null, 2))
  if (state.blockers.some(blocker => blocker.startsWith('Advisor escalation:')
    || blocker.startsWith('Advisor response unavailable'))) {
    fail('advisor escalation requires a manually selected Sol/high parent; artifacts are preserved for handoff.')
  }

  const previousCheck = state.checks[state.checks.length - 1]
  const isRepair = state.reviewStatus === 'fail' || previousCheck?.outcome === 'failed'
  if (isRepair && state.repairAttempts >= 2) {
    state.stage = 'advisor'
    if (!state.blockers.includes('Two failed repair attempts; advisor direction required.')) {
      state.blockers.push('Two failed repair attempts; advisor direction required.')
    }
    await artifacts.write('state.json', JSON.stringify(state, null, 2))
    return { advisorRequired: true, repairAttempts: state.repairAttempts }
  }
  if (state.reviewStatus === 'fail' && !safeText(args.reviewFeedback)) {
    fail('worker stage requires concise review feedback for a review-driven fix.')
  }

  const checksBefore = state.checks.length
  const testCommand = args.test ?? 'npm test'
  if (!safeText(testCommand, 1024)) fail('worker stage requires a bounded gate command.')
  phase('Implement')
  const reviewFeedback = state.reviewStatus === 'fail'
    ? `\n\nFix only these reviewer findings:\n${args.reviewFeedback}`
    : ''
  const result = await agent(
    `Implement only the approved plan below. Keep work within listed files and invariants. Do not broaden scope.\n\n${JSON.stringify(plan)}${reviewFeedback}`,
    { label: 'worker', agentType: 'general-purpose', effort: 'low', gate: testCommand },
  )
  const updated = await readState(taskId, mode)
  const checks = updated.checks.slice(checksBefore)
  const failedGate = checks.some(check => check.outcome === 'failed')
  const passedGate = checks.some(check => check.outcome === 'passed')
  updated.stage = 'worker'

  if (failedGate) {
    if (isRepair) updated.repairAttempts += 1
    await artifacts.write('state.json', JSON.stringify(updated, null, 2))
    return { needsRepair: true, repairAttempts: updated.repairAttempts }
  }
  if (result === null || !passedGate) {
    if (!updated.blockers.includes('Worker did not reach a passing verification gate.')) {
      updated.blockers.push('Worker did not reach a passing verification gate.')
    }
    await artifacts.write('state.json', JSON.stringify(updated, null, 2))
    return { providerFailure: result === null, repairAttempts: updated.repairAttempts }
  }

  if (isRepair) updated.repairAttempts += 1
  updated.reviewStatus = 'pending'
  updated.blockers = updated.blockers.filter(blocker => blocker !== 'Reviewer identified blockers.')
  await artifacts.write('state.json', JSON.stringify(updated, null, 2))
  return { status: 'implemented', repairAttempts: updated.repairAttempts, summary: result }
}

const state = await readState(taskId, mode)
const plan = await readPlan()
const savedPlan = JSON.stringify(plan, null, 2)
const latestCheck = state.checks[state.checks.length - 1]
const previousReviewText = await artifacts.read('review.md')
if ((state.reviewStatus === 'pass' || state.reviewStatus === 'fail' || state.reviewStatus === 'unverified')
  && latestCheck?.outcome === 'passed' && previousReviewText !== undefined) {
  let previousReview
  try {
    previousReview = JSON.parse(previousReviewText)
  } catch {
    previousReview = null
  }
  if (previousReview?.status === state.reviewStatus && safeText(previousReview.revisionId, 128)) {
    if (args.reviewContext === undefined || args.reviewContext?.revisionId === previousReview.revisionId) {
      return { status: state.reviewStatus, pass: state.reviewStatus === 'pass', reused: true }
    }
    return { status: 'unverified', pass: false, staleReview: true, requiresGate: true }
  }
}
if (latestCheck?.outcome !== 'passed') {
  state.stage = 'review'
  state.reviewStatus = 'unverified'
  if (!state.blockers.includes('No passing verification gate is recorded.')) {
    state.blockers.push('No passing verification gate is recorded.')
  }
  await artifacts.write('state.json', JSON.stringify(state, null, 2))
  await artifacts.write('review.md', JSON.stringify({ status: 'unverified', missingPassingGate: true }, null, 2))
  return { status: 'unverified', pass: false }
}
if (!reviewContextIsComplete(args.reviewContext, savedPlan)) {
  state.stage = 'review'
  state.reviewStatus = 'unverified'
  if (!state.blockers.includes('Review evidence missing; parent must supply the required context.')) {
    state.blockers.push('Review evidence missing; parent must supply the required context.')
  }
  await artifacts.write('state.json', JSON.stringify(state, null, 2))
  await artifacts.write('review.md', JSON.stringify({ status: 'unverified', missingEvidence: true }, null, 2))
  return { status: 'unverified', pass: false }
}

phase('Review')
const context = args.reviewContext
const review = await agent(
  `Review this change against the approved plan and original request. Return one requirement result per acceptance criterion, in the same order and with exact item text. Use only file:line or check:N evidence references; do not copy request, diff, source, secrets, or patient data.\n\nOriginal request:\n${context.originalRequest}\n\nApproved plan:\n${savedPlan}\n\nActual diff:\n${context.actualDiff}\n\nValidation results:\n${context.validationResults}\n\nUnresolved issues:\n${Array.isArray(context.unresolvedIssues) ? context.unresolvedIssues.join('\n') : context.unresolvedIssues}`,
  { label: 'review', agentType: 'reviewer', effort: 'high', schema: REVIEW_SCHEMA },
)

const validReview = review !== null && typeof review === 'object'
  && Array.isArray(review.requirements)
  && review.requirements.length === plan.acceptance.length
  && review.requirements.every((item, index) => item.item === plan.acceptance[index]
    && ['pass', 'fail', 'unverified'].includes(item.status)
    && Array.isArray(item.evidence))
  && Array.isArray(review.blockers) && Array.isArray(review.residualRisks)

if (!validReview) {
  state.stage = 'review'
  state.reviewStatus = 'unverified'
  state.blockers.push('Reviewer response did not match approved requirements.')
  await artifacts.write('state.json', JSON.stringify(state, null, 2))
  await artifacts.write('review.md', JSON.stringify({ status: 'unverified', responseValid: false }, null, 2))
  return { status: 'unverified', pass: false }
}

const hasFailure = review.blockers.length > 0 || review.requirements.some(item => item.status === 'fail')
const hasUnverified = review.requirements.some(item => item.status === 'unverified')
const status = hasFailure ? 'fail' : hasUnverified ? 'unverified' : 'pass'
state.stage = 'review'
state.reviewStatus = status
if (review.blockers.length > 0 && !state.blockers.includes('Reviewer identified blockers.')) {
  state.blockers.push('Reviewer identified blockers.')
}
await artifacts.write('state.json', JSON.stringify(state, null, 2))
await artifacts.write('review.md', JSON.stringify({
  status,
  revisionId: context.revisionId,
  requirements: review.requirements.map((item, index) => ({
    item: plan.acceptance[index],
    status: item.status,
    evidence: item.evidence.filter(safeEvidence),
  })),
  blockerCount: review.blockers.length,
  residualRiskCount: review.residualRisks.length,
}, null, 2))
return { status, pass: status === 'pass', review }
