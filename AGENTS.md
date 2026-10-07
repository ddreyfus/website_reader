# Project instructions

Implement with a minimum-diff mindset. Prefer deleting code. Reuse existing structures directly. Do not introduce new wrapper, runtime, or configuration types unless strictly necessary. Do not duplicate data across class definitions or other structures. Do not flatten nested configuration into runtime structures. Prefer changing function signatures over creating aggregate objects. If a new type appears necessary, first state why the existing types are insufficient.

## Standing approvals

These are persistent user authorizations for this project, applicable now and in future chats. Do not ask for confirmation for the following activities when they are necessary to implement, diagnose, or test the user's requested work:

- Read, search, create, edit, and format project files and relevant temporary test artifacts. Run builds, linters, type checks, syntax checks, unit tests, integration tests, browser tests, and regression suites, including individual tests and diagnostic scripts.
- Install or update project dependencies and download the browser binaries or other local tools needed for development and testing. Retrieve implementation guidance and official documentation, including `modern-web-guidance` lookups and the network access required by these activities.
- Inspect relevant processes, listening ports, local endpoints, configurations, and logs. Launch test browsers and control the project's Chrome extension and browser tabs, including extension reloads and testing navigation, tab closure, login/access pauses, downloads, and background worker suspension or termination. Use isolated test profiles where practical.
- Start, stop, restart, and inspect this project's local services and test processes. Install, update, enable, or reload project-specific macOS LaunchAgents and edit the associated local configuration and logs when required for the requested work. Briefly terminate a project service or extension worker to verify automatic recovery. Do not stop unrelated processes or change unrelated system settings.
- Remove generated temporary profiles, fixtures, build output, and failed test downloads created by the agent. Preserve user documents, reading archives, credentials, and unrelated changes.

- When the user asks to commit, staging the relevant changes and creating a local commit are approved; do not ask for confirmation again. Use `git -C /Users/david/PycharmProjects/website_reader add ...` and `git -C /Users/david/PycharmProjects/website_reader commit -m ...` to match the repository-scoped persistent permission rules. This does not authorize pushing or rewriting history.

Prefer existing approved command prefixes and project npm scripts over equivalent new command forms. In particular, use `npm run test:extension` for extension regression tests and `npm run bleve:install` for LaunchAgent installation when applicable. Do not create an avoidable permission request by changing the command spelling or embedding an approved command in a new shell wrapper.

Keep file edits and test execution in separate tool calls. Never bundle an editing script, heredoc, or file mutation with a test command in the same shell invocation. Run approved test commands directly so their existing approval prefixes match.

When requesting a reusable command approval, use the shortest prefix that identifies the authorized activity, such as `["node", "--test"]` or `["npx", "playwright", "test"]`. Do not include test filenames, query text, parameter values, process IDs, ports, or other incidental arguments that would require renewed approval when they change. Keep unrelated command capabilities outside the approved prefix.

These authorizations do not override the execution environment's sandbox or approval policy. If that environment requires a permission prompt, issue only the required tool request, with a narrowly scoped reusable command prefix when supported; do not separately ask for confirmation or repeatedly explain the same approval. A rejected execution request is not permission to bypass that restriction.

Destructive operations on user data, credential disclosure, pushing or rewriting Git history, publishing, and messaging other people require separate authorization unless already explicitly requested by the user.
