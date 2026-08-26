# Deployz MVP — Redis Support Implementation Specification

## 1. Objective

Add first-class Redis support to Deployz so that an application requiring Redis can be deployed to AWS without the user configuring Redis manually.

For the MVP, Deployz must:

1. Detect whether a repository requires Redis.
2. Determine whether the application is compatible with the supported Redis profile.
3. Represent Redis as a provider-neutral managed dependency.
4. Provision a private AWS ElastiCache Valkey instance.
5. Connect the deployed application securely to Redis.
6. Inject the environment variables expected by the application.
7. Reuse Redis across application redeployments.
8. Safely clean it up when the deployment/environment is deleted.
9. Verify that the application actually connects successfully.
10. Surface Redis status and useful failures in the existing deployment experience.

Do not build advanced Redis configuration or a standalone Redis-management product.

---

# 2. Implementation Principles

Follow these constraints throughout implementation.

### Keep the MVP simple

Prefer the smallest implementation that reliably handles common Redis-dependent open-source applications.
Do not over-engineer abstractions beyond what is required to support Redis and existing managed dependencies cleanly.

### Inspect existing implementation first

Before modifying code:

* inspect the existing repository-analysis pipeline;
* inspect the deployment plan/schema;
* inspect PostgreSQL/database provisioning;
* inspect AWS infrastructure abstractions;
* inspect environment-variable resolution;
* inspect deployment lifecycle/redeployment;
* inspect cleanup/deletion;
* inspect deployment-status UI;
* inspect deployment testing and health checks.

Reuse existing patterns wherever appropriate.
Do not create parallel infrastructure systems if an existing abstraction can be extended safely.

### Provider-neutral core

The core domain model must represent:

```text
Redis requirement
```

not:

```text
ElastiCache requirement
```

AWS-specific implementation belongs in the AWS deployment layer.

---

# 3. Supported MVP Redis Profile

Deployz MVP supports applications compatible with:

```text
Protocol: Redis-compatible
AWS implementation: ElastiCache
Engine: Valkey
Topology: standalone / non-cluster
Nodes: 1
Node class: cache.t4g.micro
Port: 6379
Network: private
Use cases:
- caching
- sessions
- queues
- background jobs
- rate limiting
- distributed locks
- temporary application state
```

The exact Valkey version may use the current sensible AWS-supported default unless the infrastructure implementation already pins engine versions.

---

# 4. Explicitly Unsupported

Do not implement:

* Redis Cluster requirements
* Redis Stack
* RedisJSON
* RediSearch
* custom Redis modules
* multiple Redis instances per environment
* Redis node-size selection
* replica configuration
* Multi-AZ configuration
* manual scaling
* Serverless ElastiCache
* MemoryDB
* Redis Cloud
* Upstash
* bring-your-own Redis
* existing Redis resource selection
* public Redis endpoints
* custom Redis ports
* Redis data browser
* Redis console
* Redis metrics dashboards
* backup UI
* persistence configuration
* ACL-management UI
* migration/import tooling
* cross-region Redis
* manual engine/version selection

If an application's requirements fall outside the supported profile, fail during planning rather than attempting an incompatible deployment.

---

# 5. High-Level Flow

```text
Repository
    ↓
Existing repository analysis
    ↓
Detect Redis signals
    ↓
Determine requirement + confidence
    ↓
Analyze Redis compatibility
    ↓
Generate provider-neutral deployment service
    ↓
AWS deployment adapter
    ↓
Provision/reuse ElastiCache Valkey
    ↓
Configure networking
    ↓
Resolve Redis endpoint
    ↓
Inject required environment variables
    ↓
Deploy application
    ↓
Verify infrastructure + runtime
    ↓
Deployment succeeds
```

---

# 6. Repository Analysis

Extend the existing repository-analysis pipeline.
Do not create a separate Redis analyzer unless required by the existing architecture.

## Signals

Inspect existing analysis outputs and relevant files such as:

```text
package.json
package-lock.json
pnpm-lock.yaml
yarn.lock
requirements.txt
pyproject.toml
poetry.lock
Gemfile
Gemfile.lock
go.mod
go.sum
composer.json
Dockerfile
docker-compose.yml
compose.yml
.env.example
.env.template
.env.sample
application configuration
deployment configuration
relevant source imports/usages
README/setup documentation when already analyzed
```

