'use strict';

const schema = require('./schema');
const eligibility = require('./eligibility');
const prompt = require('./prompt');
const judge = require('./judge');
const run = require('./run');
const aggregates = require('./aggregates');
const dashboard = require('./dashboard');
const config = require('./config');
const jevReview = require('./jev-review');
const stateEvidence = require('./state-evidence');

module.exports = {
  REVIEW_VERSION: schema.REVIEW_VERSION,
  REVIEW_PROMPT_VERSION: schema.REVIEW_PROMPT_VERSION,
  schema,
  eligibility,
  prompt,
  judge,
  aggregates,
  dashboard,
  config,
  jevReview,
  stateEvidence,
  buildStateEvidence: stateEvidence.buildStateEvidence,
  judgeViaJev: jevReview.judgeViaJev,
  emptyReviewState: schema.emptyReviewState,
  validateAssessment: schema.validateAssessment,
  isReviewable: eligibility.isReviewable,
  displayReviewStatus: eligibility.displayReviewStatus,
  autoDecision: eligibility.autoDecision,
  manualDecision: eligibility.manualDecision,
  parseJudgeResponse: judge.parseJudgeResponse,
  buildJudgePrompt: prompt.buildJudgePrompt,
  buildJudgeContext: prompt.buildJudgeContext,
  reviewOne: run.reviewOne,
  reviewSession: run.reviewSession,
  runBatch: run.runBatch,
  qualityFromStore: run.qualityFromStore,
  fromRecords: aggregates.fromRecords,
  dashboardSummary: dashboard.summarize,
  dashboardFromStore: dashboard.fromStore,
  compactHealth: dashboard.compactHealth,
  periodWindow: dashboard.periodWindow,
  needsAttention: dashboard.needsAttention,
  resolveReviewConfig: config.resolveReviewConfig,
};
