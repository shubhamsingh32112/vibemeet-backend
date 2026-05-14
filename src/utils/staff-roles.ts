/**
 * Staff RBAC helpers — super_admin/admin, bd (top tier), agency (middle tier).
 */

export function isSuperAdminRole(role: string | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}

/** Top-tier BD org account (under super admin). */
export function isBdRole(role: string | undefined): boolean {
  return role === 'bd';
}

/** Middle-tier agency recruiter account (under BD). */
export function isAgencyRole(role: string | undefined): boolean {
  return role === 'agency';
}

/** Middle-tier agency login blocked when true. */
export function isAgencyStaffDisabled(u: { agencyDisabled?: boolean }): boolean {
  return u.agencyDisabled === true;
}

/** Top-tier BD login blocked when true. */
export function isBdStaffDisabled(u: { bdDisabled?: boolean }): boolean {
  return u.bdDisabled === true;
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

/** Mongo filter for middle-tier agency staff users. */
export const AGENCY_ROLE_QUERY = { role: 'agency' as const };

/** Mongo filter for top-tier BD staff users. */
export const BD_ROLE_QUERY = { role: 'bd' as const };