Detect common Redis-related dependencies, including but not limited to:

```text
redis
ioredis
bull
bullmq
@nestjs/bull
@nestjs/bullmq
redis-py
django-redis
rq
celery with Redis broker/backend
sidekiq
go-redis
```

Also recognize common connection variables:

```text
REDIS_URL
REDIS_URI
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD
CACHE_URL
QUEUE_REDIS_URL
CELERY_BROKER_URL
CELERY_RESULT_BACKEND
```

Do not provision Redis solely because a lockfile contains a transitive Redis client.

---

# 7. Detection Confidence

Use evidence rather than a simple boolean.

Suggested signals:

| Signal                                     | Confidence  |
| ------------------------------------------ | ----------- |
| Redis service in Docker Compose            | Very high   |
| Application code initializes Redis         | Very high   |
| Required Redis env var                     | High        |
| BullMQ/Sidekiq/RQ/etc. directly configured | High        |
| Direct Redis dependency                    | Medium-high |
| README says Redis required                 | Medium      |
| Only indirect/transitive dependency        | Low         |

The implementation does not need a sophisticated ML scoring system.
A deterministic rules-based confidence calculation is acceptable.

Normalize the result into approximately:

```text
high
medium
low
```

Expected behavior:

```text
High    → include Redis in deployment plan automatically
Medium  → include Redis if combined evidence indicates runtime dependency
Low     → do not provision Redis
```

Avoid unnecessary user prompts.

---

# 8. Analysis Output

Extend the existing analysis result without coupling it to AWS.

Conceptual shape:

```json
{
  "services": {
    "redis": {
      "required": true,
      "confidence": "high",
      "purpose": ["queue"],
      "evidence": [
        "bullmq dependency",
        "REDIS_URL referenced by worker"
      ],
      "connectionEnvVars": [
        "REDIS_URL"
      ],
      "compatibility": {
        "supported": true,
        "profile": "standard"
      }
    }
  }
}
```

Adapt this to the existing schemas and naming conventions.
Do not blindly introduce the exact structure above if the project already has an appropriate service/dependency representation.

---

# 9. Purpose Detection

Where reasonably possible, identify why Redis is needed.

Possible normalized purposes:

```text
cache
queue
background_jobs
sessions
rate_limiting
locks
broker
unknown
```

Examples:

```text
BullMQ → queue
Sidekiq → background_jobs
Celery Redis broker → broker
django-redis → cache
session store → sessions
```

Purpose is useful metadata but must not block deployment if it cannot be determined reliably.

---

# 10. Compatibility Analysis

Before provisioning AWS infrastructure, determine whether the application's Redis requirements fit the Deployz MVP profile.

Check for evidence of:

```text
standalone Redis
cluster mode
TLS requirement
redis://
rediss://
username/password assumptions
Redis Stack
RedisJSON
RediSearch
custom module dependencies
specific unsupported topology
```

Normalize into:

```text
supported
unsupported
unknown
```

## Supported

Proceed automatically when the application appears compatible with standard standalone Redis.

## Unsupported

Fail before infrastructure creation with a useful explanation.

Example:

```text
Redis requirement unsupported
This application requires RedisJSON, which is not supported by the current Deployz Redis runtime.
```

## Unknown

For the MVP, prefer standard Redis compatibility if there is no evidence requiring unsupported features.
Runtime validation will catch incompatibility.

Do not create unnecessary blocking questions for the user.

---

# 11. Managed-Service Domain Model

If Deployz already has a managed dependency/service abstraction, extend it.
Otherwise introduce the smallest reusable abstraction required.

Conceptually:

```ts
type ManagedServiceType =
  | "postgres"
  | "redis";

interface ManagedService {
  type: ManagedServiceType;
  required: boolean;
  purpose?: string[];
  status?: ManagedServiceStatus;
  provider?: "aws";
  implementation?: string;
  engine?: string;
  resourceId?: string;
  endpoint?: string;
}
```

Exact implementation must match the current architecture.

Important separation:

```text
Core:
type = redis

AWS adapter:
implementation = elasticache
engine = valkey
```

Avoid putting `elasticache` throughout business logic.

---

# 12. Deployment Plan

When Redis is required, include it in the existing deployment plan.

