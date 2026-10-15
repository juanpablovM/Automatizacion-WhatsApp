-- Claims the next turn of every settled contact queue (migration 034). After
-- the stale/batch/attempt knobs come the debounce window, the max wait and an
-- optional event id that scopes the claim to that event's queue (the entry
-- webhook's debounce waiter).
SELECT *
FROM recover_and_claim_inbound_events(
  $1::integer, $2::integer, $3::integer, $4::integer, $5::integer, NULLIF($6::text, '')::bigint
);
