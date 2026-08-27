# Monitor Active Conversations — Specification

## Purpose

Define the observable behavior of the `monitor-active-conversations.sql` operational query. This query is a read-only monitoring tool for operators; it does not modify data or change system behavior.

## Requirements

### Requirement: Scope — all non-closed conversations

The query MUST return every conversation whose `conversation_statuses.code` is not `closed`, excluding soft-deleted rows (`conversations.deleted_at IS NULL`).

#### Scenario: Excludes closed conversations

- GIVEN a conversation with `conversation_statuses.code = 'closed'`
- WHEN the query executes
- THEN that conversation MUST NOT appear in any result section

#### Scenario: Includes all active statuses

- GIVEN conversations with statuses `active`, `waiting_user`, `out_of_flow`, `handed_to_sales`, `inactive_timeout`, and `error`
- WHEN the query executes
- THEN every such conversation MUST appear in exactly one result section

### Requirement: Idle time calculation

The query MUST compute idle time as the difference between `NOW()` and `conversations.last_message_at`, expressed in hours with one decimal place.

#### Scenario: Idle time is positive and correct

- GIVEN a conversation with `last_message_at = NOW() - INTERVAL '2 hours'`
- WHEN the query executes
- THEN the idle time for that conversation MUST be `2.0` hours

#### Scenario: Recently active conversation

- GIVEN a conversation with `last_message_at = NOW() - INTERVAL '5 minutes'`
- WHEN the query executes
- THEN the idle time MUST be less than `0.2` hours

### Requirement: Multi-section output

The query SHOULD organize results into separate sections using CTEs, ordered by descending idle time (oldest first).

#### Scenario: Active/waiting conversations section

- GIVEN conversations with status `active` or `waiting_user`
- WHEN the query executes
- THEN those conversations MUST appear in a section ordered by idle time descending

#### Scenario: Handed-to-sales section

- GIVEN conversations with status `handed_to_sales`
- WHEN the query executes
- THEN those conversations MUST appear in a separate section ordered by idle time descending

#### Scenario: Inactive/error conversations section

- GIVEN conversations with status `inactive_timeout` or `error`
- WHEN the query executes
- THEN those conversations MUST appear in a separate section ordered by idle time descending

### Requirement: Lead and seller context

The query SHOULD join `leads` and `sellers` to display lead service, city, requirement, lead status, and assigned seller name when available.

#### Scenario: Conversation with lead and seller

- GIVEN a conversation linked to a lead, which is assigned to a seller
- WHEN the query executes
- THEN the result MUST show the lead's `service`, `city`, and `requirement`, the lead status label, and the seller name

#### Scenario: Conversation without lead

- GIVEN a conversation with `lead_id IS NULL`
- WHEN the query executes
- THEN the lead-related columns MUST display `NULL` or an empty indicator

### Requirement: Executable via docker compose

The query header MUST document the CLI invocation using `docker compose exec postgres psql`.

#### Scenario: Header documents usage

- GIVEN the query file
- WHEN inspected
- THEN the header comment MUST contain a `docker compose` CLI example
