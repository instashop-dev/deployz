# Deployz — Project Brief

## 1. Product Summary

**Working name:** Deployz

**One-line description**

Deployz lets small B2B software companies deploy and continuously operate their application inside each customer's AWS account without building their own DevOps, BYOC, or private-deployment platform.

**Core promise**

> Connect your application once. Give each customer a "Deploy to Your AWS" link. Deployz provisions, updates, monitors, diagnoses, and manages every customer deployment.

Deployz turns:

> "Can your software run inside our AWS account?"

from a custom engineering project into a standard product feature.

---

# 2. Product Thesis

Small B2B SaaS vendors increasingly encounter customers that want software running inside the customer's own AWS account.

Supporting this traditionally requires the vendor to build and maintain:

- Infrastructure templates
- IAM permissions
- Networking
- Databases
- Container infrastructure
- Customer installation flows
- Release management
- Upgrade workflows
- Rollbacks
- Health monitoring
- Troubleshooting
- Multi-customer deployment tracking
- Documentation
- Security explanations

For a small SaaS company, supporting a handful of private deployments can become disproportionately expensive.

Deployz provides this entire deployment layer as a service.

The product should **not** attempt to support every AWS architecture.

Instead:

> **Deployz supports one highly opinionated deployment architecture exceptionally well.**

Applications that fit this architecture get essentially zero-DevOps private deployment.

Applications that do not fit are rejected rather than handled through consulting or custom engineering.

This constraint is fundamental to the product and its pricing.

---

# 3. Strategic Positioning

Deployz is **not**:

- A Terraform generator
- A generic AWS deployment tool
- A Kubernetes platform
- An internal developer platform
- A cloud management console
- A DevOps consulting service
- A replacement for AWS
- A generic self-hosting platform
- A Replicated/Nuon clone
- A generic AI coding agent

Deployz is:

> **A software distribution platform for small SaaS vendors that need to run their product inside customer-owned AWS accounts.**

The important distinction is recurring lifecycle management.

An AI coding agent can generate Terraform once.

Deployz continuously manages:

```text
Vendor
  ×
Application
  ×
Version
  ×
Customer
  ×
AWS deployment
```

This relationship is the product.

---

# 4. Target Customer

## Primary ICP

Small software companies with approximately **5–20 employees** that have customers asking for AWS-owned deployments.

Initial vertical priorities:

1. AI SaaS applications
2. Data and analytics SaaS
3. Commercial open-source software
4. B2B SaaS moving upmarket
5. Internal-tool products

The ideal customer already has a working SaaS application and does **not** want to create an internal DevOps/private-cloud team.

### Ideal application

A strong Deployz application looks approximately like:

```text
Web/API container
      │
      ├── PostgreSQL
      │
      ├── S3
      │
      ├── Optional Redis cache
      │
      └── Optional background worker
```

Examples:

- AI workflow application
- Document-processing SaaS
- Analytics application
- Reporting platform
- CRM add-on
- Security dashboard
- Data-processing application
- Workflow automation application
- Commercial open-source web application

---

# 5. End Customer

The vendor's customer is typically an organisation saying:

> "We like your product, but it needs to run in our AWS account."

Their primary concerns may include:

- Data control
- Data residency
- Security
- Procurement
- Internal policies
- Network proximity
- Cloud ownership
- AWS billing ownership
- Infrastructure visibility
- Operational control

Deployz should make the installation understandable to this customer without requiring them to trust Deployz with permanent AWS credentials.

---

# 6. Product Experience

The ideal vendor experience should feel approximately this simple:

```text
Connect GitHub
      ↓
Deployz understands application
      ↓
Private Deployment Ready
      ↓
Create Customer
      ↓
Send "Deploy to AWS" link
      ↓
Customer approves installation in AWS
      ↓
Deployz provisions application
      ↓
Healthy
      ↓
Vendor releases version 1.2
      ↓
Deployz updates selected customers
      ↓
Healthy
```

The vendor should almost never have to think about:

- VPCs
- Subnets
- Security groups
- IAM roles
- ECS services
- Load balancers
- RDS parameter groups
- CloudFormation
- Secrets Manager
- Task definitions

These can exist under **Security Details / Advanced**, but they should not define the normal workflow.

---

# 7. Pricing

## Launch pricing

**Base platform fee**

**$49/month**

plus

**$19/month per active production deployment**

For the purposes of billing:

> **One deployment = one active production installation of one application for one customer AWS account.**

Examples:

| Usage                 | Monthly Price |
| --------------------- | ------------: |
| Base only             |           $49 |
| 1 customer deployment |           $68 |
| 3 deployments         |          $106 |
| 5 deployments         |          $144 |
| 10 deployments        |          $239 |
| 25 deployments        |          $524 |
| 50 deployments        |          $999 |

### Important billing rule

Updating the same customer from:

```text
v1.0 → v1.1 → v1.2
```

does **not** create three billable deployments.

It remains one $19/month deployment.

### Non-production environments

MVP supports a vendor-owned test deployment without charging an additional $19.

Customer staging/dev environments are outside MVP.

### No usage-based infrastructure charge

AWS infrastructure is paid directly by the customer's AWS account.

Deployz does not mark up:

