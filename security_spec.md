# Security Specification: Group Expense App

## 1. Data Invariants
- An **Expense** must always belong to a valid **Group**.
- An **Expense** can only be created, read, or modified by a **Member** of that group.
- A **Member** must have a unique identifier combining `userId_groupId` to ensure relational sync.
- **Total Spending** in a group must be incremented/decremented when expenses are added/removed (enforced by application logic and transactions).
- **Security Rules** must enforce that only verified users can create groups or expenses.
- **Admin/Owner** roles have elevated permissions for group management and member removal.

## 2. The "Dirty Dozen" Payloads (Red Team Scenarios)

| ID | Goal | Target Collection | Payload | Success Condition |
|---|---|---|---|---|
| D1 | Unauthorized Read | `/groups/{groupId}` | Any read from non-member | `PERMISSION_DENIED` |
| D2 | Self-Elevation | `/members/{userId_groupId}` | Update `role: 'owner'` by non-admin | `PERMISSION_DENIED` |
| D3 | Shadow Update | `/expenses/{id}` | Update `amount` + `extra: 'exploit'` | `PERMISSION_DENIED` (hasOnly) |
| D4 | Spoofed Payer | `/expenses/{id}` | Create expense where `paidBy != request.auth.uid` (if restricted) | `PERMISSION_DENIED` |
| D5 | Denial of Wallet | `/groups/{id}` | Create group name with 1MB string | `PERMISSION_DENIED` (size check) |
| D6 | Cross-Group Leak | `/expenses/{id}` | Query expenses where `groupId == {otherGroupId}` | `PERMISSION_DENIED` |
| D7 | Unverified Write | `/groups/{id}` | Create group with `email_verified: false` | `PERMISSION_DENIED` |
| D8 | Orphaned Member | `/members/{id}` | Create member for non-existent group | `PERMISSION_DENIED` (exists check) |
| D9 | Identity Spoofing | `/users/{userId}` | Update `email` of another user | `PERMISSION_DENIED` |
| D10| Zero Amount | `/expenses/{id}` | Create expense with `-100.00` | `PERMISSION_DENIED` (val >= 0) |
| D11| Future Tamper | `/expenses/{id}` | Update `addedBy` field post-creation | `PERMISSION_DENIED` (immutability) |
| D12| Activity Spam | `/activities/{id}` | Create activity for group I am not in | `PERMISSION_DENIED` |

## 3. Test Runner Design
The tests will use `@firebase/rules-unit-testing` to simulate authenticated users and verify that the "Dirty Dozen" payloads are correctly rejected.
