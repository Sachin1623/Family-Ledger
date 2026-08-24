# End-to-End (E2E) Test Plan: Group Expense App

## 1. Authentication & Profile
- **Scenario**: User signs in for the first time.
  - **Steps**: Click "Sign in with Google", grant permissions.
  - **Expectation**: Redirected to dashboard, user document created in Firestore.
- **Scenario**: Update Profile.
  - **Steps**: Go to Profile tab, change display name, toggle notifications.
  - **Expectation**: Changes persist after refresh.

## 2. Group Management
- **Scenario**: Create a new group.
  - **Steps**: Click "Create Group", enter name, select currency, select members, click "Create".
  - **Expectation**: Group appears in "Groups" tab, activity logged: "X created the group".
- **Scenario**: Change Group Icon.
  - **Steps**: Manage Group -> Select new icon -> Save.
  - **Expectation**: Icon updates instantly, activity logged.
- **Scenario**: Invite Member.
  - **Steps**: Manage Group -> Enter email -> Click "Invite".
  - **Expectation**: Activity logged: "Invite sent to X@email.com".

## 3. Expense Tracking
- **Scenario**: Add Expense.
  - **Steps**: Select Group -> Click "+" -> Enter amount, description, category -> Click "Save".
  - **Expectation**: Total amount updates, expense appears in list, activity logged.
- **Scenario**: Edit Expense.
  - **Steps**: Group Expenses -> Click on an expense -> Change amount -> Click "Save".
  - **Expectation**: Total amount updates correctly (transactional), activity logged with old/new amounts.
- **Scenario**: Delete Expense.
  - **Steps**: Group Expenses -> Click on an expense -> Click "Delete" -> Confirm.
  - **Expectation**: Expense removed, total adjusted, activity logged.

## 4. Search & Filtering
- **Scenario**: Search by Description/Member/Category.
  - **Steps**: Enter text in search bar on Group Expenses page.
  - **Expectation**: List filters in real-time.
- **Scenario**: Filter by Date Range.
  - **Steps**: Select Start/End dates.
  - **Expectation**: Only expenses within range are shown.

## 5. Analysis & Summary
- **Scenario**: View All Groups Analysis.
  - **Steps**: Go to Analysis tab -> Select "All Groups".
  - **Expectation**: Pie chart shows spending per group. Member contributions show combined data.
- **Scenario**: Member Contribution Split.
  - **Steps**: Observe bar chart for members.
  - **Expectation**: Bars are segmented by categories (food, travel, etc.).

## 6. Security & Edge Cases
- **Scenario**: Unauthorized Access.
  - **Steps**: Manually navigate to a group URL the user doesn't belong to.
  - **Expectation**: "Access Denied" or redirected to home.
- **Scenario**: Zero/Negative Amount.
  - **Steps**: Try adding -1.00.
  - **Expectation**: Save button disabled or error message shown.