- EC2/Fargate
- RDS
- S3
- Bandwidth
- CloudWatch
- AWS infrastructure

This should be an important sales message:

> **You pay Deployz for deployment management. Your customer pays AWS directly for their infrastructure.**

---

# 8. Product Principles

## 8.1 Opinionated beats flexible

Every additional infrastructure variation increases:

- failure modes
- support requirements
- testing surface
- security risk
- engineering complexity

Deployz should therefore prefer:

> "We don't support that configuration."

over:

> "We can probably make that work."

---

## 8.2 Deterministic infrastructure

AI can help understand applications and diagnose problems.

AI should **not** dynamically invent production infrastructure.

Provisioning should come from:

- versioned templates
- deterministic configuration
- tested infrastructure modules
- known IAM policies
- controlled deployment paths

---

## 8.3 Customer credentials never leave customer AWS

Deployz should never request:

- AWS access keys
- AWS secret keys
- Administrator credentials

Customer AWS operations should execute inside the customer's AWS account.

---

## 8.4 Zero professional services

Custom architecture should not quietly become part of customer support.

If a deployment requires custom infrastructure work, it is unsupported.

---

## 8.5 Application portability before deployment magic

Deployz cannot compensate for fundamentally non-portable applications.

The product should detect incompatibilities early and explain them clearly.

---

## 8.6 Infrastructure complexity stays invisible

The vendor should interact with business concepts:

- Application
- Customer
- Deployment
- Version
- Environment
- Health
- Release

Not AWS implementation details.

---

# 9. MVP Application Contract

An application is supported only when it meets the Deployz Application Contract.

## Compute

MVP supports:

- Linux containers
- x86-64
- One main web/API service
- Optional background worker
- HTTP/HTTPS applications
- Stateless application containers

The application must expose:

- listening port
- health endpoint
- startup command

---

## Database

Supported:

**PostgreSQL only**

Provisioned using Amazon RDS.

Not supported:

- MySQL
- MongoDB
- Elasticsearch/OpenSearch
- ClickHouse
- externally managed customer databases
- existing RDS instances

Additional services can be added later based on actual demand.

---

## Cache (Redis)

Supported:

**Standard standalone Redis-compatible usage** — caching, sessions, queues, background jobs, rate limiting, distributed locks, temporary application state.

When a repository requires Redis, Deployz detects it automatically and provisions a private single-node cache using Amazon ElastiCache (Valkey engine). The application's expected connection environment variables (for example `REDIS_URL`, `REDIS_HOST`/`REDIS_PORT`, `CELERY_BROKER_URL`) are injected automatically. The cache belongs to the deployment environment, is reused across redeployments, and is removed with the deployment.

No Redis configuration is exposed to the vendor or customer — no node sizes, versions, replicas, or tuning.

Not supported:

- Redis Cluster
- Redis Stack / RedisJSON / RediSearch / custom modules
- TLS-required Redis clients (`rediss://`)
- public Redis endpoints
- bring-your-own or existing Redis resources
- multiple Redis instances per environment

Applications requiring unsupported Redis features fail during analysis, before any infrastructure is created.

---

## File storage

Supported:

**Amazon S3**

Applications requiring persistent files should use S3.

Unsupported:

- persistent local filesystem
- shared network drives
- customer EFS
- custom NAS

---

## Configuration

Configuration is supplied using:

- environment variables
- AWS Secrets Manager

Secrets should never be stored as plaintext application configuration.

---

## Networking

MVP supports:

- Deployz-created networking
- public HTTPS application endpoints
- outbound internet access

MVP does not integrate with existing customer networks.

---

# 10. Explicitly Unsupported

The MVP must clearly reject:

- Kubernetes
- EKS
- Existing VPCs
- Existing databases
- Customer Terraform modules
- CloudFormation supplied by customer
- PrivateLink
- Direct Connect
- VPN integration
- Private-only applications
- Custom proxies
- Custom DNS architectures
- Customer-specific firewall architecture
- Multi-region deployment
- Active-active deployment
- Azure
- Google Cloud
- On-premise
- Air-gapped environments
- GPUs
- Windows containers
- Privileged containers
- Persistent local storage
- Arbitrary AWS services
- Customer-managed Kubernetes
- Highly customised IAM architectures
- AWS accounts whose SCPs block the standard Deployz stack

The application analyser should ideally detect many of these incompatibilities before a customer installation is created.

---

# 11. Standard Customer Architecture

Each customer gets an isolated AWS deployment.

Conceptually:

```text
Customer AWS Account

┌──────────────────────────────────┐
│                                  │
│   Application Load Balancer      │
│               │                  │
│               ▼                  │
│       ECS / Fargate              │
│         Web Service              │
│               │                  │
│       ┌───────┴────────┐         │
│       ▼                ▼         │
│   RDS PostgreSQL      S3         │
│                                  │
│   ElastiCache (Valkey, optional)  │
│   Secrets Manager                 │
│   CloudWatch                      │
│                                  │
│   Deployz Relay                   │
│        │                          │
└────────┼──────────────────────────┘
         │ HTTPS outbound only
         ▼
     Deployz Control Plane
```

Preferred compute abstraction:

**AWS ECS Express Mode / Fargate**

where practical.

Deployz should rely heavily on managed AWS services instead of operating infrastructure itself.

