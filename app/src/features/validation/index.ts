/** Public surface of the validation module (for the record card and other screens). */
export * from './rules';
export { ChecklistEditor, ChecklistForm, ValidationReasons, ValidationStatusBadge, checklistStateFrom, suggestStatus, validationReasons } from './Checklist';
export type { ChecklistState } from './Checklist';
export { combinedConfidence, describeProposal, groupProposals } from './grouping';