Example:

```text
Infrastructure
✓ Application
✓ PostgreSQL
✓ Redis
```

Optional supporting text:

```text
Redis
Required by BullMQ
Managed automatically
```

Do not require configuration from the user.

Do not expose:

```text
node size
engine
version
replicas
cluster mode
port
parameter groups
subnet groups
```

Redis should behave as an automatically understood dependency.

---

# 13. AWS Implementation

Implement Redis using:

```text
AWS ElastiCache
Engine: Valkey
Node based
Single node
cache.t4g.micro
Cluster mode disabled
Private networking
Default Redis-compatible port
```

Use the project's existing AWS infrastructure approach:

```text
CloudFormation
CDK
Terraform
AWS SDK
SST
or existing internal infrastructure abstraction
```

Do not introduce an additional infrastructure framework just for Redis.

---

# 14. Naming

Follow existing Deployz AWS resource naming conventions.
Names should be deterministic enough to support reconciliation.

Conceptually:

```text
deployz-{applicationId}-{environment}-redis
```

Respect AWS length and character limits.
Do not rely solely on mutable display names.

---

# 15. Resource Tagging

Every resource created by Deployz for Redis must be tagged consistently with other Deployz-managed AWS resources.

At minimum include equivalents of:

```text
ManagedBy=Deployz
DeployzApplicationId=<id>
DeployzDeploymentId=<id or infrastructure-id>
DeployzEnvironment=<environment>
```

If existing tags already cover ownership, reuse them.
Ownership tags must be usable during cleanup to prevent accidental deletion of customer-created resources.

---

# 16. Networking

Redis must never be publicly accessible.

Architecture:

```text
Application workload
       │
       │ Redis TCP
       ▼
Redis security group
       │
       ▼
ElastiCache Valkey
```

Use security-group references rather than broad CIDR access where the existing architecture allows it.
Redis must be reachable only from application workloads that require it.

Reuse the existing deployment:

* VPC
* private subnets
* application security group
* networking abstraction

when possible.

Do not create a new VPC only for Redis if the application already has appropriate networking.

---

# 17. Cache Subnet Group

Create/reuse an ElastiCache subnet group containing appropriate private subnets.
Make creation idempotent.

If the project already has a reusable subnet-group abstraction for managed resources, use it.
Do not create duplicate subnet groups on every redeployment.

---

# 18. Security Group

Create a Deployz-managed Redis security group.
Allow inbound Redis traffic only from the application workload security group.

Conceptually:

```text
source: application security group
destination: redis security group
protocol: TCP
port: 6379
```

Do not allow:

```text
0.0.0.0/0
```

Do not make the cache public.

---

# 19. Connection Information

Once the cache is available, retrieve its endpoint.

Generate appropriate application configuration.

Typical form:

```text
redis://<endpoint>:6379
```

Do not hard-code only `REDIS_URL`.
Use the repository-analysis output to map the connection information into the application's expected variables.

---

# 20. Environment Variable Mapping

Examples:

### URL-based application

Repository expects:

```text
REDIS_URL
```

Inject:

```text
REDIS_URL=redis://<endpoint>:6379
```

### Host/port application

Repository expects:

```text
REDIS_HOST
REDIS_PORT
```

Inject:

```text
REDIS_HOST=<endpoint>
REDIS_PORT=6379
```

### Celery

If analysis determines:

```text
CELERY_BROKER_URL
```

inject the generated Redis URL there.

If:

```text
CELERY_RESULT_BACKEND
```

also requires Redis and the repository expects it, map it appropriately.

Do not overwrite explicit customer environment variables unless the existing Deployz environment-variable precedence rules say Deployz-managed infrastructure values should win.

Reuse existing env-resolution precedence.

---

# 21. Secrets

For this initial configuration, avoid creating unnecessary Redis passwords/credentials unless required by the existing AWS security architecture.

Redis must already be protected through private networking and security-group controls.

If the implementation uses authentication or TLS, secrets must be handled through the existing secrets-management system and must never be persisted in logs.

Never expose secrets in:

```text
deployment logs
database records
client responses
error telemetry
```

unless appropriately redacted.

---

# 22. Lifecycle Model

Redis is infrastructure belonging to an application environment, not to an individual build.

Correct:

