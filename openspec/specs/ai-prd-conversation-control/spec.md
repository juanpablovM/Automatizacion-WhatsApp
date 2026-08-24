# AI PRD Conversation Control Specification

## Purpose

Control safely.

## Requirements

### Requirement: Single Semantic Authority

The AI **MUST** interpret messages and author replies. Valid `reply_text` **MUST** ship unchanged. Code **MUST NOT** replace accepted meaning; static copy **MAY** serve contingencies.

#### Scenario: Understanding is preserved

- GIVEN an evidenced proposal satisfies policy
- WHEN the turn is authorized
- THEN its meaning drives progress and its reply ships unchanged

### Requirement: Extensible Semantic Envelope

Proposals **MUST** contain versioned `observations[]`, action, mappings, and effects. Observations **MAY** exceed persistence; mappings **MUST** reference accepted observations and allowlisted fields.

#### Scenario: Colloquial amount answers

- GIVEN quantity is pending and the client writes `6 ml`
- WHEN the AI evidences six linear meters
- THEN it answers the objective and may map without extraction

#### Scenario: Unknown concept remains

- GIVEN an observation has no allowlisted target
- WHEN the AI uses it in valid dialogue
- THEN it may guide dialogue but authorizes no state or effect

### Requirement: Executable Turn Policy

Proposals **MUST** receive immutable policy containing facts, objectives, grounding, allowed fields/actions, explicit turn-scoped `concept -> field` mappings, forbidden claims, and effect permissions. Accepted facts **MUST NOT** appear as executable patch targets. Deterministic claim guards **MUST** inspect generated reply output only and **MUST NOT** reinterpret the customer's message.

#### Scenario: Policy constrains turns

- GIVEN product and commune are accepted but amount is unresolved
- WHEN policy is compiled
- THEN facts stay accepted and unauthorized concept-to-field mappings, generated claims, and effects are forbidden

### Requirement: Evidenced Commercial Grounding

Observations **MUST** cite current-message evidence. Products **MUST** resolve to active items or aliases; modality synonyms **MUST** be audited. Service **MUST NOT** satisfy product. Ambiguity **MUST** persist nothing.

#### Scenario: Facts progress together

- GIVEN one message evidences product, amount, modality, and commune
- WHEN the AI proposes separate observations
- THEN valid mappings progress together

#### Scenario: Ambiguity is clarified

- GIVEN evidence supports multiple meanings
- WHEN grounding cannot select safely
- THEN nothing ambiguous persists and the AI clarifies

### Requirement: Deterministic Authorization

Policy **MAY** persist mappings or execute effects. It **MUST** validate references, exact concept-to-field targets, accepted-fact immutability, prerequisites, permissions, and idempotency without competing interpretation.

#### Scenario: Effect executes once

- GIVEN an effect has evidence, permission, and prerequisites
- WHEN authorization completes
- THEN accepted mappings persist and the effect executes once

#### Scenario: Premature lead denied

- GIVEN required facts or confirmation are missing
- WHEN the AI requests lead creation
- THEN no lead is created and state does not advance

### Requirement: One Repair and Fail-Safe Handoff

An invalid proposal **MUST** receive one repair with unchanged policy and machine errors. A second failure or outage **MUST** create contingency and durable handoff while preserving pre-turn state.

#### Scenario: First failure repaired

- GIVEN the initial proposal violates policy
- WHEN validation rejects it
- THEN one repair receives the same policy and a valid repair proceeds

#### Scenario: Repair fails

- GIVEN the repair is invalid
- WHEN validation rejects it
- THEN attempts stop and one handoff occurs without state advancement

#### Scenario: Provider unavailable

- GIVEN provider failure leaves no valid proposal
- WHEN the turn cannot proceed
- THEN contingency and one handoff occur while state remains unchanged

### Requirement: Objective-Based Anti-Loop

The system **MUST** count no-progress turns by objective. Count two **MUST** allow only contextual clarification; count three **MUST** require handoff.

#### Scenario: Repetition detected

- GIVEN an objective remains unresolved
- WHEN different wording reaches counts two and three
- THEN clarification occurs at two and handoff at three

### Requirement: Shadow and Legacy Compatibility

Shadow **MUST** audit v2 without v2 effects. Legacy turns **MUST** preserve facts; missing metadata **MUST NOT** authorize effects. Enforce **MUST** roll back without database migration.

#### Scenario: Shadow has no effects

- GIVEN shadow mode is active
- WHEN legacy and v2 differ
- THEN divergence is audited and only legacy produces effects

#### Scenario: Legacy resumes safely

- GIVEN legacy facts exist without v2 metadata
- WHEN the next turn starts
- THEN facts persist and absent metadata authorizes no effect
