/**
 * Staff RBAC helpers — super_admin/admin, bd/agent, agency (legacy aliases preserved).
 */

export function isSuperAdminRole(role: string | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}

export function isBdRole(role: string | undefined): boolean {
  return role === 'agent' || role === 'bd';
}

export function isAgencyRole(role: string | undefined): boolean {
  return role === 'agency';
}

/** BD/recruiter login blocked when true (shared field name for legacy agent rows). */
export function isStaffRecruiterDisabled(u: { agentDisabled?: boolean }): boolean {
  return u.agentDisabled === true;
}

export function isAgencyStaffDisabled(u: { agencyDisabled?: boolean }): boolean {
  return u.agencyDisabled === true;
}

/** Roles that must not use consumer coin-purchase shortcuts (staff + creators). */
export function isNonConsumerCoinsRole(role: string | undefined): boolean {
  return (
    role === 'creator' ||
    isSuperAdminRole(role) ||
    isBdRole(role) ||
    isAgencyRole(role)
  );
}

/** Dashboard staff accounts that cannot become hosts via referral promotion. */
export function isDashboardStaffRole(role: string | undefined): boolean {
  return isSuperAdminRole(role) || isBdRole(role) || isAgencyRole(role);
}
