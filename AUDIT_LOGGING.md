# Audit Logging Structure

## Overview

Structured logging has been added for admin actions that modify user roles and creator profiles. These logs are currently output to console but are structured for future integration with an audit log system.

## Log Events

### ADMIN_PROMOTED_USER

**Triggered when:** Admin promotes a user to creator via `POST /user/:id/promote-to-creator`

**Log Structure:**
```
📝 [AUDIT] ADMIN_PROMOTED_USER
   Admin: {adminId} ({adminEmail|adminPhone})
   User: {userId} ({userEmail|userPhone})
   Creator Profile: {creatorId}
   Timestamp: {ISO8601}
```

**Location:** `backend/src/modules/user/user.controller.ts` → `promoteToCreator()`

**Future Integration:**
- Store in audit_log collection
- Include IP address, user agent
- Link to admin session
- Add metadata (categories, price set)

### ADMIN_DEMOTED_CREATOR

**Triggered when:** Admin deletes a creator profile via `DELETE /creator/:id`

**Log Structure:**
```
📝 [AUDIT] ADMIN_DEMOTED_CREATOR
   Admin: {adminId} ({adminEmail|adminPhone})
   Creator Profile: {creatorId}
   User: {userId} (downgraded to 'user')
   Timestamp: {ISO8601}
```

**Location:** `backend/src/modules/creator/creator.controller.ts` → `deleteCreator()`

**Future Integration:**
- Store in audit_log collection
- Include IP address, user agent
- Link to admin session
- Add reason/notes field (optional)

## Implementation Notes

1. **Current State:** Console logging only
2. **Transaction Safety:** Both operations use MongoDB transactions to ensure atomicity
3. **Error Handling:** Failed operations are rolled back and logged
4. **Structured Format:** Logs follow consistent format for easy parsing

## Future Enhancements

1. **Dedicated Audit Log Collection:**
   ```typescript
   interface AuditLog {
     event: 'ADMIN_PROMOTED_USER' | 'ADMIN_DEMOTED_CREATOR';
     adminId: ObjectId;
     targetUserId: ObjectId;
     metadata: Record<string, any>;
     ipAddress?: string;
     userAgent?: string;
     timestamp: Date;
   }
   ```

2. **Retention Policy:** Define how long audit logs are kept

3. **Query Interface:** Admin dashboard to view audit history

4. **Alerts:** Notify on suspicious patterns (e.g., bulk promotions)