```text
Application / production
 ├─ Redis
 ├─ PostgreSQL
 └─ deployments
      ├─ build 1
      ├─ build 2
      └─ build 3
```

Incorrect:

```text
build 1 → Redis #1
build 2 → Redis #2
build 3 → Redis #3
```

Redis must persist across normal redeployments.

---

# 23. Idempotent Provisioning

Implement Redis provisioning as reconciliation/ensure behavior.

Conceptually:

```text
ensureRedis()
```

not:

```text
createRedisEveryTime()
```

Expected flow:

```text
Redis required?
      ↓
Lookup recorded resource
      ↓
Resource exists in AWS?
   ↙           ↘
 yes           no
 ↓              ↓
validate       provision
 ↓              ↓
reuse          record
```

Repeated deployment attempts must not create duplicate caches.

---

# 24. Drift Handling

Handle basic discrepancies between Deployz state and AWS state.

Cases:

### Deployz record + AWS resource exists

Validate ownership and reuse.

### Deployz record exists + AWS resource missing

Mark resource stale and recreate where safe, or fail with a clear recoverable infrastructure error.

### AWS resource exists + state record missing

Only adopt/reconcile if ownership can be established safely through deterministic naming/tags.
Never adopt unrelated customer resources.

### Partial creation

Retry safely without creating duplicates.

Do not build a full drift-management engine for MVP.

---

# 25. Provisioning States

Integrate with existing infrastructure/deployment statuses.

Redis-specific states may conceptually include:

```text
pending
creating
available
failed
deleting
deleted
```

Avoid inventing new states if existing generic infrastructure states are sufficient.

---

# 26. Deployment Timeline

Show Redis actions through the existing deployment progress/log experience.

Example:

```text
✓ Repository analyzed
✓ Redis requirement detected
✓ Redis compatibility validated
✓ Redis networking configured
✓ Redis provisioned
✓ Redis connection configured
✓ Application deployed
✓ Runtime validation passed
```

Avoid exposing noisy AWS implementation details unless useful for debugging.

---

# 27. Error Handling

Convert common AWS failures into actionable Deployz errors.

Examples:

```text
Missing AWS permission
Insufficient VPC subnets
ElastiCache quota reached
Node type unavailable in region
Subnet group creation failed
Security-group creation failed
Cache creation failed
Application cannot connect to Redis
```

Preserve the underlying AWS error internally for diagnostics.
Show users the meaningful cause and suggested action.

---

# 28. AWS Permissions

Inspect the current Deployz customer AWS role/policy and add only the permissions required.

Likely categories include:

```text
elasticache:Create*
elasticache:Describe*
elasticache:Modify*
elasticache:Delete*
elasticache:AddTagsToResource
elasticache:ListTagsForResource
```

plus required EC2/VPC/security-group/subnet operations if not already available.

Prefer explicit permissions over:

```text
elasticache:*
```

unless the existing MVP permission strategy intentionally uses broader scoped permissions.

Ensure permission validation/preflight checks include Redis when relevant.

---

# 29. Runtime Validation

Do not consider Redis successfully integrated simply because AWS reports the cache as available.

Validate at three levels.

## Level 1 — Infrastructure

Verify:

```text
ElastiCache resource exists
status = available
endpoint resolved
```

## Level 2 — Network/application start

Verify that the workload starts after receiving Redis configuration.
Look for connection failures.

## Level 3 — Application runtime

Reuse existing health-check/log-analysis infrastructure.

Detect common Redis errors such as:

```text
ECONNREFUSED
ETIMEDOUT
ENOTFOUND
NOAUTH
WRONGPASS
MOVED
CLUSTERDOWN
TLS errors
Redis connection failed
unable to connect to Redis
connection closed
```

Only mark the deployment successful if the application's overall validation passes.

Do not attempt to build framework-specific Redis probes unless necessary.

---

# 30. Failure Classification

Classify Redis failures into categories where the existing error system supports it.

Suggested categories:

```text
redis_detection
redis_unsupported
redis_provisioning
redis_networking
redis_configuration
redis_runtime
```

This will help debugging and future deployment-learning functionality.

---

# 31. Deployment UI

Keep the user experience minimal.

## Before deployment

If Redis is confidently required:

```text
Redis
Required by BullMQ
Will be configured automatically
```