---

# 12. AWS Installation Model

## Customer installation flow

Vendor clicks:

**Add Customer**

and enters:

- Customer name
- Installation name
- AWS region
- Application version
- Required application secrets/configuration

Deployz generates a unique installation link.

Example:

```text
deployz.com/install/acme/7f83...
```

The vendor sends this link to the customer.

---

## Customer installation page

The page explains:

### What will be created

- Network
- ECS application
- Load balancer
- PostgreSQL database
- Redis cache (only when the application requires it)
- S3 storage
- Secrets
- Monitoring
- Deployz deployment relay

### What Deployz can do

- deploy application releases
- check deployment status
- perform health checks
- update application
- rollback application version
- manage Deployz-created resources

### What Deployz cannot do

- access unrelated AWS resources
- access AWS account credentials
- administer unrelated applications
- access customer application data directly
- modify infrastructure outside the Deployz stack

Customer clicks:

**Deploy to AWS**

---

# 13. AWS Bootstrap Architecture

Installation opens an AWS CloudFormation Quick Create flow.

Customer sees the template before approving it.

CloudFormation creates a small Deployz bootstrap stack containing:

- Deployz execution role
- tightly scoped IAM permissions
- Deployz relay
- installation identifier
- communication credentials
- application deployment stack

The bootstrap should be removable by the customer.

Deleting/revoking it should disconnect Deployz.

---

# 14. Deployz Relay

The long-term security architecture should avoid holding cross-account AWS credentials inside the Deployz control plane.

The MVP architecture should therefore use an **egress-only AWS-native relay**.

Possible implementation:

```text
EventBridge
     ↓
Deployz Lambda Relay
     ↓ HTTPS
Deployz Control Plane
     ↓
Desired operation
     ↓
Lambda / CloudFormation
     ↓
Customer resources
```

The relay periodically asks Deployz:

> "Is there anything this installation needs to do?"

Possible commands:

- deploy release
- update service
- run migration
- rollback release
- report health
- refresh metadata
- destroy application

The relay only executes a fixed vocabulary of Deployz operations.

It should **not** act as a generic remote shell.

---

# 15. Security Model

Security is a core product feature.

## Fundamental guarantees

### No permanent customer AWS credentials in Deployz

Deployz never stores:

- AWS secret keys
- root credentials
- customer administrator credentials

### Least privilege

The customer-side execution role can operate only the resources required by its Deployz deployment.

### Revocable

Customers can disable Deployz by deleting the bootstrap resources or disabling the relay.

### Egress-only communication

Deployz should not need inbound network access to the customer environment.

### Infrastructure isolation

Every customer installation should use predictable resource naming and tagging.

Example:

```text
deployz:installation=ins_123
deployz:application=app_456
deployz:vendor=org_789
```

---

# 16. Data Boundary

A major product promise should be:

> **Your application and customer data remain inside your AWS account.**

Customer-owned resources include:

- application runtime
- PostgreSQL data
- S3 data
- application secrets
- application CloudWatch logs

Deployz stores operational metadata such as:

- installation ID
- AWS account ID
- AWS region
- release version
- deployment state
- infrastructure status
- resource identifiers
- deployment timestamps
- health state
- structured AWS deployment errors

Deployz should avoid automatically copying raw application logs outside the customer account.

---

# 17. GitHub Integration

GitHub is the primary vendor onboarding path.

Vendor installs the Deployz GitHub App and selects a repository.

Deployz receives minimum necessary repository permissions.

Initial permissions should preferably be:

- repository metadata: read
- code: read
- pull requests: optional/later
- checks: optional/later

Deployz analyses the application.

---

# 18. Application Analysis

The analyser answers:

> **Can Deployz safely run this application using the Deployz Application Contract?**

It should detect:

- Dockerfile
- application framework
- listening port
- startup command
- health endpoint
- environment variables
- database usage
- PostgreSQL requirements
- Redis requirements (with confidence and purpose)
- local filesystem usage
- background worker
- S3/object storage usage
- external services
- migration commands
- unsupported infrastructure assumptions

---

# 19. Readiness Result

Example:

## Private Deployment Readiness

**82% — 2 changes required**

### Ready

✓ Docker container detected\
✓ PostgreSQL detected\
✓ Redis detected — will be managed automatically\
✓ Port 3000 detected\
✓ Stateless web service\
✓ Environment configuration detected

### Needs attention

**Health endpoint missing**

Deployz requires an HTTP health endpoint.

Suggested:

```text
GET /health
→ HTTP 200
```

**Local file storage detected**

Files written to:

```text
/uploads
```

will disappear when containers restart.

Move persistent uploads to S3.

### Unsupported

If Deployz detects something fundamental:

> **This application isn't currently compatible with Deployz.**

Reason:

> Redis Cluster mode is required.

It should not attempt clever infrastructure generation to work around the contract.

---

# 20. AI Strategy

AI is a product accelerator, not the infrastructure authority.

## MVP AI feature #1 — Repository understanding

AI helps explain:

- application architecture
- detected dependencies
- likely environment variables
- likely migration process
- portability issues

Deterministic checks make the final compatibility decision.

---

## MVP AI feature #2 — Failure diagnosis

When AWS returns failures such as:

