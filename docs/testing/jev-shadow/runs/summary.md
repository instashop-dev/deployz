# Jev shadow evaluation — run summary

Deployz commit: `4c34c843d2255ca0e1a8fd22b7ddb6fbce6cac7a` · analysis version: 24 · mode: requirements

| Metric | Value |
| --- | --- |
| Repositories | 120 |
| Analysed | 120 |
| Failed to analyse | 0 |
| Resumed (skipped) | 0 |
| Capped by --max-calls | 0 |
| Planned (--plan) | 0 |
| Jev calls | 120 / 150 |

## Stratification

| Bucket | Repositories | Members |
| --- | --- | --- |
| A | 11 | repo-009, repo-075, repo-201, repo-203, repo-205, repo-207, repo-209, repo-210, repo-214, repo-218, repo-219 |
| B | 0 | — |
| C | 1 | repo-079 |
| D | 95 | repo-001, repo-002, repo-003, repo-004, repo-005, repo-006, repo-008, repo-010, repo-011, repo-013, repo-014, repo-015, repo-016, repo-017, repo-018, repo-019, repo-020, repo-021, repo-022, repo-023, repo-024, repo-025, repo-026, repo-027, repo-028, repo-029, repo-030, repo-031, repo-032, repo-033, repo-034, repo-035, repo-036, repo-037, repo-038, repo-039, repo-040, repo-041, repo-042, repo-043, repo-044, repo-045, repo-046, repo-047, repo-048, repo-049, repo-050, repo-051, repo-052, repo-053, repo-054, repo-055, repo-056, repo-057, repo-058, repo-059, repo-060, repo-061, repo-062, repo-063, repo-064, repo-065, repo-066, repo-067, repo-068, repo-069, repo-070, repo-071, repo-072, repo-073, repo-074, repo-076, repo-077, repo-078, repo-080, repo-081, repo-082, repo-083, repo-084, repo-085, repo-086, repo-087, repo-088, repo-089, repo-090, repo-091, repo-092, repo-093, repo-094, repo-095, repo-096, repo-097, repo-098, repo-099, repo-100 |
| E | 13 | repo-007, repo-012, repo-202, repo-204, repo-206, repo-208, repo-211, repo-212, repo-213, repo-215, repo-216, repo-217, repo-220 |

## Per-decision confusion (labels from benchmark.yaml expected facts)

| Decision | Labelled | Unlabelled | Unresolved | Deployz TP/FP/FN/TN | Jev TP/FP/FN/TN | Agree/Disagree/Uncertain |
| --- | --- | --- | --- | --- | --- | --- |
| postgres | 120 | 0 | 0 | 82/7/9/22 | 82/7/9/22 | 120/0/0 |
| redis | 120 | 0 | 0 | 22/28/4/66 | 22/28/4/66 | 120/0/0 |
| storage | 120 | 0 | 0 | 31/19/11/59 | 31/19/11/59 | 119/0/1 |

## Jev availability and cost

| Metric | Value |
| --- | --- |
| Successful calls | 120 |
| Errors | — |
| Latency p50/p90/p99 (ms) | 414 / 481 / 1707 |
| Tokens (input/output) | 538513 / 32775 |

## Repositories

