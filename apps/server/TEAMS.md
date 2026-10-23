# Microsoft Teams (P5, work only)

Read-only · Entra app Claude-Operator. Configure Graph access outside the app; there is no Microsoft sign-in UI.

Watches the chats and channels you pick for: your name or @mentions, your ticket and PR numbers, and words like "bug", "broken" or "urgent" near your areas.

Matches become Needs you items or a FLIGHT digest, with a link to the message. FLIGHT can draft a GitHub issue from one for you to approve. Polling never invokes ticket publication tools.

Polls on a timer; Graph change notifications need a public HTTPS endpoint, which a local app doesn't have. Mission Control never posts to Teams.

Configure the following locally (all source names and identifiers below are fictional):

```yaml
sources:
  teams:
    token_command: [az, account, get-access-token, --resource-type, ms-graph, --query, accessToken, -o, tsv]
    aliases: [Operator]
    refs: ['#42', 'PR #57']
    areas:
      - repoId: work
        words: [catalog]
        keywords: [bug, broken, urgent]
    selected:
      - kind: chat
        id: fictional-work-chat
        name: Work chat
        repoId: work
        lane: work
      - kind: channel
        teamId: fictional-team
        id: fictional-channel
        name: Work channel
        repoId: work
        lane: work
```

The repo must already exist in local configuration. Personal selections are never polled. The server polls every minute, with at most five pages per selected source per poll; unfinished message and reply pagination resumes on the next poll, including after restart. Channel reads expand replies. Completed chat watermarks filter subsequent reads with a timestamp overlap; channels rescan because their API does not support date filters. Exact message revisions suppress repeats. Permission failures stop all Teams reads until the operator changes the configured token command. Other failures back off; 401 refreshes the token once before retrying.

`GET /api/sources/teams` returns configuration status, selected sources and safe failure text. `POST /api/sources/teams/selection` accepts only `{selected: [...]}`, validates work sources, and uses the same serialized, validated, backed-up atomic file replacement as other config actions. It cannot change the token command. Web wiring is a separate ticket.

## Source authentication and data handling security note

The configured token command executes as argv without a shell, with a ten-second timeout and a 16 KiB output cap. It runs only on the machine; tokens live only in the collector invocation and request headers. Tokens, command stdout/stderr and Graph error bodies are never stored, logged, returned to the browser or included in errors. HTTP redirects are refused. Every request is a GET to the selected source's Graph message/reply endpoint, and pagination cannot redirect credentials to another host or another source. Preview servers disable Teams polling.

403 reports "not permitted with this login" and the required `Chat.Read` and `ChannelMessage.Read.All` scopes. Configure the login/app consent externally. With no command, the source is off and status explains `sources.teams.token_command`.

Matching message text, author display text, message links, source identifiers and revisions are persisted in the existing local notification store and presented to FLIGHT as untrusted source content. Store access has the same machine trust boundary as the rest of the hub. Source text cannot choose commands, posting targets or issue publication. Existing explicit ticket tools retain their approval requirements.

Graph pagination/query behavior follows the official [chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0) and [channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0) documentation.
