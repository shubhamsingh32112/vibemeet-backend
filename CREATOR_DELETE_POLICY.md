# Creator Deletion Policy

## Business Rule

**When a creator profile is deleted, the associated user's role is ALWAYS downgraded from 'creator' to 'user'.**

## Rationale

1. **Data Consistency**: If a creator profile no longer exists, the user should not retain the 'creator' role. This prevents orphaned creator roles.

2. **Explicit State**: The user's role should always reflect their actual state. No creator profile = no creator role.

3. **No Ambiguity**: This is a hard rule, not optional. There is no "keep role but remove profile" option.

## Implementation

- Location: `backend/src/modules/creator/creator.controller.ts` → `deleteCreator()`
- Behavior: After deleting creator document, always check if user.role === 'creator' and set to 'user'
- Exception: Admin users are never downgraded (they keep 'admin' role)

## Example

```
Before:
- User: { role: 'creator', ... }
- Creator: { userId: user._id, ... }

After DELETE /creator/:id:
- User: { role: 'user', ... }  ← Automatically downgraded
- Creator: (deleted)
```

## Migration Note

If you need to delete a creator profile but keep the user as a creator (e.g., for temporary suspension), you should:
1. Mark the creator as inactive (add `active: false` field) instead of deleting
2. Filter inactive creators in queries
3. Only delete when you truly want to remove creator status