```text
AccessDenied
ResourceLimitExceeded
Target failed health check
Container exited 1
Database connection timeout
Invalid secret
Port unavailable
```

Deployz gathers structured diagnostic information and produces:

**What happened**

**Why it probably happened**

**How to fix it**

Example:

> Deployment failed because your container listens on port 8080 while the Deployz application configuration specifies port 3000.

**Fix**

Change the configured application port to 8080 and retry.

---

## Not MVP

AI should initially **not**:

- generate arbitrary Terraform
- generate authoritative IAM policies
- autonomously redesign infrastructure
- rewrite major application architecture
- modify production databases
- automatically execute risky remediation
- make unrestricted code changes

---

# 21. Container Build Pipeline

For the first MVP, Deployz may operate the build pipeline itself to reduce configuration complexity.

Conceptually:

```text
GitHub
   ↓
Deployz Build
   ↓
Docker Image
   ↓
Deployz Private Registry
   ↓
Immutable image digest
   ↓
Customer ECS
```

Use immutable image identifiers rather than mutable tags such as `latest`.

Example:

```text
sha256:f693...
```

This ensures the exact same software artifact can be deployed consistently across customers.

### MVP trade-off

Container artifacts may reside in a Deployz-controlled private registry.

The **runtime and customer data** remain in the customer AWS account.

Customer-owned ECR replication can be considered later.

---

# 22. Release Management

The vendor has an application release list.

Example:

| Version | Status   |
| ------- | -------- |
| v1.4.2  | Current  |
| v1.4.1  | Previous |
| v1.4.0  | Previous |

Creating a release means:

1. Build image
2. Record immutable image digest
3. Run checks
4. Mark release available

The release does **not** automatically update every customer.

---

# 23. Customer Deployment Dashboard

Primary product dashboard:

## Customers

| Customer  | Version | Region     | Status            |
| --------- | ------- | ---------- | ----------------- |
| Acme Corp | 1.4.2   | us-east-1  | Healthy           |
| Beta Ltd  | 1.4.1   | eu-west-1  | Update available  |
| Gamma Inc | 1.4.2   | ap-south-1 | Deployment failed |
| Delta AI  | 1.3.8   | us-west-2  | Healthy           |

This fleet view is one of Deployz's primary recurring-value features.

---

# 24. Customer Detail Page

Example:

## Acme Corp

**Status:** Healthy

**Application:** Analytics API\
**AWS account:** 1234••••••\
**Region:** us-east-1\
**Version:** 1.4.2\
**Created:** 12 Aug 2026

### Infrastructure

Application — Healthy\
Database — Healthy\
Storage — Healthy\
Load Balancer — Healthy\
Deployz Relay — Connected

### Recent activity

```text
14:32 Version 1.4.2 deployed
14:29 Deployment started
09:14 Health check passed
Yesterday Version 1.4.1 deployed
```

Actions:

**Deploy Update**

**Rollback**

**View Diagnostics**

**Configuration**

**Disconnect Deployment**

---

# 25. Upgrade Workflow

Vendor selects customers and clicks:

**Deploy version 1.5**

Flow:

```text
Requested
    ↓
Preflight
    ↓
Migration
    ↓
ECS deployment
    ↓
Health observation
    ↓
Success
```

Vendor can deploy to:

- one customer
- selected customers
- all compatible customers

Mass deployment should still occur through controlled individual installation jobs.

---

# 26. Database Migrations

Database migrations are inherently risky and must have strict rules.

Vendor specifies a migration command.

Example:

```text
npm run migrate
```

Deployz runs it as a one-off task before completing the application deployment.

Migrations must be designed to be backward compatible.

Deployz does **not** promise automatic database schema rollback.

The UI should clearly state:

> Application rollback does not automatically reverse database migrations.

---

# 27. Rollback

If a release fails health checks:

Vendor clicks:

**Rollback to 1.4.1**

Deployz restores the previous known-good container revision.

Rollback covers:

- application image
- ECS task/service configuration
- Deployz-controlled release configuration

It does not automatically reverse database mutations.

---

# 28. Health Monitoring

Deployz should monitor at least:

- CloudFormation stack state
- ECS service state
- desired/running task count
- container exit state
- HTTP health checks
- load balancer target health
- RDS availability
- relay connectivity

Application-level observability is not an MVP goal.

Deployz is not Datadog.

---

# 29. Diagnostic Engine

Every deployment operation produces structured events.

Example:

```text
Deployment #dep_872

1. Build succeeded
2. Image published
3. Customer agent received release
4. CloudFormation update started
5. ECS task started
6. Health check failed
7. Container exited
8. Deployment failed
```

Deployz first applies deterministic diagnostic rules.

Example:

```text
if target_health == unhealthy
and container_running == true
and application_port != detected_port
→ PORT_MISMATCH
```

AI then converts this information into an understandable explanation.

This architecture is preferable to simply sending raw logs to an LLM.

---

# 30. Preflight Checks

Preventing failures is significantly cheaper than diagnosing them.

Before provisioning:

### AWS checks

- relay connected
- region supported
- required AWS APIs available
- account permission check
- quota check
- CloudFormation usable
- ECS usable
- RDS usable

### Application checks

- image available
- image architecture supported
- port defined
- health endpoint configured
- required secrets present
- migration command valid
- environment variables complete

