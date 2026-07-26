/**
 * Authorization helpers for API routes
 *
 * Thin wrappers around @emdash-cms/auth RBAC that return HTTP responses.
 * Auth middleware handles authentication; these handle authorization.
 */

import type { Permission, RoleLevel } from "@emdash-cms/auth";
import { hasPermission, canActOnOwn, hasScope } from "@emdash-cms/auth";

import { apiError } from "./error.js";

interface UserLike {
	id: string;
	role: RoleLevel;
}

/**
 * May this caller see non-published content (drafts, scheduled, trash)?
 *
 * Role alone is not enough. API tokens are always owned by an admin -- creating
 * one requires `Role.ADMIN` and records the caller as its owner -- so gating on
 * the owner's role lets every token read drafts no matter how narrowly it was
 * scoped. A key issued for a public website with `content:read` would still be
 * served unpublished pages, which means unpublishing does not take content off
 * the site.
 *
 * So a token must additionally carry the `admin` scope. Session-authenticated
 * requests have no scopes (`tokenScopes === undefined`) and are judged on role
 * alone as before, which leaves the admin UI untouched.
 */
export function canReadDrafts(
	user: UserLike | null | undefined,
	tokenScopes: string[] | undefined,
): boolean {
	return (
		hasPermission(user, "content:read_drafts") && (!tokenScopes || hasScope(tokenScopes, "admin"))
	);
}

/**
 * Check if user has a permission. Returns a 401/403 Response if not, or null if authorized.
 *
 * Usage:
 * ```ts
 * const denied = requirePerm(user, "schema:manage");
 * if (denied) return denied;
 * ```
 */
export function requirePerm(
	user: UserLike | null | undefined,
	permission: Permission,
): Response | null {
	if (!user) {
		return apiError("UNAUTHORIZED", "Authentication required", 401);
	}
	if (!hasPermission(user, permission)) {
		return apiError("FORBIDDEN", "Insufficient permissions", 403);
	}
	return null;
}

/**
 * Check if user can act on a resource, considering ownership.
 * Returns a 401/403 Response if not, or null if authorized.
 *
 * Usage:
 * ```ts
 * const denied = requireOwnerPerm(user, item.authorId, "content:edit_own", "content:edit_any");
 * if (denied) return denied;
 * ```
 */
export function requireOwnerPerm(
	user: UserLike | null | undefined,
	ownerId: string,
	ownPermission: Permission,
	anyPermission: Permission,
): Response | null {
	if (!user) {
		return apiError("UNAUTHORIZED", "Authentication required", 401);
	}
	if (!canActOnOwn(user, ownerId, ownPermission, anyPermission)) {
		return apiError("FORBIDDEN", "Insufficient permissions", 403);
	}
	return null;
}
