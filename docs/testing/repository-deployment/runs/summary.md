# Repository deployment audit — run summary

Deployz commit: `62bb2d7522b2182729758504fcd294df784379d3`

| Metric | Value |
| --- | --- |
| Repositories | 120 |
| Expected deployable | 65 |
| Expected unsupported | 55 |
| Gate: correct accept / correct reject | 38 / 49 |
| Gate: false acceptance / false rejection | 6 / 18 |
| Gate: READY with the Stage B configuration | 14 |
| Build attempted / succeeded / failed | 9 / 8 / 1 |
| Build success among expected deployable | 12.3% |
| Infrastructure attempted / succeeded / failed | 8 / 5 / 3 |
| Runtime: ECS running / ALB healthy / HTTPS reachable / application response valid | 5 / 5 / 5 / 3 |
| Dependencies: PostgreSQL / Redis / storage / migration verified | 3 / 1 / 0 / 1 |
| **True deployment success / expected deployable** | **3 / 65 (4.6%)** |
| Cleanup: destroys / failures / leaks / success rate | 9 / 0 / 0 / 100% |

## By classification

| Classification | Repositories |
| --- | --- |
| APPLICATION_ERROR | 1 |
| BUILD_ERROR | 1 |
| CONTAINER_START_ERROR | 1 |
| DATABASE_ERROR | 1 |
| ENV_BINDING_ERROR | 2 |
| EXPECTED_UNSUPPORTED | 49 |
| GATE_ERROR | 24 |
| PASS | 41 |

## By root cause

| Root cause | Repositories |
| --- | --- |
| ANALYSIS_MISSING_SIGNAL | 2 |
| CORRECTLY_UNSUPPORTED | 49 |
| DEPLOYZ_BUG | 1 |

## By finding

| Finding | Repositories |
| --- | --- |
| DEPLOY-002 | 6: repo-001, repo-002, repo-008, repo-051, repo-090, repo-092 |
| DEPLOY-003 | 18: repo-005, repo-022, repo-023, repo-024, repo-041, repo-043, repo-053, repo-055, repo-060, repo-082, repo-083, repo-087, repo-094, repo-204, repo-206, repo-207, repo-211, repo-220 |
| DEPLOY-004 | 6: repo-072, repo-074, repo-084, repo-088, repo-089, repo-097 |
| DEPLOY-005 | 2: repo-021, repo-039 |
| DEPLOY-007 | 1: repo-003 |
| DEPLOY-008 | 1: repo-004 |
| DEPLOY-014 | 1: repo-007 |
| DEPLOY-015 | 1: repo-039 |

## By set

| Set | Repositories | Expected deployable | Expected unsupported | Gate correct | Deployed | True success |
| --- | --- | --- | --- | --- | --- | --- |
| improvement | 80 | 46 | 34 | 60 | 5 | 3 |
| unseen | 20 | 9 | 11 | 12 | 0 | 0 |
| unseen2 | 20 | 10 | 10 | 15 | 0 | 0 |

## By cohort

| Cohort | Repositories | Expected deployable | Expected unsupported | Gate correct | Deployed | True success |
| --- | --- | --- | --- | --- | --- | --- |
| boundary | 24 | 2 | 22 | 20 | 0 | 0 |
| messy | 27 | 18 | 9 | 22 | 0 | 0 |
| realistic | 69 | 45 | 24 | 45 | 5 | 3 |

## Repositories