Only after these pass should deployment begin.

---

# 31. Configuration Management

Configuration has two categories.

## Vendor defaults

Defined once per application.

Example:

```text
LOG_LEVEL=info
STORAGE_PROVIDER=s3
FEATURE_X=true
```

## Customer-specific configuration

Example:

```text
CUSTOMER_NAME=Acme
OPENAI_API_KEY=...
SMTP_PASSWORD=...
```

Sensitive configuration should be encrypted and stored in the customer AWS account whenever possible.

The Deployz UI should mask secrets after entry.

---

# 32. Supported AWS Regions

Do not support every AWS region simply because AWS technically allows it.

Maintain an explicit allowlist.

Initial regions should cover major commercial regions, for example:

- US East
- US West
- Europe
- India
- Singapore

The exact region list should be driven by infrastructure testing.

Every supported region must pass the same deployment test suite.

---

# 33. Core Product Objects

The primary data model should remain simple.

```text
Organization
   │
   ├── Users
   │
   └── Applications
          │
          ├── Releases
          │
          └── Deployments
                 │
                 ├── Customer
                 ├── AWS Installation
                 ├── Configuration
                 ├── Deployment Jobs
                 └── Events
```

---

# 34. Organization

Represents the SaaS vendor.

Fields:

```text
id
name
billing_customer_id
plan
created_at
```

---

# 35. Application

Represents one software product.

Fields:

```text
id
organization_id
name
github_repository
default_branch
container_port
health_path
migration_command
worker_command
database_required
storage_required
analysis_status
compatibility_status
created_at
```

---

# 36. Release

Represents an immutable application version.

Fields:

```text
id
application_id
version
git_commit_sha
image_digest
build_status
release_status
created_at
```

---

# 37. Customer

Represents the vendor's buyer.

Fields:

```text
id
organization_id
name
external_reference
created_at
```

Do not overbuild CRM functionality.

---

# 38. Deployment

Represents the billable unit.

Fields:

```text
id
application_id
customer_id
aws_account_id
aws_region
current_release_id
previous_release_id
status
relay_status
health_status
created_at
deleted_at
```

---

# 39. Deployment Job

Every operation is a job.

Types:

```text
INSTALL
DEPLOY_RELEASE
ROLLBACK
MIGRATION
CONFIG_UPDATE
DESTROY
PREFLIGHT
HEALTH_CHECK
```

States:

```text
QUEUED
RUNNING
WAITING
SUCCESS
FAILED
CANCELLED
```

All operations should be idempotent wherever possible.

---

# 40. Event Log

Every meaningful infrastructure action creates an immutable event.

Example:

```text
DEPLOYMENT_STARTED
PREFLIGHT_COMPLETED
DATABASE_READY
TASK_STARTED
HEALTH_CHECK_FAILED
ROLLBACK_STARTED
DEPLOYMENT_HEALTHY
```

This event history supports:

- debugging
- auditability
- AI diagnosis
- customer support
- future analytics

This dataset may eventually become one of Deployz's most valuable assets.

---

# 41. MVP Screens

The MVP should contain approximately these major product surfaces.

## Public

1. Landing page
2. Pricing
3. Sign up/login
4. Customer installation page
5. Security explanation

## Vendor application

6. Onboarding
7. Application list
8. Connect GitHub
9. Application readiness
10. Releases
11. Customers/deployments
12. Create customer deployment
13. Deployment detail
14. Deployment activity
15. Diagnostics
16. Application configuration
17. Billing
18. Organization settings

Avoid building broad administrative functionality until necessary.

---

# 42. Vendor Onboarding

Ideal onboarding:

### Step 1

**Connect GitHub**

### Step 2

**Choose repository**

### Step 3

Deployz analyses application.

### Step 4

**Fix compatibility issues**

### Step 5

**Create test deployment**

### Step 6

Application becomes:

> **Ready for customer deployment**

The onboarding success moment is not account creation.

It is:

> **"Your application can now be deployed into customer AWS accounts."**

---

# 43. Empty-State Product Experience

After onboarding:

# Your app is ready for private deployment

Give your next customer their own AWS deployment.

**Create Customer Deployment**

Secondary actions:

**View Test Deployment**

**Create Release**

This should reinforce the primary job of the product immediately.

---

# 44. Customer Installation UX

The customer's experience should require no Deployz account.

They receive a secure install URL.

Example flow:

```text
Acme Analytics wants to deploy
inside your AWS account.

Application
Analytics Cloud

Publisher
Acme Software

Deployz will create:
• Application runtime
• PostgreSQL database
• Redis cache
• Storage
• Networking
• Monitoring

Your data stays in your AWS account.

[Review AWS Deployment]
```

AWS authentication happens at AWS, not inside Deployz.

---

# 45. Customer Trust Page

Every install should have a **Security Details** section explaining:

- exact AWS resources created
- IAM policy
- why each permission exists
- data sent to Deployz
- data not sent to Deployz
- how to revoke Deployz
- how deletion works
- infrastructure diagram
- Deployz security architecture

Eventually this can become a reusable security document vendors send to customers.

---

# 46. Deployment States

Use simple product terminology.

Main states:

