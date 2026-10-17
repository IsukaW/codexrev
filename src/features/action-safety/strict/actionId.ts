/** The action id derived from the action and the OBSERVED Git commit, so the assessment and its record agree without coordination. */
export const deriveActionId = (actionType: string, environment: string, commit: string): string => `${actionType}-${environment}-${commit.slice(0, 12)}`;
