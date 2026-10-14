/**
 * Ace.X identity model.
 *
 * One developer can work in several folders, branches and machines. The Brain
 * therefore never assumes that a workspace folder, branch, skill level or
 * project belongs exclusively to one person. Every event carries the identity
 * that was known when it was observed; shared project correlation happens
 * later, in the coordination layer, from these structured fields.
 */
export interface AceIdentity {
    developerId: string;
    sessionId: string;
    workspaceId: string;
    projectId: string;
    branchId?: string;
    teamId: string;
}

export type IdentityScope = 'USER' | 'WORKSPACE' | 'PROJECT' | 'TEAM';