```text
Not Installed
Installing
Healthy
Updating
Update Available
Failed
Disconnected
Deleting
Deleted
```

Avoid exposing raw AWS lifecycle terminology as primary status.

---

# 47. Product Notifications

Essential notifications:

- installation completed
- installation failed
- update completed
- update failed
- deployment unhealthy
- relay disconnected
- rollback completed
- AWS permission issue

MVP channels:

- in-app
- email

Slack/webhooks can come later.

---

# 48. Billing Behaviour

Stripe or equivalent subscription billing.

Monthly charge:

```text
$49
+
$19 × active production deployments
```

Deployment becomes billable when installation reaches:

**Healthy**

Deleting an installation removes it from future billing.

Temporary failed updates do not affect billing.

Creating multiple releases does not affect billing.

The billing screen should clearly show:

```text
Platform                 $49
Acme Corp                 $19
Beta Ltd                  $19
Gamma Inc                 $19
-----------------------------
Monthly total            $106
```

No complicated credits or infrastructure metering in MVP.

---

# 49. Support Philosophy

The product cannot economically provide unlimited DevOps consulting at this price.

Support covers:

- Deployz product issues
- Deployz-created AWS infrastructure
- supported deployment failures
- supported application-contract questions

Support does not cover:

- custom AWS architecture
- application debugging unrelated to deployment
- customer network design
- custom IAM requests
- custom databases
- Kubernetes
- general AWS consulting

The support team should be empowered to answer:

> "This configuration isn't currently supported."

---

# 50. Operational Economics Principle

At $19 per deployment, human intervention must be extremely rare.

Therefore product priorities should favour:

1. preventing deployment failures
2. automatically classifying failures
3. providing deterministic fixes
4. improving installation repeatability
5. reducing supported configurations

over adding more architectural flexibility.

A useful internal north-star metric is:

> **Human support minutes per active deployment per month**

This matters more than the number of infrastructure features supported.

---

# 51. Core Metrics

## Activation

**Application Deployment Ready Rate**

Percentage of connected repositories that reach Deployz-ready status.

---

## Customer deployment

**Successful First Installation Rate**

Percentage of customer installations completing without human intervention.

Target direction:

**>90% for applications marked Deployz-ready**

---

## Time to value

**Customer Installation Time**

Measured from CloudFormation approval to Healthy.

---

## Reliability

**Deployment Success Rate**

Percentage of application updates reaching Healthy without intervention.

---

## Operations

**Human Support Minutes / Deployment / Month**

This is one of the most important business metrics.

Long-term goal:

**<3 minutes**

---

## Product engagement

Track:

- active vendors
- active deployments
- releases/month
- deployments updated/month
- average deployments/vendor
- deployment failure rate
- rollback rate
- disconnected installations

---

## Revenue

Track:

- MRR
- average deployments/vendor
- ARPU
- deployment expansion MRR
- gross margin/vendor
- infrastructure cost/deployment
- AI cost/deployment
- support cost/deployment

---

# 52. MVP Feature Priority

## P0 — Must exist for launch

### Vendor

- Authentication
- Organization
- GitHub connection
- Repository selection
- Application creation
- Application analysis
- Compatibility result
- Application configuration
- Build container
- Releases
- Customer creation
- Generate installation link
- Fleet dashboard
- Deployment detail
- Deploy release
- Basic rollback
- Deployment history
- Billing

### Customer AWS

- CloudFormation bootstrap
- Deployz relay
- Standard network
- ECS/Fargate deployment
- Load balancer
- RDS PostgreSQL
- ElastiCache Valkey (when Redis is required)
- S3
- Secrets Manager
- CloudWatch
- Health reporting
- Resource deletion

### Intelligence

- Repository analysis
- deterministic compatibility rules
- AWS preflight checks
- deterministic failure classifier
- AI-readable error explanation

---

# 53. P1 — Build After Core Reliability

- Automated fix PRs
- Release approval policies
- Scheduled releases
- richer audit logs
- deployment batches
- vendor webhooks
- Slack notifications
- richer security reports
- custom domains
- vendor-branded installation pages
- customer-owned ECR
- better migration controls
- backup management
- enhanced diagnostic bundles
- team members and roles

---

# 54. P2 — Expansion

Potential future extensions:

- MySQL
- multiple workers
- scheduled jobs
- custom domains/DNS automation
- private networking profile
- existing VPC support
- AWS Marketplace integration
- Azure
- GCP
- compliance automation
- customer policy scanning
- deployment cost optimisation
- SSO
- enterprise audit features

Every P2 feature should be added as a **standard profile**, not arbitrary custom infrastructure whenever possible.

---

# 55. What Should Never Become the Product

Avoid drifting into:

### Generic cloud platform

> Deploy anything to AWS.

No.

### Infrastructure builder

> Design your architecture visually.

No.

### AI Terraform generator

> Tell our AI what infrastructure you want.

No.

### Kubernetes abstraction

> Easy Kubernetes for everyone.

No.

### Managed DevOps agency

> Our engineers will configure your customer's environment.

No.

The wedge remains:

> **Deploy your SaaS into customer-owned AWS.**

---

# 56. Product Differentiation

## Versus DIY + Claude/Codex

DIY solves:

**"How do I deploy this once?"**

Deployz solves:

