export function deriveLearning(state = {}) {
  return { schema: 'runvara-learning/v1', workspaceId: String(state.workspace?.id || ''), safeguards: { externalWrites: false, approvalsPreserved: true } };
}
