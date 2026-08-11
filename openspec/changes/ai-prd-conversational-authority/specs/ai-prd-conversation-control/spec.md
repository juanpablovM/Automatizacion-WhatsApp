# AI PRD Conversation Control Specification

## Purpose

Govern AI dialogue through executable PRD policy. Preserve B06; exclude U7/U8.

## Requirements

### Requirement: Single Normal Conversational Voice

The AI **MUST** author customer replies. The system **MUST** deliver validated copy unchanged. Static text **MAY** appear only as contingency.

#### Scenario: Valid AI reply is delivered unchanged

- GIVEN an AI proposal satisfies the contract
- WHEN policy authorizes the turn
- THEN its `reply_text` is sent unchanged

### Requirement: Executable Per-Turn PRD Contract

Each proposal **MUST** receive an immutable contract containing accepted evidence, unresolved fields, pending objective, catalog grounding, allowed actions, forbidden claims, and effect permissions.

#### Scenario: Contract constrains the current turn

- GIVEN product and commune are accepted but quantity is missing
- WHEN the turn contract is produced
- THEN quantity is pending and accepted fields cannot be re-requested
- AND unauthorized PRD claims are forbidden

### Requirement: Evidenced Commercial Understanding

Product and modality proposals **MUST** have client evidence. Products **MUST** resolve to an active catalog entry or audited alias; modality synonyms **MUST** use an audited mapping. Service **MUST NOT** satisfy product.

#### Scenario: Catalog aliases progress qualification

- GIVEN the client writes “Baldosa MINVU” or “MINVU 0”
- WHEN evidence matches one active-catalog alias
- THEN product is accepted and is no longer pending

#### Scenario: Modality synonym progresses qualification

- GIVEN the client writes “Suministro”
- WHEN an audited synonym maps it to material-only modality
- THEN modality is accepted and audited

#### Scenario: Ambiguous evidence is clarified

- GIVEN evidence matches multiple products or modalities
- WHEN no value is grounded unambiguously
- THEN nothing is persisted and the AI asks a contextual clarification

### Requirement: Deterministic State and Effect Authorization

Only deterministic policy **MAY** persist facts or execute effects. It **MUST** reject unevidenced fields and effects lacking prerequisites or permission.

#### Scenario: Authorized effect executes

- GIVEN a valid proposal requests a permitted effect with all prerequisites
- WHEN authorization completes
- THEN valid fields persist and the effect executes once

#### Scenario: Premature lead is denied

- GIVEN required fields or confirmation are missing
- WHEN the AI proposes lead creation
- THEN no lead is created and commercial state does not advance

### Requirement: One Repair and Fail-Safe Handoff

An invalid proposal **MUST** receive exactly one repair with the unchanged contract and machine-readable errors. A second failure or provider outage **MUST** send brief contingency, create durable handoff immediately, and **MUST NOT** advance commercial state.

#### Scenario: First invalid proposal is repaired

- GIVEN the initial proposal violates a PRD rule
- WHEN validation rejects it
- THEN one repair uses the unchanged contract and errors
- AND a valid repair proceeds normally

#### Scenario: Repair also fails

- GIVEN the single repair is invalid
- WHEN validation rejects it
- THEN no further AI attempt occurs
- AND contingency and durable handoff occur without state advancement

#### Scenario: Provider is unavailable

- GIVEN the AI provider times out or returns invalid output
- WHEN no valid initial proposal exists
- THEN contingency and durable handoff occur immediately
- AND commercial state remains unchanged

### Requirement: Objective-Based Anti-Loop

The system **MUST** detect no-progress repetition by `pending_question_key`, regardless of wording. At threshold it **MUST** require AI clarification or handoff, not another generic question.

#### Scenario: Reworded repeated objective is detected

- GIVEN turns retain `pending_question_key=product` without progress
- WHEN differently worded replies reach the repetition threshold
- THEN the no-progress policy activates
- AND the next action is clarification or handoff

### Requirement: Legacy Conversation Compatibility

Legacy conversations **MUST** resume safely, preserve accepted facts, and **MUST NOT** trigger effects because metadata is absent.

#### Scenario: Legacy conversation resumes safely

- GIVEN a legacy conversation has `current_step` and facts
- WHEN its next message is processed
- THEN a compatible contract preserves those facts
- AND missing metadata alone authorizes no lead or handoff