| Id | Repository | Bucket | Status | Deployz (pg/redis/storage) | Labels (pg/redis/storage) |
| --- | --- | --- | --- | --- | --- |
| repo-001 | umami-software/umami@ca661c7 | D | analysed | true/true/false | true/false/false |
| repo-002 | Unleash/unleash@0429c29 | D | analysed | true/false/false | true/false/false |
| repo-003 | thedevs-network/kutt@279b491 | D | analysed | true/true/false | true/false/false |
| repo-004 | miniflux/v2@a84533d | D | analysed | true/false/false | true/false/false |
| repo-005 | Flagsmith/flagsmith@4a8a84a | D | analysed | true/true/false | true/false/false |
| repo-006 | documenso/documenso@3ec877a | D | analysed | true/true/true | true/false/false |
| repo-007 | ghostfolio/ghostfolio@73e4f03 | E | analysed | true/true/false | true/true/false |
| repo-008 | TwiN/gatus@4d15cb7 | D | analysed | true/false/false | false/false/false |
| repo-009 | heroku/node-js-getting-started@63c6674 | A | analysed | false/false/false | false/false/false |
| repo-010 | knadh/listmonk@670c017 | D | analysed | true/false/true | true/false/false |
| repo-011 | healthchecks/healthchecks@69dbd2a | D | analysed | true/false/false | true/false/false |
| repo-012 | diced/zipline@a2ac5f2 | E | analysed | true/false/true | true/false/true |
| repo-013 | louislam/uptime-kuma@5df2a3c | D | analysed | false/true/false | false/false/false |
| repo-014 | automatisch/automatisch@41f3c56 | D | analysed | true/true/false | true/true/false |
| repo-015 | immich-app/immich@6d85f20 | D | analysed | true/true/false | true/true/false |
| repo-016 | outline/outline@0121886 | D | analysed | true/true/true | true/true/true |
| repo-017 | lukevella/rallly@d374ed4 | D | analysed | true/false/true | true/false/false |
| repo-018 | docmost/docmost@5b85464 | D | analysed | true/true/true | true/true/true |
| repo-019 | linkwarden/linkwarden@789aa2b | D | analysed | true/false/true | true/false/true |
| repo-020 | papermark/papermark@ed19717 | D | analysed | true/false/true | true/false/true |
| repo-021 | directus/directus@ea25ba6 | D | analysed | true/true/true | true/false/true |
| repo-022 | ToolJet/ToolJet@e216f7c | D | analysed | true/true/true | true/false/false |
| repo-023 | requarks/wiki@8a97969 | D | analysed | true/false/false | true/false/false |
| repo-024 | calcom/cal.diy@e70486c | D | analysed | true/true/false | true/false/false |
| repo-025 | lobehub/lobehub@5590527 | D | analysed | true/false/true | true/false/true |
| repo-026 | amruthpillai/reactive-resume@0a092ee | D | analysed | true/true/true | true/false/true |
| repo-027 | plankanban/planka@de4d768 | D | analysed | true/false/true | true/false/true |
| repo-028 | Infisical/infisical@496d992 | D | analysed | true/true/true | true/true/false |
| repo-029 | postalsys/emailengine@1933e5d | D | analysed | false/true/false | false/true/false |
| repo-030 | verdaccio/verdaccio@8b2b136 | D | analysed | false/false/false | false/false/false |
| repo-031 | gethomepage/homepage@ddc5adc | D | analysed | false/false/false | false/false/false |
| repo-032 | mealie-recipes/mealie@8faccff | D | analysed | true/false/false | true/false/false |
| repo-033 | paperless-ngx/paperless-ngx@a28a6fe | D | analysed | true/false/false | true/true/false |
| repo-034 | CTFd/CTFd@91ced62 | D | analysed | true/true/false | false/false/true |
| repo-035 | spiral-project/ihatemoney@e66a767 | D | analysed | true/false/false | true/false/false |
| repo-036 | django-helpdesk/django-helpdesk@1cc6776 | D | analysed | true/false/false | true/false/false |
| repo-037 | apache/superset@765a4ec | D | analysed | true/true/true | true/false/false |
| repo-038 | apache/answer@3b9f137 | D | analysed | true/false/false | true/false/false |
| repo-039 | usememos/memos@dfa0fda | D | analysed | true/false/true | true/false/true |
| repo-040 | authelia/authelia@fd4b742 | D | analysed | true/false/false | true/false/false |
| repo-041 | coder/coder@07f9018 | D | analysed | true/false/true | true/false/false |
| repo-042 | grafana/grafana@0ecd582 | D | analysed | true/false/true | true/false/false |
| repo-043 | huginn/huginn@fc1f557 | D | analysed | true/false/true | true/false/false |
| repo-044 | firefly-iii/firefly-iii@9e9d6f4 | D | analysed | false/true/false | true/false/false |
| repo-045 | monicahq/monica@e08e917 | D | analysed | true/true/false | true/false/true |
| repo-046 | kanboard/kanboard@9ce6a5e | D | analysed | false/false/false | true/false/false |
| repo-047 | halo-dev/halo@4e7e585 | D | analysed | true/false/false | true/false/false |
| repo-048 | tolgee/tolgee-platform@241ce68 | D | analysed | true/false/true | true/false/true |
| repo-049 | OrchardCMS/OrchardCore@2ae5053 | D | analysed | false/false/true | true/false/true |
| repo-050 | livebook-dev/livebook@f18f203 | D | analysed | false/false/false | false/false/false |
| repo-051 | docusealco/docuseal@c216e43 | D | analysed | true/true/true | true/false/true |
| repo-052 | laurent22/joplin@21a7dd4 | D | analysed | true/false/true | true/false/false |
| repo-053 | n8n-io/n8n@0e8fbb0 | D | analysed | true/true/true | true/false/true |
| repo-054 | hoppscotch/hoppscotch@ac145e7 | D | analysed | true/false/false | true/false/false |
| repo-055 | nocodb/nocodb@28c50ff | D | analysed | true/true/true | true/false/true |
| repo-056 | gristlabs/grist-core@a914d9f | D | analysed | false/true/false | true/false/true |
| repo-057 | gitroomhq/postiz-app@36d5fc7 | D | analysed | true/true/true | true/true/true |
| repo-058 | go-gitea/gitea@231ee19 | D | analysed | true/false/false | true/false/false |
| repo-059 | go-vikunja/vikunja@c82715c | D | analysed | true/false/true | true/false/true |
| repo-060 | wallabag/wallabag@7b8a6e0 | D | analysed | true/true/false | true/false/false |
| repo-061 | logto-io/logto@157dd49 | D | analysed | true/true/true | true/false/false |
| repo-062 | metabase/metabase@3fafdbd | D | analysed | true/false/false | true/false/false |
| repo-063 | keycloak/keycloak@0aa156e | D | analysed | true/false/false | true/false/false |
| repo-064 | casdoor/casdoor@92a601c | D | analysed | true/false/true | true/false/false |
| repo-065 | ory/kratos@b86338d | D | analysed | true/false/false | true/false/false |
| repo-066 | karakeep-app/karakeep@5a2f009 | D | analysed | false/true/true | false/false/true |
| repo-067 | formbricks/formbricks@8c3b9ec | D | analysed | true/true/true | true/true/true |
| repo-068 | baptisteArno/typebot.io@4bc37a4 | D | analysed | true/true/false | true/false/false |
| repo-069 | twentyhq/twenty@c10ba0c | D | analysed | true/true/true | true/true/true |
| repo-070 | LemmyNet/lemmy@439734d | D | analysed | true/false/false | true/false/false |
| repo-071 | chatwoot/chatwoot@da4898e | D | analysed | true/true/true | true/true/true |
| repo-072 | zulip/zulip@f7f941d | D | analysed | true/false/true | true/true/true |
| repo-073 | obsidiandynamics/kafdrop@ce2390e | D | analysed | false/false/false | false/false/false |
| repo-074 | dani-garcia/vaultwarden@a6c3bd6 | D | analysed | true/false/false | true/false/true |
| repo-075 | dgtlmoon/changedetection.io@0501721 | A | analysed | false/false/false | false/false/false |
| repo-076 | danny-avila/LibreChat@f9f1b2f | D | analysed | false/false/true | false/false/true |
| repo-077 | argoproj/argo-cd@2e2f4e4 | D | analysed | false/false/false | false/true/false |
| repo-078 | GoogleCloudPlatform/microservices-demo@b9a978d | D | analysed | true/false/false | false/true/false |
| repo-079 | Azure-Samples/azure-search-openai-demo@3f4a21f | C | analysed | false/false/false | false/false/true |
| repo-080 | vllm-project/vllm@560ef78 | D | analysed | false/false/false | false/false/false |
| repo-081 | hedgedoc/hedgedoc@6e90dd3 | D | analysed | true/false/false | true/false/true |
| repo-082 | mattermost/mattermost@240b9be | D | analysed | true/false/true | true/false/true |
| repo-083 | windmill-labs/windmill@0d6bce4 | D | analysed | true/false/false | true/false/false |
| repo-084 | NangoHQ/nango@f9667ac | D | analysed | true/true/true | true/true/true |
| repo-085 | teableio/teable@5ef2238 | D | analysed | true/true/true | true/true/true |
| repo-086 | wger-project/wger@65a1d40 | D | analysed | true/true/false | true/false/true |
| repo-087 | TandoorRecipes/recipes@e160cee | D | analysed | true/false/false | true/false/true |
| repo-088 | netbox-community/netbox@2d519ec | D | analysed | true/true/true | true/true/true |
| repo-089 | Stirling-Tools/Stirling-PDF@153da23 | D | analysed | true/false/true | false/false/false |
| repo-090 | sosedoff/pgweb@e4858a1 | D | analysed | true/false/false | true/false/false |
| repo-091 | nextcloud/server@132944d | D | analysed | false/false/false | true/false/true |
| repo-092 | Lissy93/dashy@1d78e14 | D | analysed | false/false/false | false/false/false |
| repo-093 | thelounge/thelounge@9727b2e | D | analysed | false/false/false | false/false/false |
| repo-094 | homarr-labs/homarr@cb0fec0 | D | analysed | false/false/false | true/false/false |
| repo-095 | openstatusHQ/openstatus@7828cf5 | D | analysed | true/false/true | false/false/false |
| repo-096 | mastodon/mastodon@6f341d4 | D | analysed | true/true/true | true/true/true |
| repo-097 | plausible/analytics@543b301 | D | analysed | true/false/true | true/false/false |
| repo-098 | wekan/wekan@0f41341 | D | analysed | false/false/true | false/false/true |
| repo-099 | BookStackApp/BookStack@13a1883 | D | analysed | false/false/true | false/false/true |
| repo-100 | penpot/penpot@034707a | D | analysed | false/true/false | true/true/true |
| repo-201 | DIYgod/RSSHub@3e11afc | A | analysed | false/true/false | false/false/false |
| repo-202 | element-hq/synapse@a0b5a45 | E | analysed | true/true/false | true/false/false |
| repo-203 | getfider/fider@f164f69 | A | analysed | true/false/false | true/false/false |
| repo-204 | shlinkio/shlink@d012afd | E | analysed | true/true/false | true/false/false |
| repo-205 | alfio-event/alf.io@6296c0c | A | analysed | true/false/false | true/false/false |
| repo-206 | nocobase/nocobase@4901246 | E | analysed | true/false/true | true/false/false |
| repo-207 | khoj-ai/khoj@ae229ca | A | analysed | true/false/false | true/false/false |
| repo-208 | baserow/baserow@c8f7827 | E | analysed | true/true/false | false/false/false |
| repo-209 | searxng/searxng@23e7e4d | A | analysed | false/true/false | false/false/false |
| repo-210 | FreshRSS/FreshRSS@e5f9906 | A | analysed | true/false/false | false/false/false |
| repo-211 | toeverything/AFFiNE@2365c36 | E | analysed | true/true/false | true/true/false |
| repo-212 | NodeBB/NodeBB@7457d23 | E | analysed | true/true/false | true/false/false |
| repo-213 | langfuse/langfuse@7637df1 | E | analysed | true/true/true | true/true/true |
| repo-214 | makeplane/plane@da1a7ab | A | analysed | false/true/false | true/true/true |
| repo-215 | pixelfed/pixelfed@25e1384 | E | analysed | false/true/true | false/true/false |
| repo-216 | RocketChat/Rocket.Chat@67f2bda | E | analysed | false/false/true | false/false/false |
| repo-217 | PostHog/posthog@c3c5a35 | E | analysed | true/true/true | true/true/false |
| repo-218 | gotify/server@14bfc25 | A | analysed | true/false/false | true/false/false |
| repo-219 | appwrite/appwrite@4ed3076 | A | analysed | false/true/false | true/true/false |
| repo-220 | headlamp-k8s/headlamp@69bfa23 | E | analysed | false/false/false | false/false/false |