**"How do I productise and operate this deployment model across customers forever?"**

Deployz provides:

- customer installer
- repeatable architecture
- permissions
- fleet state
- releases
- upgrades
- rollbacks
- health
- diagnostics
- audit history
- billing model
- lifecycle management

---

## Versus Distr

Deployz should be substantially easier for the narrow AWS-native use case.

Desired contrast:

```text
Distr
Self-hosted software distribution platform
Docker + Kubernetes + agents + licensing + registry

Deployz
Connect GitHub
→ Ready
→ Deploy to Customer AWS
```

If Deployz becomes equally configurable, the differentiation disappears.

---

## Versus Nuon

Nuon supports significantly more sophisticated BYOC deployments.

Deployz deliberately chooses:

> **10% of the flexibility for 10× simpler adoption.**

Deployz targets the SaaS vendor that thinks Nuon is more infrastructure platform than they need.

---

# 57. Moat Strategy

The initial product has little structural moat.

The company should build defensibility through accumulated operational knowledge.

Potential proprietary dataset:

```text
Repository characteristics
      +
Application architecture
      +
AWS configuration
      +
Deployment outcome
      +
Failure signature
      +
Successful remediation
```

Over time Deployz can learn:

> "Applications with pattern X frequently fail because of Y, and fix Z works."

This can improve:

- compatibility detection
- preflight checks
- automated remediation
- deployment reliability
- support automation

The moat is therefore not the LLM.

The moat can become:

> **The deployment compatibility and failure-resolution graph for customer-cloud software.**

---

# 58. Control Plane Architecture

High-level:

```text
                    ┌──────────────────┐
                    │     GitHub       │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ Deployz Control  │
                    │      Plane       │
                    └───┬────┬────┬───┘
                        │    │    │
             ┌──────────┘    │    └──────────┐
             ▼               ▼               ▼
        PostgreSQL       Job Queue       Build System
             │                                │
             │                                ▼
             │                          Image Registry
             │
             ▼
     Deployment State
             │
             ▼
      Command Service
             │
        HTTPS outbound
             ▲
             │
     ┌───────┴────────┐
     │ Customer Relay │
     └───────┬────────┘
             │
             ▼
        Customer AWS
```

The control plane owns **desired state**.

The customer relay performs customer-AWS operations and returns **observed state**.

---

# 59. Desired-State Model

This is an important architectural principle.

Deployz records:

```text
Desired version: 1.5.0
Desired configuration: abc123
Desired infrastructure profile: deployz-v1
```

Customer relay reports:

```text
Running version: 1.4.2
Observed configuration: xyz789
Infrastructure health: healthy
```

Deployz reconciles differences through explicit deployment jobs.

This avoids making deployment workflows a collection of ad-hoc scripts.

---

# 60. Infrastructure Versioning

Infrastructure itself must have versions.

Example:

```text
deployz-runtime-v1
deployz-runtime-v2
```

Every installation records its infrastructure version.

Infrastructure changes must go through the same controlled lifecycle as application updates.

Never silently mutate infrastructure templates.

---

# 61. Internal Failure Taxonomy

Create stable failure codes from day one.

Examples:

```text
AWS_PERMISSION_DENIED
AWS_SCP_BLOCKED
AWS_QUOTA_EXCEEDED
STACK_CREATE_FAILED
DATABASE_CREATE_FAILED
DATABASE_CONNECTION_FAILED
IMAGE_PULL_FAILED
CONTAINER_START_FAILED
HEALTH_CHECK_FAILED
PORT_MISMATCH
MISSING_SECRET
MIGRATION_FAILED
RELAY_DISCONNECTED
UNSUPPORTED_ARCHITECTURE
UNKNOWN
```

Every failure should ideally resolve to one of these codes before AI sees it.

This creates structured data for future automation.

---

# 62. Auditability

Every infrastructure-changing action should record:

- who initiated it
- when
- affected customer
- previous state
- requested state
- release
- job ID
- result

Example:

```text
Tejas
deployed
version 1.5.0
to Acme Corp
18 Aug 2026 14:32
SUCCESS
```

This becomes increasingly important as vendors sell to larger customers.

---

# 63. Deletion

Deletion must be a first-class operation.

Vendor initiates:

**Remove deployment**

Customer confirmation may be required depending on security model.

Deployz should attempt to remove only Deployz-created resources.

Deletion flow should clearly distinguish:

- application deletion
- database deletion
- retained backups
- S3 data
- Deployz metadata

Destructive actions should never be hidden behind ambiguous UI.

---

# 64. Backup Philosophy

Deployz should configure AWS-native backups rather than creating its own backup engine.

For PostgreSQL:

- automated RDS backups
- retention policy
- optional final snapshot on deletion

For S3:

- native durability
- optional versioning later

Deployz should monitor whether backup configuration is healthy.

Deployz does not guarantee application-semantic backup correctness.

---

# 65. Product Copy Principles

Avoid technical jargon wherever possible.

Instead of:

> CloudFormation stack UPDATE_COMPLETE

say:

> Deployment updated successfully.

Instead of:

> ECS desired count is 0.

say:

> Your application isn't currently running.

Instead of:

> TargetGroup health check failure.

say:

> AWS can start your application, but it isn't responding to its health check.