Do not make the user configure it.

An enable/disable toggle is not necessary for MVP unless the existing UI consistently allows infrastructure overrides.

## During deployment

Show Redis as part of infrastructure progress.

## After deployment

Example:

```text
Redis                 Running
AWS ElastiCache
Valkey
Private
Region: us-east-1
```

Useful action:

```text
View in AWS
```

Optionally show/copy endpoint if consistent with existing managed-service UI.

Do not expose Redis tuning settings.

---

# 32. Cost Display

If Deployz already estimates AWS infrastructure costs, add Redis to that system.
Otherwise cost estimation is optional and must not block the MVP.

If implemented, use a simple approximate lookup:

```text
region + cache.t4g.micro
```

Show an estimate rather than implying exact billing:

```text
Estimated AWS cost: ~$X/month
```

Do not build a real-time AWS pricing engine solely for Redis.

---

# 33. Deletion

When an application environment is deleted and Redis is Deployz-owned:

```text
stop/remove dependent workload
        ↓
delete Redis resource
        ↓
wait/confirm deletion where necessary
        ↓
delete Redis-specific networking resources if unused
        ↓
delete subnet group if Deployz-owned and unused
        ↓
remove state
```

Before deletion verify ownership using:

```text
Deployz state
AWS tags
application/environment identity
```

Never delete arbitrary Redis resources discovered in the customer's AWS account.

---

# 34. Redeployments

Normal application redeployment must:

```text
Reuse existing Redis
Reuse endpoint
Reinject configuration
Do not recreate cache
```

A failed build/redeployment must not delete Redis.

---

# 35. Environment Isolation

If environments already exist, Redis belongs to the environment.

Example:

```text
production → redis-production
staging    → redis-staging
```

Do not share Redis automatically across separate environments.

If Deployz MVP currently supports only one environment, structure ownership so environment isolation can be introduced later without rewriting the Redis model.

---

# 36. Deployment-Learning Integration

Do not make this a prerequisite for Redis launch.

After core support is stable, record generalized successful Redis deployment signals using the existing deployment-learning system.

Potential data:

```text
technology: bullmq
dependency: redis
connection_env: REDIS_URL
profile: standard
provider: aws
implementation: elasticache
engine: valkey
outcome: successful
```

Do not store:

```text
Redis contents
credentials
customer secrets
raw sensitive application data
```

Use learning to improve future detection/confidence, not to bypass deterministic compatibility checks.

---

# 37. Telemetry

Reuse existing Deployz telemetry.
Track enough to measure MVP effectiveness.

Suggested events/fields:

```text
redis_detected
redis_required
redis_compatibility_supported
redis_compatibility_rejected
redis_provision_started
redis_provision_succeeded
redis_provision_failed
redis_runtime_validation_failed
redis_deployment_succeeded
```

Useful dimensions:

```text
language/framework
detected purpose
confidence
AWS region
failure category
```

Do not send Redis URLs containing sensitive credentials.

---

# 38. Testing Strategy

Implement automated unit, integration and end-to-end coverage consistent with the existing codebase.

## Detection tests

Test repositories/configurations containing:

```text
BullMQ
ioredis
redis npm package
Celery + Redis broker
django-redis
Sidekiq
RQ
go-redis
Docker Compose redis
REDIS_URL
REDIS_HOST / REDIS_PORT
```

Also test false positives:

```text
transitive dependency only
Redis mentioned only in docs as an optional feature
unused package
test/dev-only Redis dependency
```

---

# 39. Compatibility Tests

Test:

```text
standard redis:// → supported
standalone Redis → supported
Redis Cluster required → unsupported
RedisJSON → unsupported
RediSearch → unsupported
Redis Stack → unsupported
custom modules → unsupported
```

---

# 40. Infrastructure Tests

Verify:

```text
cache is created once
cache is reused on redeploy
private networking is applied
security group restricts access
subnet group is valid
endpoint is persisted correctly
tags are added
partial retries are idempotent
cleanup works
```

---

# 41. Environment Mapping Tests

Verify at least:

```text
REDIS_URL
REDIS_HOST + REDIS_PORT
CELERY_BROKER_URL
```

when analysis detects those patterns.

Do not add arbitrary mappings without actual repository evidence.

---

