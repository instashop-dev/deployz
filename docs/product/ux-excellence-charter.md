# Deployz UX Excellence — Master Charter

## Mission

Make Deployz dramatically simpler, more intuitive, consistent, trustworthy and polished for vendors and customers while preserving underlying product semantics.

Deployz may be technically sophisticated underneath. The normal UX should make that complexity feel simple.

Optimize complete user journeys, not isolated pages.

Target:

SIMPLE → OBVIOUS → CONSISTENT → TRUSTWORTHY → FAST-FEELING → RECOVERABLE

## Simplification rule

For every component, section, field, card, tab, button and piece of information:

REMOVE
→ COMBINE
→ PRIORITIZE
→ PROGRESSIVELY DISCLOSE
→ STANDARDIZE
→ POLISH

Do not standardize unnecessary complexity.

A normal screen should immediately answer:

1. Where am I?
2. What is the current state?
3. Is anything required from me?
4. What should I do next?

Prefer one dominant next action per state.

## Vendor mental model

Connect repository
→ Deployz understands application
→ Fix anything required
→ Create release
→ Give it to customers
→ Monitor deployments

## Customer mental model

Open install link
→ Understand what will be installed
→ Connect AWS
→ Provide required choices/configuration
→ Review resources / region / approximate cost / access
→ Deploy
→ Understand progress
→ Application ready

Technical details remain available but should not dominate normal workflows.

## Design around states

Evaluate happy, loading, empty, action-required, failure, retry, success, destructive and returning-user states.

Every recoverable error should communicate:

What happened
→ impact
→ recommended action
→ recovery action
→ optional technical details

Every long operation should communicate:

Completed work
→ current activity
→ evidence of progress
→ what comes next
→ whether user action is required

## Progressive disclosure

Use product language by default.

AWS/internal implementation details should normally be secondary or under Technical details.

Never expose ApplicationGraph or DeployzIR in normal UX.

Do not remove technical information that users genuinely need.

## Lightweight UI system

Standardize only patterns Deployz actually uses.

Avoid creating a large generic design-system project or unnecessary abstractions.

## Browser-first

Use the actual running application wherever practical in addition to source inspection.

Review complete vendor and customer journeys.

## Backend boundary

The UX program must not casually change:

- API contracts
- database schema
- ApplicationGraph
- DeployzIR
- detection/evidence semantics
- capability resolution
- planner/compiler semantics
- relay behavior
- IAM
- AWS infrastructure behavior
- lifecycle/state semantics
- deployment readiness/verification truth

Frontend code must never invent backend truth.

If UX requires backend work, record:

```
UX-BACKEND-XXX
Problem
User impact
Evidence
Why frontend cannot safely solve it
Required backend capability
Recommended minimal change
Priority
```

Do not implement the backend change as part of this UX workstream unless separately approved.

## Parallel AWS qualification

Another workstream is currently running Phase 5 real-AWS qualification / Gate D.

UX work must remain isolated.

Do not merge/deploy substantial UX changes underneath the active qualification.

## Agent model

Claude Opus is master orchestrator and owns:

- product model
- information architecture
- simplification
- terminology
- status semantics
- action hierarchy
- delegation
- integration
- final review

Use Claude Sonnet subagents for bounded:

- browser/repository investigation
- vendor/customer journey analysis
- component inventory
- implementation
- tests
- accessibility
- responsive review
- verification

Use approximately 2–3 Sonnet agents concurrently where useful.

Opus must critically review their work rather than simply combining reports.

## Persistent UX source of truth

Maintain:

docs/product/ux-guidelines.md

It contains accepted/proposed Deployz UX decisions.

The charter defines HOW the UX program works.

The guidelines define WHAT Deployz UX should be.

Current code/product specifications remain authoritative for actual product behavior.

## Execution discipline

Execute only the explicitly requested UX phase.

Stop at every phase gate.

Do not autonomously continue into the next phase.

Do not start Phase 6 as part of this program.