| Id | Repository | Cohort | Expected | Gate | Build | Deploy | Runtime | Cleanup | Result | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| repo-001 | umami-software/umami@ca661c7 | realistic | READY | — (—) | PASS | FAIL | — | PASS | CONTAINER_START_ERROR | DEPLOY-002 |
| repo-002 | Unleash/unleash@0429c29 | realistic | READY | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS | DEPLOY-002 |
| repo-003 | thedevs-network/kutt@279b491 | realistic | NEEDS_CONFIGURATION | — (—) | PASS | FAIL | — | PASS | DATABASE_ERROR / DEPLOYZ_BUG | DEPLOY-007 |
| repo-004 | miniflux/v2@a84533d | realistic | NEEDS_CONFIGURATION | — (—) | FAIL | NOT_ATTEMPTED | — | PASS | BUILD_ERROR | DEPLOY-008 |
| repo-005 | Flagsmith/flagsmith@4a8a84a | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-006 | documenso/documenso@3ec877a | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-007 | ghostfolio/ghostfolio@73e4f03 | realistic | NEEDS_CONFIGURATION | — (—) | PASS | PASS | HEALTHY/HEALTHY/https PASS | PASS | PASS | DEPLOY-014 |
| repo-008 | TwiN/gatus@4d15cb7 | realistic | READY | — (—) | PASS | PASS | HEALTHY/HEALTHY/https PASS | PASS | PASS | DEPLOY-002 |
| repo-009 | heroku/node-js-getting-started@63c6674 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-010 | knadh/listmonk@670c017 | messy | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-011 | healthchecks/healthchecks@69dbd2a | messy | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-012 | diced/zipline@a2ac5f2 | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-013 | louislam/uptime-kuma@5df2a3c | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-014 | automatisch/automatisch@41f3c56 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-015 | immich-app/immich@6d85f20 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-016 | outline/outline@0121886 | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-017 | lukevella/rallly@d374ed4 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-018 | docmost/docmost@5b85464 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-019 | linkwarden/linkwarden@789aa2b | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-020 | papermark/papermark@ed19717 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-021 | directus/directus@ea25ba6 | realistic | NEEDS_CONFIGURATION | — (—) | PASS | FAIL | — | PASS | ENV_BINDING_ERROR / ANALYSIS_MISSING_SIGNAL | DEPLOY-005 |
| repo-022 | ToolJet/ToolJet@e216f7c | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-023 | requarks/wiki@8a97969 | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-024 | calcom/cal.diy@e70486c | realistic | READY | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-025 | lobehub/lobehub@5590527 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-026 | amruthpillai/reactive-resume@0a092ee | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-027 | plankanban/planka@de4d768 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-028 | Infisical/infisical@496d992 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-029 | postalsys/emailengine@1933e5d | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-030 | verdaccio/verdaccio@8b2b136 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-031 | gethomepage/homepage@ddc5adc | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-032 | mealie-recipes/mealie@8faccff | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-033 | paperless-ngx/paperless-ngx@a28a6fe | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-034 | CTFd/CTFd@91ced62 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-035 | spiral-project/ihatemoney@e66a767 | realistic | NEEDS_CONFIGURATION | — (—) | PASS | PASS | HEALTHY/HEALTHY/https PASS | PASS | PASS |  |
| repo-036 | django-helpdesk/django-helpdesk@1cc6776 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-037 | apache/superset@765a4ec | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-038 | apache/answer@3b9f137 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-039 | usememos/memos@dfa0fda | realistic | NEEDS_CONFIGURATION | — (—) | PASS | PASS | HEALTHY/HEALTHY/https PASS | PASS | ENV_BINDING_ERROR / ANALYSIS_MISSING_SIGNAL | DEPLOY-005, DEPLOY-015 |
| repo-040 | authelia/authelia@fd4b742 | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-041 | coder/coder@07f9018 | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-042 | grafana/grafana@0ecd582 | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-043 | huginn/huginn@fc1f557 | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-044 | firefly-iii/firefly-iii@9e9d6f4 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-045 | monicahq/monica@e08e917 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-046 | kanboard/kanboard@9ce6a5e | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-047 | halo-dev/halo@4e7e585 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-048 | tolgee/tolgee-platform@241ce68 | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-049 | OrchardCMS/OrchardCore@2ae5053 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-050 | livebook-dev/livebook@f18f203 | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-051 | docusealco/docuseal@c216e43 | realistic | READY | — (—) | PASS | PASS | HEALTHY/HEALTHY/https PASS | PASS | APPLICATION_ERROR | DEPLOY-002 |
| repo-052 | laurent22/joplin@21a7dd4 | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-053 | n8n-io/n8n@0e8fbb0 | messy | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-054 | hoppscotch/hoppscotch@ac145e7 | messy | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-055 | nocodb/nocodb@28c50ff | messy | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-056 | gristlabs/grist-core@a914d9f | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-057 | gitroomhq/postiz-app@36d5fc7 | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-058 | go-gitea/gitea@231ee19 | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-059 | go-vikunja/vikunja@c82715c | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-060 | wallabag/wallabag@7b8a6e0 | messy | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-061 | logto-io/logto@157dd49 | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-062 | metabase/metabase@3fafdbd | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-063 | keycloak/keycloak@0aa156e | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-064 | casdoor/casdoor@92a601c | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-065 | ory/kratos@b86338d | messy | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-066 | karakeep-app/karakeep@5a2f009 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-067 | formbricks/formbricks@8c3b9ec | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-068 | baptisteArno/typebot.io@4bc37a4 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-069 | twentyhq/twenty@c10ba0c | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-070 | LemmyNet/lemmy@439734d | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-071 | chatwoot/chatwoot@da4898e | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-072 | zulip/zulip@f7f941d | boundary | NOT_COMPATIBLE | NEEDS_CONFIGURATION (false-acceptance) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-004 |
| repo-073 | obsidiandynamics/kafdrop@ce2390e | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-074 | dani-garcia/vaultwarden@a6c3bd6 | boundary | NOT_COMPATIBLE | NEEDS_CONFIGURATION (false-acceptance) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-004 |
| repo-075 | dgtlmoon/changedetection.io@0501721 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-076 | danny-avila/LibreChat@f9f1b2f | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-077 | argoproj/argo-cd@2e2f4e4 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-078 | GoogleCloudPlatform/microservices-demo@b9a978d | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-079 | Azure-Samples/azure-search-openai-demo@3f4a21f | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-080 | vllm-project/vllm@560ef78 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-081 | hedgedoc/hedgedoc@6e90dd3 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-082 | mattermost/mattermost@240b9be | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-083 | windmill-labs/windmill@0d6bce4 | realistic | READY | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-084 | NangoHQ/nango@f9667ac | realistic | NOT_COMPATIBLE | NEEDS_CONFIGURATION (false-acceptance) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-004 |
| repo-085 | teableio/teable@5ef2238 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-086 | wger-project/wger@65a1d40 | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-087 | TandoorRecipes/recipes@e160cee | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-088 | netbox-community/netbox@2d519ec | realistic | NOT_COMPATIBLE | NEEDS_CONFIGURATION (false-acceptance) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-004 |
| repo-089 | Stirling-Tools/Stirling-PDF@153da23 | realistic | NOT_COMPATIBLE | NEEDS_CONFIGURATION (false-acceptance) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-004 |
| repo-090 | sosedoff/pgweb@e4858a1 | realistic | READY | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS | DEPLOY-002 |
| repo-091 | nextcloud/server@132944d | messy | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-092 | Lissy93/dashy@1d78e14 | messy | READY | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS | DEPLOY-002 |
| repo-093 | thelounge/thelounge@9727b2e | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-094 | homarr-labs/homarr@cb0fec0 | messy | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-095 | openstatusHQ/openstatus@7828cf5 | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-096 | mastodon/mastodon@6f341d4 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-097 | plausible/analytics@543b301 | boundary | NOT_COMPATIBLE | NEEDS_CONFIGURATION (false-acceptance) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-004 |
| repo-098 | wekan/wekan@0f41341 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-099 | BookStackApp/BookStack@13a1883 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-100 | penpot/penpot@034707a | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-201 | DIYgod/RSSHub@3e11afc | realistic | READY | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-202 | element-hq/synapse@a0b5a45 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-203 | getfider/fider@f164f69 | realistic | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-204 | shlinkio/shlink@d012afd | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-205 | alfio-event/alf.io@6296c0c | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-206 | nocobase/nocobase@4901246 | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-207 | khoj-ai/khoj@ae229ca | realistic | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-208 | baserow/baserow@c8f7827 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-209 | searxng/searxng@23e7e4d | realistic | NEEDS_CONFIGURATION | NEEDS_CONFIGURATION (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-210 | FreshRSS/FreshRSS@e5f9906 | realistic | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-211 | toeverything/AFFiNE@2365c36 | messy | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
| repo-212 | NodeBB/NodeBB@7457d23 | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-213 | langfuse/langfuse@7637df1 | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-214 | makeplane/plane@da1a7ab | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-215 | pixelfed/pixelfed@25e1384 | messy | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-216 | RocketChat/Rocket.Chat@67f2bda | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-217 | PostHog/posthog@c3c5a35 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-218 | gotify/server@14bfc25 | boundary | NEEDS_CONFIGURATION | READY (correct-accept) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | PASS |  |
| repo-219 | appwrite/appwrite@4ed3076 | boundary | NOT_COMPATIBLE | NOT_COMPATIBLE (correct-reject) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | EXPECTED_UNSUPPORTED / CORRECTLY_UNSUPPORTED |  |
| repo-220 | headlamp-k8s/headlamp@69bfa23 | boundary | NEEDS_CONFIGURATION | NOT_COMPATIBLE (false-rejection) | NOT_ATTEMPTED | NOT_ATTEMPTED | — | NOT_ATTEMPTED | GATE_ERROR | DEPLOY-003 |