# 42. End-to-End Production-Like Tests

Test real representative open-source repositories.

Minimum useful categories:

```text
1. Node.js application using BullMQ
2. Node.js application using ioredis directly
3. Python/Celery application
4. Django application using django-redis
5. Ruby application using Sidekiq, if current Deployz runtimes support Ruby
```

Use only runtimes already supported by Deployz.

For each test:

```text
connect repository
analyze repository
confirm Redis detection
generate deployment plan
deploy to AWS test account
verify Redis exists
verify networking
verify env injection
verify app startup
exercise application where feasible
inspect logs
redeploy
verify same Redis resource reused
delete environment
verify Redis cleanup
```

---

# 43. Acceptance Criteria

Redis MVP is complete when all of the following are true.

* [ ] Redis-dependent repositories can be detected reliably.
* [ ] Detection uses multiple signals and avoids obvious transitive-dependency false positives.
* [ ] Redis requirements are represented provider-neutrally.
* [ ] Unsupported Redis features are detected before infrastructure provisioning where possible.
* [ ] Compatible applications automatically receive AWS ElastiCache Valkey.
* [ ] Redis is private and accessible only from the deployed application.
* [ ] Required connection environment variables are injected automatically.
* [ ] Redis survives normal application redeployments.
* [ ] Repeated/retried deployment does not create duplicate caches.
* [ ] Basic state/AWS drift is handled safely.
* [ ] Application runtime validation catches Redis connectivity failures.
* [ ] Redis provisioning failures surface actionable errors.
* [ ] Redis resources are tagged as Deployz-managed.
* [ ] Deleting the owning environment safely removes Deployz-created Redis resources.
* [ ] Unrelated customer Redis resources are never modified or deleted.
* [ ] Deployment UI surfaces Redis without requiring Redis expertise from the user.
* [ ] Representative real-world Redis repositories pass E2E deployment tests.
* [ ] Existing non-Redis deployments continue to work unchanged.

---

# 44. Implementation Order

Implement in this order unless the existing architecture strongly suggests a better sequence:

```text
1. Inspect existing managed-service/database architecture
2. Extend provider-neutral service model
3. Add Redis repository detection
4. Add Redis compatibility validation
5. Add Redis to deployment planning
6. Implement AWS ElastiCache Valkey provisioning
7. Add private networking/security groups
8. Add endpoint/env-variable resolution
9. Implement persistence/reuse/reconciliation
10. Implement cleanup
11. Add runtime validation
12. Integrate deployment UI/status/errors
13. Add unit/integration tests
14. Run real repository E2E deployments
15. Fix findings
16. Add deployment-learning integration where appropriate
```

---

# 45. Coding-Agent Execution Instructions

Before coding:

1. Inspect the current architecture completely enough to understand how PostgreSQL/managed infrastructure is already implemented.
2. Identify the minimum changes required.
3. Reuse existing patterns.
4. Do not refactor unrelated working code.
5. Do not introduce a new infrastructure framework.
6. Do not build anything listed under unsupported scope.

During implementation:

```text
Analyze → implement → test → deploy → observe → fix
```

Do not stop after unit tests.
Validate the feature against an actual AWS deployment using the project's existing test/deployment account and workflows where available.

If implementation details conflict with this specification because the existing architecture has a clearly superior compatible pattern, follow the existing architecture while preserving the product behavior and acceptance criteria.

Do not require founder/user input for ordinary implementation choices. Make reasonable MVP decisions from the existing codebase and conventions.

---

# 46. Final Deliverable

At completion, provide a concise implementation report containing:

```text
Architecture used
Files/components changed
Redis detection behavior
Supported/unsupported compatibility
AWS resources created
Security/networking model
Environment-variable mapping
Redeployment/reconciliation behavior
Deletion behavior
Runtime validation
Tests added
Real repositories tested
Issues found and fixed
Known limitations
Any AWS IAM changes required
```

The final implementation should make the user experience effectively:

```text
Connect repository
      ↓
Deployz detects Redis
      ↓
Deployz shows Redis as required infrastructure
      ↓
User clicks Deploy
      ↓
Deployz provisions and connects Redis automatically
      ↓
Application works
```

Redis should feel like a dependency that Deployz understood and handled automatically, not another AWS service the customer needs to configure.
