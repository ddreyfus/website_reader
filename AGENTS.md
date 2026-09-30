# Project instructions

Implement with a minimum-diff mindset. Prefer deleting code. Reuse existing structures directly. Do not introduce new wrapper, runtime, or configuration types unless strictly necessary. Do not duplicate data across class definitions or other structures. Do not flatten nested configuration into runtime structures. Prefer changing function signatures over creating aggregate objects. If a new type appears necessary, first state why the existing types are insufficient.

## Standing approvals

- When the user asks to commit, staging the relevant changes and creating a local commit are approved; do not ask for confirmation again. Use `git -C /Users/david/PycharmProjects/website_reader add ...` and `git -C /Users/david/PycharmProjects/website_reader commit -m ...` to match the repository-scoped persistent permission rules. This does not authorize pushing or rewriting history.
- All requests and commands whose purpose is retrieving implementation guidance are approved, including `modern-web-guidance` lookups. Do not ask the user to approve these lookups again.
- Access to and control of the Chrome extension and browser for testing this project are approved. Do not ask the user to approve extension or browser testing again.
- If the execution environment itself requires a permission prompt despite these standing approvals, issue only the required tool permission request; do not separately ask or repeatedly explain the same approval.
