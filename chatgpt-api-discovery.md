# ChatGPT backup API discovery

As of October 10, 2026. This describes the website endpoints used by
`chatGPTRead` and `chatGPTInventory` in [chatgpt-backup.js](chatgpt-backup.js),
not a supported public API contract. No new live requests were made for this
documentation. Response fields below are those the implementation consumes;
they are not an exhaustive response schema.

## What inventory gives us

Inventory is our name for a sequence of listing requests, not one endpoint:

1. List recent and archived conversations.
2. Refresh project IDs and names only when a conversation references an unknown project ID.

Project names are reused from the scoped projects table. Per-project conversation
listing is no longer part of sync. Legacy conversation cursors for those lists
are discarded; recent and archived cursors retain their continuation state.

The result is a durable catalog of conversation IDs, titles, project membership,
and remote update timestamps, plus pagination checkpoints. It lets us queue new
conversations, refresh changed ones, and resume discovery after interruption.
An unchanged observation does not create duplicate download work.

**This catalog does not provide conversation message content.** A project
conversation list identifies the conversations to fetch; separate message-page
requests retrieve their content. The current backup does not retrieve project
instructions, project source files, or attachment binaries. Discovering a project
and backing up its conversations is not a backup of every kind of project content.

## How unknown projects are resolved

The first project-list request is:

```text
GET https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0
```

The implementation reads `items[].gizmo.gizmo.id` and
`items[].gizmo.gizmo.display.name`, then follows the response's `cursor` until
null. IDs with the `g-p-` prefix identify projects. The parameter explicitly
requests zero embedded conversations per project, so the code uses this call
for project discovery and does not request their conversation lists.

The project list is paginated on demand, with at most one refresh per scan.
Empty projects and project renames/deletions alone do not trigger a refresh.

## Calls currently implemented

All calls use GET. Placeholder values must be URL-encoded where appropriate.

| Purpose | Path on `https://chatgpt.com` | Fields used / continuation |
| --- | --- | --- |
| Resolve signed-in identity and page-local credentials | `/api/auth/session` | `user.id`, `accessToken`, `expires` |
| Verify selected workspace, when a workspace selector exists | `/backend-api/accounts/check/v4-2023-04-27` | `accounts`, account `account_id` and `structure` |
| List projects | `/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0` | Nested project ID/name described above; append `&cursor=<cursor>` for subsequent pages |
| List recent conversations | `/backend-api/conversations?offset=0&limit=50&order=updated&is_archived=false` | `items[].id`, `title`, `update_time`, `gizmo_id`; advance offset by returned item count until `total` is reached |
| List archived conversations | `/backend-api/conversations?offset=0&limit=50&order=updated&is_archived=true` | Same fields and offset pagination as recent conversations |
| Fetch latest conversation message page | `/backend-api/conversations/<conversation-id>?num_turns=10&include_has_versions=true` | Structured conversation/message JSON; persisted before requesting older pages |
| Fetch older conversation message page | `/backend-api/conversations/<conversation-id>/messages?before=<cursor>&num_turns=10&include_has_versions=true` | Older messages; follow `page_info.start_cursor` while `page_info.has_previous_page` is true |

List processing also checks `has_missing_conversations` and uses `is_starred`
and `pinned_time` when checking update ordering. It requires explicit pagination
metadata rather than assuming a short page means completion.

Authenticated backend calls use `Authorization: Bearer <page-local token>`.
They include `Chatgpt-Account-Id` when workspace resolution provides an account
ID. Conversation-content calls additionally include `Chatgpt-Project-Id` when
project membership is known. Requests run inside an authenticated ChatGPT page;
credentials are not sent to our archive service or stored in extension storage.

## Coverage assumption

Sync assumes recent and archived listings include accessible project conversations
and report their membership through `gizmo_id`. The October 10 live tests created
a conversation inside TCN and moved a standalone conversation into TCN. Both
appeared in `list_threads` with the correct project ID; the moved conversation
previously had a null project ID. Direct raw Recents endpoint navigation was
blocked by the browser, so raw API equivalence remains unverified.