Technical details remain expandable underneath.

---

# 66. MVP Build Sequence

## Phase A — Foundation

Build:

- authentication
- organization
- application model
- customer model
- deployment model
- release model
- event/job model
- billing foundation

---

## Phase B — One Golden Deployment Path

Ignore GitHub intelligence initially if necessary and prove:

```text
Known Docker image
     ↓
Customer installation link
     ↓
CloudFormation bootstrap
     ↓
Deployz relay
     ↓
ECS + RDS
     ↓
Healthy application
```

One deployment path must become extremely reliable before additional flexibility is introduced.

---

## Phase C — Lifecycle

Add:

- releases
- version updates
- fleet state
- health checks
- rollback
- configuration updates
- migrations

This converts Deployz from an installer into a recurring control plane.

---

## Phase D — Application Intelligence

Add:

- GitHub App
- repository analysis
- compatibility rules
- readiness page
- AI explanation

---

## Phase E — Self-Healing Support Layer

Add:

- structured failure taxonomy
- preflight engine
- automated diagnostics
- AI explanations
- remediation guidance

The goal is eliminating human support before expanding architecture coverage.

---

# 67. MVP Definition of Done

The MVP is ready for real paid customers when the following complete end-to-end scenario works reliably:

### Vendor

1. Creates Deployz account.
2. Connects GitHub.
3. Selects repository.
4. Receives application compatibility result.
5. Configures required environment variables.
6. Creates first release.
7. Creates customer.
8. Sends customer AWS installation link.

### Customer

9. Opens link.
10. Reviews security/infrastructure details.
11. Opens AWS CloudFormation.
12. Approves installation.
13. Deployz automatically provisions environment.
14. Application becomes Healthy.

### Vendor lifecycle

15. Vendor publishes second release.
16. Deploys update to customer.
17. Deployz verifies health.
18. Customer becomes Healthy on new version.
19. Vendor sees complete deployment history.
20. Vendor can roll back application release.
21. Failed deployment produces useful diagnosis.
22. Deployment can be removed cleanly.

### Commercial

23. Vendor is charged $49/month.
24. Healthy customer installation adds $19/month.
25. Removing deployment stops future $19 charges.

If any of these workflows requires routine manual AWS intervention, the MVP is not complete.

---

# 68. Quality Bar

Deployz is infrastructure software.

Its acceptable quality bar differs from a conventional SaaS MVP.

The UI can initially be minimal.

Infrastructure reliability cannot.

Prefer:

```text
5 capabilities
99% reliable
```

over:

```text
25 capabilities
80% reliable
```

The first version can look simple.

It cannot unpredictably create, modify, or destroy customer infrastructure.

---

# 69. Primary Product Risk

The largest product risk remains **customisation leakage**.

The dangerous progression is:

```text
Deploy to my AWS
      ↓
Use our VPC
      ↓
Use our database
      ↓
Use our KMS key
      ↓
Use our proxy
      ↓
Use our SIEM
      ↓
Use our IAM conventions
      ↓
Use our Terraform
```

At that point the economics and product model break.

Deployz must make unsupported requirements visible before installation and resist converting them into one-off exceptions.

---

# 70. Decision Framework for New Features

Every requested infrastructure feature should answer four questions.

### 1. How common is it?

Does it apply to many deployments?

### 2. Can it be standardised?

Can Deployz support one deterministic implementation?

### 3. What new failure modes does it introduce?

Does it materially increase support burden?

### 4. Does it improve revenue enough?

Would the feature create enough deployments or higher pricing to justify the complexity?

If the answer is unclear:

**do not add it.**

---

# 71. North-Star Product Vision

The initial product:

> **Deploy SaaS into customer AWS.**

The broader opportunity:

> **Become the deployment layer through which software vendors distribute and operate software inside customer-controlled infrastructure.**

Possible evolution:

```text
Repo compatibility
       ↓
AWS deployments
       ↓
Fleet lifecycle
       ↓
Deployment intelligence
       ↓
Compliance & policy
       ↓
Multiple standard cloud profiles
       ↓
Automatic portability remediation
       ↓
Software distribution infrastructure
```

The company should earn the right to move down this stack.

---

# 72. Final Product Definition

Deployz should launch as:

> **A simple AWS private-deployment platform for small SaaS vendors. Connect your application, create a customer, and send them a Deploy to AWS link. Deployz provisions a standard ECS/Fargate + PostgreSQL environment inside their AWS account and then manages releases, upgrades, rollbacks, health and diagnostics across every customer deployment.**

### Business model

**$49/month + $19/month per active customer deployment.**

### MVP technical constraint

One opinionated AWS architecture.

### MVP application constraint

One containerised web/API application, optional worker, PostgreSQL, S3, and an optional managed Redis cache.

### Primary UX promise

**GitHub → Customer → Deploy to AWS → Healthy.**

### Primary security promise

**Customer infrastructure and data stay in customer AWS; Deployz never needs permanent customer AWS credentials.**

### Primary competitive advantage

**Dramatically simpler than general BYOC/self-hosting platforms.**

### Primary operational objective

**Make successful private deployment boring, repeatable and almost entirely automatic.**

### Rule that protects the company

> **When flexibility conflicts with reliability and simplicity, choose reliability and simplicity.**
